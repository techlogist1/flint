mod cache;
mod commands;
mod config;
mod overlay;
mod plugins;
mod presets;
mod storage;
mod tags;
mod timer;
mod tray;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use cache::CacheState;
use commands::{
    AppStateStore, ConfigState, EngineState, PendingIntervalState, PluginRegistry,
    SessionOverridesState,
};
use tags::TagIndex;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use timer::{TimerState, TimerStatus};
use tokio::time::MissedTickBehavior;

/// FIX 7: warn loudly if a single tick body takes longer than this. Holding
/// the engine mutex + emitting IPC + updating the tray should be far under
/// 10 ms on a healthy system; anything above means we've regressed on the
/// no-disk-I/O-on-tick invariant (P-C1) and need to investigate.
const TICK_SLOW_WARN_THRESHOLD: Duration = Duration::from_millis(10);

fn tick_once(app: &AppHandle) {
    // P-H1: snapshot `show_timer_in_tray` from the config lock *before*
    // grabbing the engine lock. The tray-tooltip path then needs zero
    // locks during the tick itself — both acquisitions are sequential,
    // short, and outside any disk I/O.
    let show_timer = app
        .state::<ConfigState>()
        .0
        .lock()
        .map(|c| c.tray.show_timer_in_tray)
        .unwrap_or(true);

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
        // P-C1: snapshot under the lock (cheap clone) and ship to the
        // background writer so the actual disk I/O happens off the engine
        // mutex and off the tick thread.
        app.state::<storage::RecoveryWriter>().send_state(&state);
    }

    // P-H1: snapshot the tooltip inputs while the engine lock is still held
    // (status + elapsed_sec are all the tooltip needs). Once we drop the
    // lock, `update_tooltip` takes no additional locks at all — zero
    // contention between tick writes and the tray update.
    let tooltip_snapshot = tray::TrayTooltipSnapshot {
        status: state.status,
        elapsed_sec: state.elapsed_sec,
        show_timer,
    };

    drop(state);
    tray::update_tooltip(app, &tooltip_snapshot);
}

fn apply_recovery(rec: storage::RecoveryFile, now: chrono::DateTime<chrono::Utc>) -> TimerState {
    let mut state = TimerState::idle();
    let status = match rec.status.as_str() {
        "paused" => TimerStatus::Paused,
        _ => TimerStatus::Running,
    };

    // If the session was running when the app closed, advance the clock by the
    // wall-clock time that has passed since the recovery file was last updated.
    // A paused session keeps its stored elapsed_sec exactly — any pause time
    // must NOT be counted into elapsed, which is why we measure from
    // last_saved_at (snapshot time), not started_at (session start).
    let extra_sec: u64 = if status == TimerStatus::Running {
        (now - rec.last_saved_at).num_seconds().max(0) as u64
    } else {
        0
    };

    state.session_id = Some(rec.session_id);
    state.started_at = Some(rec.started_at);
    state.elapsed_sec = rec.elapsed_sec + extra_sec;
    state.mode = rec.mode;
    state.status = status;
    state.tags = rec.tags;
    state.completed_intervals = rec.intervals;
    state.current_interval = rec.current_interval.map(|mut ci| {
        ci.elapsed_sec += extra_sec;
        ci
    });
    state.recovery_pending = true;
    state
}

fn build_initial_state() -> (TimerState, bool) {
    match storage::load_recovery() {
        Some(rec) => (apply_recovery(rec, chrono::Utc::now()), true),
        None => (TimerState::idle(), false),
    }
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

    let recovery_writer = storage::spawn_recovery_writer();

    // [M-2]: Tag index starts empty and is populated by a background tokio
    // task. The autocomplete tolerates an empty initial set, so the first
    // paint is no longer blocked on a full scan of `~/.flint/sessions/`. The
    // scan itself does no IO under the TagIndex mutex — it builds the set
    // first and only takes the lock at the very end to install it. Updated
    // incrementally afterwards when a session is finalised
    // (commands::finalize_session).
    let tag_index = TagIndex::new_empty();

    tauri::Builder::default()
        .manage(EngineState(Mutex::new(initial_state)))
        .manage(ConfigState(Mutex::new(cfg)))
        .manage(PluginRegistry(Mutex::new(loaded_plugins)))
        .manage(cache_state)
        .manage(AppStateStore(Mutex::new(app_state)))
        .manage(recovery_writer)
        .manage(SessionOverridesState::new_empty())
        .manage(PendingIntervalState::new_empty())
        .manage(tag_index)
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
                            // [H-2]: finalize any running session as cancelled
                            // before the close completes. Without this, the
                            // recovery file lives on with a stale `last_saved_at`
                            // and the next launch silently inflates elapsed_sec
                            // by the wall-clock gap between close and relaunch.
                            // `shutdown_with_finalize` also flushes the recovery
                            // writer and tears the overlay down in the correct
                            // Win32 ordering, so we do not need a separate
                            // `close_overlay_if_open` call here.
                            commands::shutdown_with_finalize(&app_handle);
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

            // [M-2]: rebuild the tag index off the main thread so a power user
            // with thousands of session files does not pay a 1-3s startup
            // delay before the first paint. The scan does its own filesystem
            // walk, builds a plain HashSet, and only takes the TagIndex mutex
            // at the end to install the result. No mutex is held across an
            // await point (the work itself is sync inside `spawn_blocking`).
            let scan_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let scanned = tauri::async_runtime::spawn_blocking(tags::scan_all_sessions)
                    .await
                    .unwrap_or_default();
                let count = scanned.len();
                let tag_index = scan_handle.state::<TagIndex>();
                if let Ok(mut guard) = tag_index.0.lock() {
                    guard.extend(scanned);
                }
                println!("[flint] tag index seeded with {} tags (background)", count);
            });

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_secs(1));
                // FIX 7: if a tick body stalls past its 1 s slot, skip the
                // backlog instead of firing a burst of catch-up ticks. The
                // engine is wall-clock-driven (not tick-counter-driven), so
                // a skipped tick just means the next tick picks up where we
                // left off — no state is lost.
                ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
                ticker.tick().await;
                loop {
                    ticker.tick().await;
                    let started = Instant::now();
                    tick_once(&handle);
                    let elapsed = started.elapsed();
                    if elapsed > TICK_SLOW_WARN_THRESHOLD {
                        eprintln!(
                            "[flint] slow tick: body took {:?} (> {:?})",
                            elapsed, TICK_SLOW_WARN_THRESHOLD
                        );
                    }
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
            commands::get_timer_state,
            commands::next_interval,
            commands::set_first_interval,
            commands::set_next_interval,
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
            commands::stats_lifetime,
            commands::rebuild_cache,
            commands::delete_session,
            commands::get_app_state,
            commands::mark_first_close_shown,
            commands::hide_main_window,
            commands::show_main_window,
            commands::quit_app,
            commands::open_data_folder,
            commands::export_all_sessions,
            commands::list_presets,
            commands::save_preset,
            commands::delete_preset,
            commands::load_preset,
            commands::touch_preset,
            commands::get_known_tags,
            overlay::overlay_show,
            overlay::overlay_hide,
            overlay::overlay_toggle,
            overlay::overlay_save_position,
            overlay::overlay_move_to,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::RecoveryFile;
    use crate::timer::Interval;
    use chrono::{Duration, Utc};

    fn make_rec(status: &str, elapsed_sec: u64, last_saved_secs_ago: i64) -> RecoveryFile {
        let now = Utc::now();
        let started_at = now - Duration::seconds(last_saved_secs_ago + 60);
        let last_saved_at = now - Duration::seconds(last_saved_secs_ago);
        RecoveryFile {
            session_id: "deadbeef".into(),
            started_at,
            elapsed_sec,
            mode: "pomodoro".into(),
            status: status.into(),
            tags: vec!["project".into()],
            intervals: Vec::new(),
            current_interval: Some(Interval {
                interval_type: "focus".into(),
                start_sec: 0,
                elapsed_sec,
                target_sec: Some(1500),
                ended_emitted: false,
            }),
            plugin_data: serde_json::json!({}),
            last_saved_at,
        }
    }

    // B-C1 regression: a paused session must NOT inflate elapsed_sec on restore,
    // regardless of how long the app was down. Previously the restore math used
    // `now - started_at - elapsed_sec` which silently added pause time into
    // elapsed every time the session was resumed.
    #[test]
    fn paused_session_does_not_advance_on_restore() {
        // Session ran 1 min, was paused, then app sat for 30 min, then crashed.
        // Recovery file was last saved mid-pause with elapsed_sec = 70.
        let rec = make_rec("paused", 70, 30 * 60);
        let state = apply_recovery(rec, Utc::now());
        assert_eq!(state.elapsed_sec, 70);
        assert_eq!(
            state
                .current_interval
                .as_ref()
                .map(|i| i.elapsed_sec)
                .unwrap_or(0),
            70
        );
    }

    // Full B-C1 scenario: start, pause 30min, resume, crash 5s later, restore.
    // At resume, the recovery file is re-written so last_saved_at jumps to
    // resume time; the subsequent crash happens only 5s after that. Elapsed
    // should be ~75s (70 stored + 5s extra), NOT ~1875s as the bug produced.
    #[test]
    fn running_session_advances_only_from_last_saved() {
        // 5 seconds ago the app saved recovery showing a running session at
        // elapsed_sec = 70. The 30-minute pause that came before is already
        // excluded from elapsed_sec because the clock wasn't ticking then.
        let rec = make_rec("running", 70, 5);
        let state = apply_recovery(rec, Utc::now());
        // Allow a 1s wall-clock jitter window for the test.
        assert!(
            (74..=76).contains(&state.elapsed_sec),
            "expected ~75, got {}",
            state.elapsed_sec
        );
    }

    #[test]
    fn running_session_with_zero_downtime_is_unchanged() {
        let rec = make_rec("running", 42, 0);
        let state = apply_recovery(rec, Utc::now());
        assert!(
            (42..=43).contains(&state.elapsed_sec),
            "expected 42–43, got {}",
            state.elapsed_sec
        );
    }
}
