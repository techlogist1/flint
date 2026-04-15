use crate::timer::{Interval, TimerState, TimerStatus};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::mpsc as std_mpsc;
use std::time::Duration;
use tokio::sync::mpsc as tokio_mpsc;
use tokio::time::{sleep_until, Instant as TokioInstant};

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

/// S-H5 / C-M4: atomic file write. Serialises `data` to a `<path>.tmp`
/// sibling, then renames it into place. `fs::rename` is atomic on both
/// Windows NTFS and macOS APFS, so a crash/poweroff at any point leaves
/// either the previous file or the new file intact — never a truncated
/// half-write. Used for session JSON files and recovery snapshots.
pub fn write_atomic(path: &std::path::Path, data: &[u8]) -> Result<(), String> {
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("no file name in {}", path.display()))?;
    let mut tmp_name = file_name.to_os_string();
    tmp_name.push(".tmp");
    let tmp_path = path.with_file_name(tmp_name);
    fs::write(&tmp_path, data)
        .map_err(|e| format!("write {}: {}", tmp_path.display(), e))?;
    fs::rename(&tmp_path, path).map_err(|e| {
        // Best-effort cleanup of the tmp file so a failed rename doesn't
        // leak a stale sibling into the sessions/ directory.
        let _ = fs::remove_file(&tmp_path);
        format!("rename {} -> {}: {}", tmp_path.display(), path.display(), e)
    })
}

pub fn recovery_path() -> Result<PathBuf, String> {
    Ok(flint_dir()?.join("recovery.json"))
}

pub fn state_path() -> Result<PathBuf, String> {
    Ok(flint_dir()?.join("state.json"))
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AppState {
    pub first_close_toast_shown: bool,
    pub hint_dismissed: bool,
}

pub fn load_app_state() -> AppState {
    let Ok(path) = state_path() else {
        return AppState::default();
    };
    if !path.exists() {
        return AppState::default();
    }
    match fs::read_to_string(&path) {
        Ok(data) => serde_json::from_str(&data).unwrap_or_default(),
        Err(_) => AppState::default(),
    }
}

pub fn save_app_state(state: &AppState) -> Result<(), String> {
    let path = state_path()?;
    let json = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    write_atomic(&path, json.as_bytes())
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
    // Wall-clock time at which this recovery snapshot was written. Used by
    // restore to compute how much real time has passed while the app was
    // down. For Running sessions we forward-advance elapsed by that delta;
    // for Paused sessions we do NOT — the stored elapsed is already correct
    // because the clock was not moving while paused.
    #[serde(default = "Utc::now")]
    pub last_saved_at: DateTime<Utc>,
}

/// Cheap, owned copy of the timer fields the recovery file cares about.
/// Built while the engine mutex is held (so the values are consistent), then
/// shipped to the writer task for the actual fs::write — keeping the lock
/// span microsecond-scale instead of disk-I/O-scale.
#[derive(Debug, Clone)]
pub struct RecoverySnapshot {
    session_id: String,
    started_at: DateTime<Utc>,
    elapsed_sec: u64,
    mode: String,
    status: String,
    tags: Vec<String>,
    questions_done: u32,
    intervals: Vec<Interval>,
    current_interval: Option<Interval>,
}

impl RecoverySnapshot {
    pub fn from_state(state: &TimerState) -> Option<Self> {
        if state.status == TimerStatus::Idle {
            return None;
        }
        let session_id = state.session_id.clone()?;
        Some(Self {
            session_id,
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
        })
    }

    fn into_payload(self) -> RecoveryFile {
        RecoveryFile {
            session_id: self.session_id,
            started_at: self.started_at,
            elapsed_sec: self.elapsed_sec,
            mode: self.mode,
            status: self.status,
            tags: self.tags,
            questions_done: self.questions_done,
            intervals: self.intervals,
            current_interval: self.current_interval,
            plugin_data: serde_json::json!({}),
            last_saved_at: Utc::now(),
        }
    }
}

fn write_snapshot_to_disk(snapshot: RecoverySnapshot) -> Result<(), String> {
    let payload = snapshot.into_payload();
    let json = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    let path = recovery_path()?;
    write_atomic(&path, json.as_bytes())
}

/// Messages accepted by the background recovery writer. Snapshots are
/// debounced; Delete clears the on-disk file and any pending snapshot; Flush
/// drains the queue synchronously and acks via the std::sync channel so the
/// shutdown path can wait for the final write to land.
enum RecoveryMessage {
    Snapshot(RecoverySnapshot),
    Delete,
    Flush(std_mpsc::Sender<()>),
}

/// Handle to the background recovery writer task. All production code paths
/// that previously called `write_recovery` synchronously now send a snapshot
/// here instead, so the engine mutex is released before any disk I/O.
pub struct RecoveryWriter {
    tx: tokio_mpsc::UnboundedSender<RecoveryMessage>,
}

impl RecoveryWriter {
    /// Snapshot the state (cheap clone — must be called while the engine
    /// mutex is held) and ship it to the writer task. No-op if the state is
    /// idle. Non-blocking; the disk write happens on the writer task.
    pub fn send_state(&self, state: &TimerState) {
        if let Some(snapshot) = RecoverySnapshot::from_state(state) {
            let _ = self.tx.send(RecoveryMessage::Snapshot(snapshot));
        }
    }

    pub fn delete(&self) {
        let _ = self.tx.send(RecoveryMessage::Delete);
    }

    /// Block until the writer has flushed any pending snapshot to disk. Used
    /// from the shutdown paths (Ctrl+Q, tray Quit, Close-when-not-tray) so
    /// the final state is persisted before `app.exit()`.
    pub fn flush_blocking(&self) {
        let (ack_tx, ack_rx) = std_mpsc::channel();
        if self.tx.send(RecoveryMessage::Flush(ack_tx)).is_err() {
            return;
        }
        let _ = ack_rx.recv_timeout(Duration::from_secs(2));
    }
}

const RECOVERY_DEBOUNCE: Duration = Duration::from_millis(500);

pub fn spawn_recovery_writer() -> RecoveryWriter {
    let (tx, mut rx) = tokio_mpsc::unbounded_channel::<RecoveryMessage>();
    tauri::async_runtime::spawn(async move {
        let mut latest: Option<RecoverySnapshot> = None;
        let mut deadline: Option<TokioInstant> = None;
        loop {
            let msg = if let Some(d) = deadline {
                tokio::select! {
                    biased;
                    msg = rx.recv() => msg,
                    _ = sleep_until(d) => {
                        if let Some(snapshot) = latest.take() {
                            if let Err(e) = write_snapshot_to_disk(snapshot) {
                                eprintln!("[flint] recovery write failed: {}", e);
                            }
                        }
                        deadline = None;
                        continue;
                    }
                }
            } else {
                rx.recv().await
            };

            let Some(msg) = msg else {
                if let Some(snapshot) = latest.take() {
                    if let Err(e) = write_snapshot_to_disk(snapshot) {
                        eprintln!("[flint] recovery write on close failed: {}", e);
                    }
                }
                return;
            };

            match msg {
                RecoveryMessage::Snapshot(snapshot) => {
                    latest = Some(snapshot);
                    deadline = Some(TokioInstant::now() + RECOVERY_DEBOUNCE);
                }
                RecoveryMessage::Delete => {
                    latest = None;
                    deadline = None;
                    if let Err(e) = delete_recovery() {
                        eprintln!("[flint] recovery delete failed: {}", e);
                    }
                }
                RecoveryMessage::Flush(ack) => {
                    if let Some(snapshot) = latest.take() {
                        if let Err(e) = write_snapshot_to_disk(snapshot) {
                            eprintln!("[flint] recovery flush failed: {}", e);
                        }
                    }
                    deadline = None;
                    let _ = ack.send(());
                }
            }
        }
    });
    RecoveryWriter { tx }
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
            // B-H4: preserve the broken file rather than silently losing it,
            // so the user (or a bug report) can inspect what went wrong.
            rename_broken(&path);
            None
        }
    }
}

/// Rename a file to `<name>.broken.<unix-timestamp>` so a corrupted on-disk
/// file can be inspected later instead of being silently overwritten by a
/// fresh default. Used by recovery/config parse error paths. Returns the new
/// path on success.
pub fn rename_broken(path: &std::path::Path) -> Option<PathBuf> {
    let ts = chrono::Utc::now().timestamp();
    let filename = path.file_name()?;
    let new_name = format!("{}.broken.{}", filename.to_string_lossy(), ts);
    let new_path = path.with_file_name(new_name);
    match fs::rename(path, &new_path) {
        Ok(_) => {
            eprintln!(
                "[flint] renamed broken {} → {}",
                path.display(),
                new_path.display()
            );
            Some(new_path)
        }
        Err(e) => {
            eprintln!(
                "[flint] failed to rename broken {}: {}",
                path.display(),
                e
            );
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
    write_atomic(&path, json.as_bytes())?;
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
        s.tags = vec!["project".into()];
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
        let snapshot =
            RecoverySnapshot::from_state(&state).expect("running state yields snapshot");
        write_snapshot_to_disk(snapshot).expect("write ok");
        let loaded = load_recovery().expect("load ok");
        assert_eq!(loaded.session_id, "deadbeef");
        assert_eq!(loaded.elapsed_sec, 42);
        assert_eq!(loaded.mode, "pomodoro");
        assert_eq!(loaded.status, "running");
        assert_eq!(loaded.questions_done, 3);
        assert_eq!(loaded.tags, vec!["project".to_string()]);
        assert!(loaded.current_interval.is_some());
        delete_recovery().ok();
    }
}
