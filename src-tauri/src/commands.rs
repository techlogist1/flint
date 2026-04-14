use crate::config::Config;
use crate::storage;
use crate::timer::{Interval, TimerState, TimerStatus};
use chrono::Utc;
use rand::Rng;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

pub struct EngineState(pub Mutex<TimerState>);

fn generate_id() -> String {
    let n: u32 = rand::thread_rng().gen();
    format!("{:08x}", n)
}

fn build_first_interval(mode: &str, config: &Config) -> Interval {
    let target = match mode {
        "pomodoro" => Some(u64::from(config.pomodoro.focus_min) * 60),
        "countdown" => Some(u64::from(config.core.countdown_default_min) * 60),
        _ => None,
    };
    Interval {
        interval_type: "focus".into(),
        start_sec: 0,
        elapsed_sec: 0,
        target_sec: target,
        ended_emitted: false,
    }
}

#[tauri::command]
pub fn start_session(
    mode: String,
    tags: Vec<String>,
    engine: State<'_, EngineState>,
    config: State<'_, Config>,
    app: AppHandle,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    if state.status != TimerStatus::Idle {
        return Err("a session is already active".into());
    }
    let id = generate_id();
    let interval = build_first_interval(&mode, &config);
    let it_type = interval.interval_type.clone();
    let it_target = interval.target_sec;

    state.session_id = Some(id.clone());
    state.started_at = Some(Utc::now());
    state.status = TimerStatus::Running;
    state.elapsed_sec = 0;
    state.questions_done = 0;
    state.mode = mode.clone();
    state.tags = tags.clone();
    state.completed_intervals.clear();
    state.current_interval = Some(interval);
    state.recovery_pending = false;

    storage::write_recovery(&state)?;

    app.emit(
        "session:start",
        serde_json::json!({ "session_id": id, "mode": mode, "tags": tags }),
    )
    .ok();
    app.emit(
        "interval:start",
        serde_json::json!({ "type": it_type, "target_sec": it_target }),
    )
    .ok();

    Ok(state.clone())
}

#[tauri::command]
pub fn pause_session(
    engine: State<'_, EngineState>,
    app: AppHandle,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    if state.status != TimerStatus::Running {
        return Err("not running".into());
    }
    state.status = TimerStatus::Paused;
    storage::write_recovery(&state)?;
    app.emit(
        "session:pause",
        serde_json::json!({ "elapsed_sec": state.elapsed_sec }),
    )
    .ok();
    Ok(state.clone())
}

#[tauri::command]
pub fn resume_session(
    engine: State<'_, EngineState>,
    app: AppHandle,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    if state.status != TimerStatus::Paused {
        return Err("not paused".into());
    }
    state.status = TimerStatus::Running;
    storage::write_recovery(&state)?;
    app.emit(
        "session:resume",
        serde_json::json!({ "elapsed_sec": state.elapsed_sec }),
    )
    .ok();
    Ok(state.clone())
}

fn finalize_session(
    state: &mut TimerState,
    app: &AppHandle,
    completed: bool,
) -> Result<(), String> {
    if state.status == TimerStatus::Idle {
        return Err("no active session".into());
    }
    let ended_at = Utc::now();
    let session_id = state.session_id.clone().unwrap_or_default();
    let duration_sec = state.elapsed_sec;
    let questions_done = state.questions_done;

    let path = storage::write_session_file(state, ended_at, completed)?;
    println!("[flint] wrote session file {}", path.display());

    let _ = storage::delete_recovery();

    let event = if completed {
        "session:complete"
    } else {
        "session:cancel"
    };
    let payload = if completed {
        serde_json::json!({
            "session_id": session_id,
            "duration_sec": duration_sec,
            "questions_done": questions_done,
        })
    } else {
        serde_json::json!({
            "session_id": session_id,
            "duration_sec": duration_sec,
        })
    };
    app.emit(event, payload).ok();

    state.reset();
    Ok(())
}

#[tauri::command]
pub fn stop_session(
    engine: State<'_, EngineState>,
    app: AppHandle,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    finalize_session(&mut state, &app, true)?;
    Ok(state.clone())
}

#[tauri::command]
pub fn cancel_session(
    engine: State<'_, EngineState>,
    app: AppHandle,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    finalize_session(&mut state, &app, false)?;
    Ok(state.clone())
}

#[tauri::command]
pub fn mark_question(
    engine: State<'_, EngineState>,
    app: AppHandle,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    if state.status == TimerStatus::Idle {
        return Err("no active session".into());
    }
    state.questions_done += 1;
    storage::write_recovery(&state)?;
    app.emit(
        "question:marked",
        serde_json::json!({ "total_questions": state.questions_done }),
    )
    .ok();
    Ok(state.clone())
}

#[tauri::command]
pub fn get_timer_state(
    engine: State<'_, EngineState>,
    app: AppHandle,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    if state.recovery_pending {
        state.recovery_pending = false;
        app.emit(
            "recovery:restored",
            serde_json::json!({
                "session_id": state.session_id,
                "elapsed_sec": state.elapsed_sec,
            }),
        )
        .ok();
    }
    Ok(state.clone())
}

#[tauri::command]
pub fn next_interval(
    engine: State<'_, EngineState>,
    config: State<'_, Config>,
    app: AppHandle,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    if state.status == TimerStatus::Idle {
        return Err("no active session".into());
    }
    let Some(current) = state.current_interval.take() else {
        return Err("no current interval".into());
    };
    let ended_type = current.interval_type.clone();
    let ended_duration = current.elapsed_sec;
    let next_start_sec = current.start_sec + current.elapsed_sec;
    state.completed_intervals.push(current);

    app.emit(
        "interval:end",
        serde_json::json!({ "type": ended_type, "duration_sec": ended_duration }),
    )
    .ok();

    let next = match state.mode.as_str() {
        "pomodoro" => {
            if ended_type == "focus" {
                let focus_count = state
                    .completed_intervals
                    .iter()
                    .filter(|i| i.interval_type == "focus")
                    .count() as u32;
                let long = config.pomodoro.cycles_before_long > 0
                    && focus_count > 0
                    && focus_count % config.pomodoro.cycles_before_long == 0;
                let target_min = if long {
                    config.pomodoro.long_break_min
                } else {
                    config.pomodoro.break_min
                };
                Interval {
                    interval_type: "break".into(),
                    start_sec: next_start_sec,
                    elapsed_sec: 0,
                    target_sec: Some(u64::from(target_min) * 60),
                    ended_emitted: false,
                }
            } else {
                Interval {
                    interval_type: "focus".into(),
                    start_sec: next_start_sec,
                    elapsed_sec: 0,
                    target_sec: Some(u64::from(config.pomodoro.focus_min) * 60),
                    ended_emitted: false,
                }
            }
        }
        _ => Interval {
            interval_type: "focus".into(),
            start_sec: next_start_sec,
            elapsed_sec: 0,
            target_sec: None,
            ended_emitted: false,
        },
    };

    let nt = next.interval_type.clone();
    let ntarget = next.target_sec;
    state.current_interval = Some(next);

    storage::write_recovery(&state)?;

    app.emit(
        "interval:start",
        serde_json::json!({ "type": nt, "target_sec": ntarget }),
    )
    .ok();

    Ok(state.clone())
}

#[tauri::command]
pub fn set_tags(
    tags: Vec<String>,
    engine: State<'_, EngineState>,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    if state.status == TimerStatus::Idle {
        return Err("no active session".into());
    }
    state.tags = tags;
    storage::write_recovery(&state)?;
    Ok(state.clone())
}
