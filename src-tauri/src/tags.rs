//! Tag index — a lightweight `HashSet<String>` of every tag that has ever
//! appeared on a saved session. Built at startup by scanning
//! `~/.flint/sessions/*.json`, updated incrementally when a new session is
//! finalised. There is no persisted index — tags are always derived from
//! the session files, so deleting/editing a session file immediately
//! affects what the autocomplete sees (after a rescan).
//!
//! The index is held inside a `Mutex<HashSet<String>>` managed by Tauri,
//! same pattern as `EngineState` / `ConfigState`.

use crate::storage;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::sync::Mutex;

pub struct TagIndex(pub Mutex<HashSet<String>>);

impl TagIndex {
    pub fn new_empty() -> Self {
        Self(Mutex::new(HashSet::new()))
    }
}

/// Scan every session file under `~/.flint/sessions/` and collect the union
/// of their `tags` arrays. Called at startup from `lib::run`. Errors are
/// logged and skipped — one malformed session file cannot prevent the rest
/// of the tags from being indexed.
pub fn scan_all_sessions() -> HashSet<String> {
    let mut out: HashSet<String> = HashSet::new();
    let Ok(root) = storage::flint_dir() else {
        return out;
    };
    let sessions = root.join("sessions");
    let Ok(entries) = fs::read_dir(&sessions) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        if let Some(tags) = value.get("tags").and_then(|v| v.as_array()) {
            for t in tags {
                if let Some(s) = t.as_str() {
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        out.insert(trimmed.to_string());
                    }
                }
            }
        }
    }
    out
}

pub fn insert_many(index: &TagIndex, tags: &[String]) {
    if tags.is_empty() {
        return;
    }
    let Ok(mut guard) = index.0.lock() else {
        return;
    };
    for t in tags {
        let trimmed = t.trim();
        if !trimmed.is_empty() {
            guard.insert(trimmed.to_string());
        }
    }
}

pub fn snapshot(index: &TagIndex) -> Vec<String> {
    let Ok(guard) = index.0.lock() else {
        return Vec::new();
    };
    let mut out: Vec<String> = guard.iter().cloned().collect();
    out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_and_snapshot_dedupes_and_sorts() {
        let idx = TagIndex::new_empty();
        insert_many(
            &idx,
            &[
                "project".into(),
                "DEEP-WORK".into(),
                "  creative  ".into(),
                "project".into(),
                "".into(),
            ],
        );
        let snap = snapshot(&idx);
        assert_eq!(snap, vec!["creative", "DEEP-WORK", "project"]);
    }
}
