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
    #[serde(default)]
    pub config_schema: HashMap<String, ConfigSchemaField>,
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
        let entry_path = path.join(&manifest.entry);
        let source = match fs::read_to_string(&entry_path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[flint] read {}: {}", entry_path.display(), e);
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
        for p in &loaded {
            assert_eq!(p.manifest.plugin_type, "default");
            assert!(!p.source.is_empty(), "{} source empty", p.manifest.id);
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
}
