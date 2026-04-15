//! Preset storage — saved session configurations persisted as plain JSON
//! files in `~/.flint/presets/{uuid}.json`. Presets are first-class citizens
//! (consistent with Flint's local-first, file-based architecture) and are
//! scanned fresh from disk on every `list_presets` call; there is no
//! in-memory cache so the source of truth is always the filesystem.
//!
//! All writes are atomic (tmp + rename) via `storage::write_atomic` so a
//! crash/poweroff at any point leaves either the previous file or the new
//! file intact — never a truncated half-write. Same policy we use for
//! sessions and recovery snapshots.

use crate::storage::{self, write_atomic};
use chrono::{DateTime, Utc};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub plugin_id: String,
    #[serde(default)]
    pub config_overrides: Map<String, Value>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub sort_order: i32,
    pub created_at: DateTime<Utc>,
    #[serde(default)]
    pub last_used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PresetDraft {
    pub name: String,
    pub plugin_id: String,
    #[serde(default)]
    pub config_overrides: Map<String, Value>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub sort_order: Option<i32>,
    /// Optional id — if absent, a new one is generated. Allows the frontend
    /// to update an existing preset by supplying its id.
    #[serde(default)]
    pub id: Option<String>,
}

pub fn presets_dir() -> Result<PathBuf, String> {
    let dir = storage::flint_dir()?.join("presets");
    fs::create_dir_all(&dir).map_err(|e| format!("create {}: {}", dir.display(), e))?;
    Ok(dir)
}

fn generate_id() -> String {
    // 16 hex chars — plenty of entropy for a single-user local app and
    // consistent with the style of session ids already in use.
    let mut rng = rand::thread_rng();
    let hi: u64 = rng.gen();
    let lo: u64 = rng.gen();
    format!("{:016x}{:016x}", hi, lo)
}

fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("preset id must not be empty".into());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid preset id: {}", id));
    }
    Ok(())
}

fn preset_path(id: &str) -> Result<PathBuf, String> {
    validate_id(id)?;
    Ok(presets_dir()?.join(format!("{}.json", id)))
}

pub fn list_all() -> Result<Vec<Preset>, String> {
    let dir = presets_dir()?;
    let mut out: Vec<Preset> = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        match fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str::<Preset>(&content) {
                Ok(p) => out.push(p),
                Err(e) => {
                    eprintln!("[flint] skip malformed preset {}: {}", path.display(), e);
                }
            },
            Err(e) => eprintln!("[flint] read preset {}: {}", path.display(), e),
        }
    }
    out.sort_by(|a, b| {
        let pin = b.pinned.cmp(&a.pinned);
        if pin != std::cmp::Ordering::Equal {
            return pin;
        }
        let order = a.sort_order.cmp(&b.sort_order);
        if order != std::cmp::Ordering::Equal {
            return order;
        }
        a.name.to_lowercase().cmp(&b.name.to_lowercase())
    });
    Ok(out)
}

pub fn load(id: &str) -> Result<Preset, String> {
    let path = preset_path(id)?;
    if !path.exists() {
        return Err(format!("preset {} not found", id));
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| format!("parse preset {}: {}", id, e))
}

pub fn save(draft: PresetDraft) -> Result<Preset, String> {
    let name = draft.name.trim().to_string();
    if name.is_empty() {
        return Err("preset name must not be empty".into());
    }
    if draft.plugin_id.trim().is_empty() {
        return Err("preset plugin_id must not be empty".into());
    }

    let now = Utc::now();
    let id = match draft.id {
        Some(existing) => {
            validate_id(&existing)?;
            existing
        }
        None => generate_id(),
    };

    // Preserve created_at / last_used_at if we're updating an existing file.
    let (created_at, last_used_at) = match load(&id) {
        Ok(prev) => (prev.created_at, prev.last_used_at),
        Err(_) => (now, None),
    };

    let preset = Preset {
        id: id.clone(),
        name,
        plugin_id: draft.plugin_id,
        config_overrides: draft.config_overrides,
        tags: draft.tags,
        pinned: draft.pinned,
        sort_order: draft.sort_order.unwrap_or(0),
        created_at,
        last_used_at,
    };

    let path = preset_path(&id)?;
    let json = serde_json::to_string_pretty(&preset).map_err(|e| e.to_string())?;
    write_atomic(&path, json.as_bytes())?;
    Ok(preset)
}

pub fn delete(id: &str) -> Result<(), String> {
    let path = preset_path(id)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("delete preset {}: {}", id, e))?;
    }
    Ok(())
}

/// Bump `last_used_at` on a preset without rewriting anything else. Called
/// after a preset is loaded into a session so the next preset listing
/// reflects recency.
pub fn touch(id: &str) -> Result<(), String> {
    let mut preset = load(id)?;
    preset.last_used_at = Some(Utc::now());
    let path = preset_path(id)?;
    let json = serde_json::to_string_pretty(&preset).map_err(|e| e.to_string())?;
    write_atomic(&path, json.as_bytes())?;
    Ok(())
}

/// Merge a preset's `config_overrides` into the base config for a specific
/// plugin id. Used by the engine when building the first/next interval so
/// the running session honours the preset without ever writing to
/// config.toml. Unknown keys in the overrides are ignored silently — the
/// schema validation is the plugin's responsibility.
pub fn apply_overrides_to_config(
    config_value: &mut Value,
    plugin_id: &str,
    overrides: &Map<String, Value>,
) {
    if overrides.is_empty() {
        return;
    }
    let section = match plugin_id {
        "pomodoro" => "pomodoro",
        "countdown" => "core",
        _ => return,
    };
    let Value::Object(ref mut root) = config_value else {
        return;
    };
    let entry = root
        .entry(section.to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if let Value::Object(ref mut obj) = entry {
        for (k, v) in overrides {
            obj.insert(k.clone(), v.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn applies_pomodoro_overrides() {
        let mut cfg = json!({
            "pomodoro": {
                "focus_duration": 25.0,
                "break_duration": 5.0,
                "cycles_before_long": 4
            }
        });
        let mut overrides = Map::new();
        overrides.insert("focus_duration".into(), json!(45.0));
        overrides.insert("break_duration".into(), json!(10.0));
        apply_overrides_to_config(&mut cfg, "pomodoro", &overrides);
        assert_eq!(cfg["pomodoro"]["focus_duration"], json!(45.0));
        assert_eq!(cfg["pomodoro"]["break_duration"], json!(10.0));
        // Unrelated keys preserved.
        assert_eq!(cfg["pomodoro"]["cycles_before_long"], json!(4));
    }

    #[test]
    fn applies_countdown_overrides() {
        let mut cfg = json!({
            "core": {
                "default_mode": "pomodoro",
                "countdown_default_min": 60
            }
        });
        let mut overrides = Map::new();
        overrides.insert("countdown_default_min".into(), json!(90));
        apply_overrides_to_config(&mut cfg, "countdown", &overrides);
        assert_eq!(cfg["core"]["countdown_default_min"], json!(90));
    }

    #[test]
    fn unknown_plugin_is_ignored() {
        let mut cfg = json!({ "pomodoro": { "focus_duration": 25.0 } });
        let original = cfg.clone();
        let mut overrides = Map::new();
        overrides.insert("focus_duration".into(), json!(45.0));
        apply_overrides_to_config(&mut cfg, "unknown", &overrides);
        assert_eq!(cfg, original);
    }

    #[test]
    fn validate_id_rejects_paths() {
        assert!(validate_id("../../etc/passwd").is_err());
        assert!(validate_id("foo/bar").is_err());
        assert!(validate_id("").is_err());
        assert!(validate_id("abc123").is_ok());
        assert!(validate_id("a_b-c").is_ok());
    }
}
