use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigSchemaField {
    #[serde(rename = "type")]
    pub field_type: String,
    #[serde(default)]
    pub default: serde_json::Value,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    #[serde(rename = "type", default = "default_type")]
    pub plugin_type: String,
    pub entry: String,
    #[serde(default)]
    pub ui_slots: Vec<String>,
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_section: Option<String>,
    // S-H3: IndexMap preserves insertion order from the manifest JSON, so
    // settings render in the order the plugin author intended rather than
    // HashMap's non-deterministic iteration order.
    #[serde(default)]
    pub config_schema: IndexMap<String, ConfigSchemaField>,
    /// If true, this plugin registers itself as a selectable timer mode.
    /// Controls tray menu entries, Ctrl+N shortcuts, and the default-mode
    /// dropdown so that any community plugin can add a new timer mode by
    /// setting this flag — no core code changes required.
    #[serde(default)]
    pub timer_mode: bool,
}

fn default_type() -> String {
    "community".into()
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginDescriptor {
    pub manifest: PluginManifest,
    pub source: String,
    pub enabled: bool,
    pub builtin: bool,
}

pub struct LoadedPlugin {
    pub manifest: PluginManifest,
    pub source: String,
    pub builtin: bool,
}

const BUILTIN_PLUGINS: &[(&str, &str, &str)] = &[
    (
        "pomodoro",
        include_str!("../plugins/pomodoro/manifest.json"),
        include_str!("../plugins/pomodoro/index.js"),
    ),
    (
        "stopwatch",
        include_str!("../plugins/stopwatch/manifest.json"),
        include_str!("../plugins/stopwatch/index.js"),
    ),
    (
        "countdown",
        include_str!("../plugins/countdown/manifest.json"),
        include_str!("../plugins/countdown/index.js"),
    ),
    (
        "session-log",
        include_str!("../plugins/session-log/manifest.json"),
        include_str!("../plugins/session-log/index.js"),
    ),
    (
        "stats",
        include_str!("../plugins/stats/manifest.json"),
        include_str!("../plugins/stats/index.js"),
    ),
];

pub fn load_builtins() -> Vec<LoadedPlugin> {
    let mut out = Vec::new();
    for (id, manifest_json, source) in BUILTIN_PLUGINS {
        match serde_json::from_str::<PluginManifest>(manifest_json) {
            Ok(mut m) => {
                if &m.id != id {
                    eprintln!(
                        "[flint] builtin plugin manifest id mismatch: expected {}, got {}",
                        id, m.id
                    );
                    continue;
                }
                m.plugin_type = "default".into();
                out.push(LoadedPlugin {
                    manifest: m,
                    source: (*source).to_string(),
                    builtin: true,
                });
            }
            Err(e) => eprintln!("[flint] builtin '{}' manifest parse error: {}", id, e),
        }
    }
    out
}

pub fn load_community(plugins_dir: &Path) -> Vec<LoadedPlugin> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(plugins_dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        let Ok(manifest_content) = fs::read_to_string(&manifest_path) else {
            eprintln!("[flint] failed to read {}", manifest_path.display());
            continue;
        };
        let mut manifest: PluginManifest = match serde_json::from_str(&manifest_content) {
            Ok(m) => m,
            Err(e) => {
                eprintln!(
                    "[flint] community plugin manifest parse error ({}): {}",
                    manifest_path.display(),
                    e
                );
                continue;
            }
        };
        manifest.plugin_type = "community".into();

        // S-H1: canonicalize plugin dir and the resolved entry path, and
        // reject anything that escapes the plugin dir (e.g. `entry:
        // "../../../Windows/System32/calc.exe"`). Without this, a malicious
        // manifest could coerce Flint into reading any user-readable text
        // file on disk.
        let canonical_dir = match fs::canonicalize(&path) {
            Ok(p) => p,
            Err(e) => {
                eprintln!(
                    "[flint] canonicalize plugin dir {}: {}",
                    path.display(),
                    e
                );
                continue;
            }
        };
        let raw_entry = path.join(&manifest.entry);
        let canonical_entry = match fs::canonicalize(&raw_entry) {
            Ok(p) => p,
            Err(e) => {
                eprintln!(
                    "[flint] canonicalize plugin entry {}: {}",
                    raw_entry.display(),
                    e
                );
                continue;
            }
        };
        if !canonical_entry.starts_with(&canonical_dir) {
            eprintln!(
                "[flint] plugin '{}' entry path escapes plugin dir ({} not under {}) — skipping",
                manifest.id,
                canonical_entry.display(),
                canonical_dir.display()
            );
            continue;
        }

        let source = match fs::read_to_string(&canonical_entry) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[flint] read {}: {}", canonical_entry.display(), e);
                continue;
            }
        };
        out.push(LoadedPlugin {
            manifest,
            source,
            builtin: false,
        });
    }
    out
}

pub fn load_all(community_dir: &Path) -> Vec<LoadedPlugin> {
    let mut all = load_builtins();
    let community = load_community(community_dir);
    for c in community {
        if all.iter().any(|p| p.manifest.id == c.manifest.id) {
            eprintln!(
                "[flint] community plugin '{}' shadowed by builtin — skipping",
                c.manifest.id
            );
            continue;
        }
        all.push(c);
    }
    all
}

/// Lightweight record of an enabled timer mode — used by tray, Ctrl+N, and
/// the settings dropdown so none of those places have to reason about plugin
/// manifests or config plumbing.
#[derive(Debug, Clone, Serialize)]
pub struct TimerModeInfo {
    pub id: String,
    pub label: String,
}

/// Walk the loaded plugin list and return the enabled timer-mode plugins in
/// registration order. An "enabled" plugin is one the config explicitly turns
/// on, or a built-in plugin with no explicit override.
pub fn enabled_timer_modes(
    plugins: &[LoadedPlugin],
    enabled: &HashMap<String, bool>,
) -> Vec<TimerModeInfo> {
    plugins
        .iter()
        .filter(|p| p.manifest.timer_mode)
        .filter(|p| enabled.get(&p.manifest.id).copied().unwrap_or(p.builtin))
        .map(|p| TimerModeInfo {
            id: p.manifest.id.clone(),
            label: p.manifest.name.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtins_load_cleanly() {
        let loaded = load_builtins();
        let ids: Vec<&str> = loaded.iter().map(|p| p.manifest.id.as_str()).collect();
        assert!(ids.contains(&"pomodoro"), "pomodoro missing from builtins");
        assert!(ids.contains(&"stopwatch"), "stopwatch missing from builtins");
        assert!(ids.contains(&"countdown"), "countdown missing from builtins");
        assert!(
            ids.contains(&"session-log"),
            "session-log missing from builtins"
        );
        assert!(ids.contains(&"stats"), "stats missing from builtins");
        for p in &loaded {
            assert_eq!(p.manifest.plugin_type, "default");
            assert!(!p.source.is_empty(), "{} source empty", p.manifest.id);
        }
    }

    #[test]
    fn session_log_and_stats_register_sidebar_tabs() {
        let loaded = load_builtins();
        for id in ["session-log", "stats"] {
            let plugin = loaded
                .iter()
                .find(|p| p.manifest.id == id)
                .unwrap_or_else(|| panic!("{} missing", id));
            assert!(
                plugin.manifest.ui_slots.iter().any(|s| s == "sidebar-tab"),
                "{} is missing sidebar-tab slot",
                id
            );
        }
    }

    #[test]
    fn pomodoro_manifest_has_expected_schema() {
        let pom = load_builtins()
            .into_iter()
            .find(|p| p.manifest.id == "pomodoro")
            .expect("pomodoro missing");
        for key in [
            "focus_min",
            "break_min",
            "long_break_min",
            "cycles_before_long",
            "auto_start_breaks",
            "auto_start_focus",
        ] {
            assert!(
                pom.manifest.config_schema.contains_key(key),
                "missing schema key: {}",
                key
            );
        }
        assert_eq!(pom.manifest.config_section.as_deref(), Some("pomodoro"));
    }

    #[test]
    fn countdown_manifest_maps_to_core_section() {
        let c = load_builtins()
            .into_iter()
            .find(|p| p.manifest.id == "countdown")
            .expect("countdown missing");
        assert_eq!(c.manifest.config_section.as_deref(), Some("core"));
        assert!(c
            .manifest
            .config_schema
            .contains_key("countdown_default_min"));
    }

    #[test]
    fn stopwatch_has_no_config() {
        let s = load_builtins()
            .into_iter()
            .find(|p| p.manifest.id == "stopwatch")
            .expect("stopwatch missing");
        assert!(s.manifest.config_schema.is_empty());
    }

    // A community plugin adding a new timer mode must be surfaced by
    // `enabled_timer_modes` without any core-side edits. This test stands in
    // for that scenario by running the helper directly against the bundled
    // set and verifying every builtin mode plugin is present.
    #[test]
    fn enabled_timer_modes_contains_all_builtin_modes() {
        let loaded = load_builtins();
        let enabled: HashMap<String, bool> = HashMap::new();
        let modes = enabled_timer_modes(&loaded, &enabled);
        let ids: Vec<&str> = modes.iter().map(|m| m.id.as_str()).collect();
        assert!(ids.contains(&"pomodoro"));
        assert!(ids.contains(&"stopwatch"));
        assert!(ids.contains(&"countdown"));
        // Non-mode plugins must NOT leak into the mode list.
        assert!(!ids.contains(&"session-log"));
        assert!(!ids.contains(&"stats"));
    }

    #[test]
    fn enabled_timer_modes_respects_disabled_override() {
        let loaded = load_builtins();
        let mut enabled = HashMap::new();
        enabled.insert("pomodoro".to_string(), false);
        let modes = enabled_timer_modes(&loaded, &enabled);
        let ids: Vec<&str> = modes.iter().map(|m| m.id.as_str()).collect();
        assert!(!ids.contains(&"pomodoro"));
        assert!(ids.contains(&"stopwatch"));
        assert!(ids.contains(&"countdown"));
    }

    #[test]
    fn builtin_timer_mode_plugins_declare_timer_mode_flag() {
        let loaded = load_builtins();
        for id in ["pomodoro", "stopwatch", "countdown"] {
            let plugin = loaded
                .iter()
                .find(|p| p.manifest.id == id)
                .unwrap_or_else(|| panic!("{} missing", id));
            assert!(
                plugin.manifest.timer_mode,
                "{} must set timer_mode:true so the tray and keyboard pick it up",
                id
            );
        }
        // session-log / stats are plugins but NOT timer modes.
        for id in ["session-log", "stats"] {
            let plugin = loaded
                .iter()
                .find(|p| p.manifest.id == id)
                .unwrap_or_else(|| panic!("{} missing", id));
            assert!(
                !plugin.manifest.timer_mode,
                "{} must not declare timer_mode",
                id
            );
        }
    }
}
