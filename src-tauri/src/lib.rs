mod commands;
mod config;
mod storage;
mod timer;

use std::sync::Mutex;
use std::time::Duration;

use commands::EngineState;
use tauri::{AppHandle, Emitter, Manager};
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
}

fn build_initial_state() -> (TimerState, bool) {
    let mut state = TimerState::idle();
    let Some(rec) = storage::load_recovery() else {
        return (state, false);
    };
    state.session_id = Some(rec.session_id);
    state.started_at = Some(rec.started_at);
    state.elapsed_sec = rec.elapsed_sec;
    state.mode = rec.mode;
    state.status = match rec.status.as_str() {
        "paused" => TimerStatus::Paused,
        _ => TimerStatus::Running,
    };
    state.tags = rec.tags;
    state.questions_done = rec.questions_done;
    state.completed_intervals = rec.intervals;
    state.current_interval = rec.current_interval;
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

    tauri::Builder::default()
        .manage(EngineState(Mutex::new(initial_state)))
        .manage(cfg)
        .setup(|app| {
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
