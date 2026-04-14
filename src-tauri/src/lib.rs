mod cache;
mod commands;
mod config;
mod overlay;
mod plugins;
mod storage;
mod timer;
mod tray;

use std::sync::Mutex;
use std::time::Duration;

use cache::CacheState;
use commands::{AppStateStore, ConfigState, EngineState, PluginRegistry};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use timer::{TimerState, TimerStatus};

fn tick_once(app: &AppHandle) {
    let engine = app.state::<EngineState>();
    let mut state = match engine.0.lock() {
        Ok(s) => s,
        Err(_) => return,
    };
    if state.status != TimerStatus::Running {
        return;
    }

    state.elapsed_sec += 1;

    let mut interval_ended = false;
    let mut ended_type = String::new();
    let mut ended_duration: u64 = 0;

    let (interval_elapsed, interval_remaining) = if let Some(ci) = state.current_interval.as_mut() {
        ci.elapsed_sec += 1;
        let remaining = ci.target_sec.map(|t| t.saturating_sub(ci.elapsed_sec));
        if let Some(t) = ci.target_sec {
            if ci.elapsed_sec >= t && !ci.ended_emitted {
                ci.ended_emitted = true;
                interval_ended = true;
                ended_type = ci.interval_type.clone();
                ended_duration = ci.elapsed_sec;
            }
        }
        (ci.elapsed_sec, remaining)
    } else {
        (0u64, None::<u64>)
    };

    app.emit(
        "session:tick",
        serde_json::json!({
            "elapsed_sec": state.elapsed_sec,
            "interval_elapsed": interval_elapsed,
            "interval_remaining": interval_remaining,
        }),
    )
    .ok();

    if interval_ended {
        app.emit(
            "interval:end",
            serde_json::json!({
                "type": ended_type,
                "duration_sec": ended_duration,
            }),
        )
        .ok();
    }

    if state.elapsed_sec % 10 == 0 {
        if let Err(e) = storage::write_recovery(&state) {
            eprintln!("[flint] recovery write failed: {}", e);
        }
    }

    drop(state);
    tray::update_tooltip(app);
}

fn build_initial_state() -> (TimerState, bool) {
    let mut state = TimerState::idle();
    let Some(rec) = storage::load_recovery() else {
        return (state, false);
    };

    let status = match rec.status.as_str() {
        "paused" => TimerStatus::Paused,
        _ => TimerStatus::Running,
    };

    // If the session was running when the app closed, advance the clock by the
    // wall-clock time that has passed since the recovery file was last updated.
    // A paused session keeps its stored elapsed_sec exactly.
    let extra_sec: u64 = if status == TimerStatus::Running {
        let now = chrono::Utc::now();
        let since_start = (now - rec.started_at).num_seconds().max(0) as u64;
        since_start.saturating_sub(rec.elapsed_sec)
    } else {
        0
    };

    state.session_id = Some(rec.session_id);
    state.started_at = Some(rec.started_at);
    state.elapsed_sec = rec.elapsed_sec + extra_sec;
    state.mode = rec.mode;
    state.status = status;
    state.tags = rec.tags;
    state.questions_done = rec.questions_done;
    state.completed_intervals = rec.intervals;
    state.current_interval = rec.current_interval.map(|mut ci| {
        ci.elapsed_sec += extra_sec;
        ci
    });
    state.recovery_pending = true;
    (state, true)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let flint_dir = match storage::flint_dir() {
        Ok(p) => {
            println!("[flint] data directory ready at {}", p.display());
            p
        }
        Err(e) => {
            eprintln!("[flint] {}", e);
            return;
        }
    };

    let cfg = config::load_or_create(&flint_dir);
    let (initial_state, restored) = build_initial_state();
    if restored {
        println!(
            "[flint] recovered session {:?} ({}s elapsed)",
            initial_state.session_id, initial_state.elapsed_sec
        );
    }

    let loaded_plugins = plugins::load_all(&flint_dir.join("plugins"));
    println!(
        "[flint] loaded {} plugin(s): {}",
        loaded_plugins.len(),
        loaded_plugins
            .iter()
            .map(|p| p.manifest.id.as_str())
            .collect::<Vec<_>>()
            .join(", ")
    );

    let cache_state = CacheState::new();
    match cache::initialize() {
        Ok(conn) => {
            if let Ok(mut guard) = cache_state.0.lock() {
                *guard = Some(conn);
            }
        }
        Err(e) => eprintln!("[flint] cache init failed: {}", e),
    }

    let app_state = storage::load_app_state();
    let has_active_session = initial_state.status != TimerStatus::Idle;
    let overlay_always_visible = cfg.overlay.always_visible;
    let overlay_enabled = cfg.overlay.enabled;

    tauri::Builder::default()
        .manage(EngineState(Mutex::new(initial_state)))
        .manage(ConfigState(Mutex::new(cfg)))
        .manage(PluginRegistry(Mutex::new(loaded_plugins)))
        .manage(cache_state)
        .manage(AppStateStore(Mutex::new(app_state)))
        .setup(move |app| {
            if let Err(e) = tray::setup(app.handle()) {
                eprintln!("[flint] tray setup failed: {}", e);
            }

            if overlay_enabled {
                if let Err(e) = overlay::build_overlay(app.handle()) {
                    eprintln!("[flint] overlay build failed: {}", e);
                } else if has_active_session || overlay_always_visible {
                    let _ = overlay::overlay_show(app.handle().clone());
                }
            }

            if let Some(main) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                main.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        let cfg_state = app_handle.state::<ConfigState>();
                        let close_to_tray = cfg_state
                            .0
                            .lock()
                            .map(|c| c.tray.close_to_tray)
                            .unwrap_or(true);
                        if !close_to_tray {
                            return;
                        }
                        api.prevent_close();

                        let store = app_handle.state::<AppStateStore>();
                        let toast_pending = store
                            .0
                            .lock()
                            .map(|s| !s.first_close_toast_shown)
                            .unwrap_or(false);

                        if toast_pending {
                            let _ = app_handle.emit(
                                "tray:first-close",
                                serde_json::json!({
                                    "message": "Flint minimized to tray. Right-click the tray icon → Quit to exit."
                                }),
                            );
                        } else if let Some(window) =
                            app_handle.get_webview_window("main")
                        {
                            let _ = window.hide();
                        }
                    }
                });
            }

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_secs(1));
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    tick_once(&handle);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_session,
            commands::pause_session,
            commands::resume_session,
            commands::stop_session,
            commands::cancel_session,
            commands::mark_question,
            commands::get_timer_state,
            commands::next_interval,
            commands::set_tags,
            commands::get_config,
            commands::update_config,
            commands::get_flint_dir,
            commands::list_plugins,
            commands::set_plugin_enabled,
            commands::get_plugin_config,
            commands::set_plugin_config,
            commands::plugin_storage_get,
            commands::plugin_storage_set,
            commands::plugin_storage_delete,
            commands::list_sessions,
            commands::cache_list_sessions,
            commands::cache_session_detail,
            commands::stats_today,
            commands::stats_range,
            commands::stats_heatmap,
            commands::rebuild_cache,
            commands::get_app_state,
            commands::mark_first_close_shown,
            commands::hide_main_window,
            commands::show_main_window,
            commands::quit_app,
            overlay::overlay_show,
            overlay::overlay_hide,
            overlay::overlay_toggle,
            overlay::overlay_set_expanded,
            overlay::overlay_save_position,
            overlay::overlay_move_to,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
