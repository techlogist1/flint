use crate::timer::{Interval, TimerState, TimerStatus};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

pub fn flint_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "could not resolve home directory".to_string())?;
    let dir = home.join(".flint");
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {}", dir.display(), e))?;
    fs::create_dir_all(dir.join("sessions"))
        .map_err(|e| format!("create sessions: {}", e))?;
    fs::create_dir_all(dir.join("plugins"))
        .map_err(|e| format!("create plugins: {}", e))?;
    Ok(dir)
}

pub fn recovery_path() -> Result<PathBuf, String> {
    Ok(flint_dir()?.join("recovery.json"))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RecoveryFile {
    pub session_id: String,
    pub started_at: DateTime<Utc>,
    pub elapsed_sec: u64,
    pub mode: String,
    pub status: String,
    pub tags: Vec<String>,
    pub questions_done: u32,
    pub intervals: Vec<Interval>,
    pub current_interval: Option<Interval>,
    #[serde(default)]
    pub plugin_data: serde_json::Value,
}

pub fn write_recovery(state: &TimerState) -> Result<(), String> {
    if state.status == TimerStatus::Idle || state.session_id.is_none() {
        return Ok(());
    }
    let payload = RecoveryFile {
        session_id: state.session_id.clone().unwrap(),
        started_at: state.started_at.unwrap_or_else(Utc::now),
        elapsed_sec: state.elapsed_sec,
        mode: state.mode.clone(),
        status: match state.status {
            TimerStatus::Running => "running".into(),
            TimerStatus::Paused => "paused".into(),
            TimerStatus::Idle => "idle".into(),
        },
        tags: state.tags.clone(),
        questions_done: state.questions_done,
        intervals: state.completed_intervals.clone(),
        current_interval: state.current_interval.clone(),
        plugin_data: serde_json::json!({}),
    };
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    let path = recovery_path()?;
    fs::write(&path, json).map_err(|e| format!("fs::write {}: {}", path.display(), e))?;
    Ok(())
}

pub fn delete_recovery() -> Result<(), String> {
    let path = recovery_path()?;
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn load_recovery() -> Option<RecoveryFile> {
    let path = recovery_path().ok()?;
    if !path.exists() {
        return None;
    }
    let data = fs::read_to_string(&path).ok()?;
    match serde_json::from_str(&data) {
        Ok(r) => Some(r),
        Err(e) => {
            eprintln!("[flint] recovery.json parse error: {}", e);
            None
        }
    }
}

pub fn write_session_file(
    state: &TimerState,
    ended_at: DateTime<Utc>,
    completed: bool,
) -> Result<PathBuf, String> {
    let sessions_dir = flint_dir()?.join("sessions");
    let id = state.session_id.clone().ok_or("no session id")?;
    let started_at = state.started_at.ok_or("no started_at")?;
    let date = started_at.format("%Y-%m-%d").to_string();
    let primary_tag = state
        .tags
        .first()
        .map(|t| slugify(t))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "untagged".to_string());
    let dur_min = state.elapsed_sec / 60;
    let filename = format!("{}_{}_{}m_{}.json", date, primary_tag, dur_min, id);
    let path = sessions_dir.join(&filename);

    let mut intervals: Vec<Interval> = state.completed_intervals.clone();
    if let Some(ci) = &state.current_interval {
        if ci.elapsed_sec > 0 {
            intervals.push(ci.clone());
        }
    }
    let intervals_json: Vec<serde_json::Value> = intervals
        .into_iter()
        .map(|i| {
            serde_json::json!({
                "type": i.interval_type,
                "start_sec": i.start_sec,
                "end_sec": i.start_sec + i.elapsed_sec,
            })
        })
        .collect();

    let payload = serde_json::json!({
        "id": id,
        "version": 1,
        "started_at": started_at,
        "ended_at": ended_at,
        "duration_sec": state.elapsed_sec,
        "mode": state.mode,
        "tags": state.tags,
        "questions_done": state.questions_done,
        "completed": completed,
        "intervals": intervals_json,
        "plugin_data": {},
    });
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path)
}

fn slugify(s: &str) -> String {
    let raw: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    raw.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timer::{Interval, TimerState, TimerStatus};

    fn sample_state() -> TimerState {
        let mut s = TimerState::idle();
        s.session_id = Some("deadbeef".into());
        s.started_at = Some(Utc::now());
        s.status = TimerStatus::Running;
        s.elapsed_sec = 42;
        s.mode = "pomodoro".into();
        s.tags = vec!["physics".into()];
        s.questions_done = 3;
        s.current_interval = Some(Interval {
            interval_type: "focus".into(),
            start_sec: 0,
            elapsed_sec: 42,
            target_sec: Some(1500),
            ended_emitted: false,
        });
        s
    }

    #[test]
    fn recovery_roundtrip() {
        let state = sample_state();
        write_recovery(&state).expect("write ok");
        let loaded = load_recovery().expect("load ok");
        assert_eq!(loaded.session_id, "deadbeef");
        assert_eq!(loaded.elapsed_sec, 42);
        assert_eq!(loaded.mode, "pomodoro");
        assert_eq!(loaded.status, "running");
        assert_eq!(loaded.questions_done, 3);
        assert_eq!(loaded.tags, vec!["physics".to_string()]);
        assert!(loaded.current_interval.is_some());
        delete_recovery().ok();
    }
}
