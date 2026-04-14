use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    pub core: Core,
    pub appearance: Appearance,
    pub overlay: Overlay,
    pub keybindings: Keybindings,
    pub pomodoro: Pomodoro,
    pub tray: Tray,
    pub plugins: Plugins,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Core {
    pub default_mode: String,
    pub countdown_default_min: u32,
}

impl Default for Core {
    fn default() -> Self {
        Self {
            default_mode: "pomodoro".into(),
            countdown_default_min: 60,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Appearance {
    pub sidebar_visible: bool,
    pub sidebar_width: u32,
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            sidebar_visible: true,
            sidebar_width: 220,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Overlay {
    pub enabled: bool,
    pub position: String,
    pub opacity: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    pub always_visible: bool,
}

impl Default for Overlay {
    fn default() -> Self {
        Self {
            enabled: true,
            position: "top-right".into(),
            opacity: 0.95,
            x: None,
            y: None,
            always_visible: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Keybindings {
    pub toggle_sidebar: String,
    pub toggle_overlay: String,
    pub quick_tag: String,
}

impl Default for Keybindings {
    fn default() -> Self {
        Self {
            toggle_sidebar: "CommandOrControl+B".into(),
            toggle_overlay: "CommandOrControl+Shift+O".into(),
            quick_tag: "CommandOrControl+T".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Pomodoro {
    pub focus_min: u32,
    pub break_min: u32,
    pub long_break_min: u32,
    pub cycles_before_long: u32,
    pub auto_start_breaks: bool,
    pub auto_start_focus: bool,
}

impl Default for Pomodoro {
    fn default() -> Self {
        Self {
            focus_min: 25,
            break_min: 5,
            long_break_min: 15,
            cycles_before_long: 4,
            auto_start_breaks: true,
            auto_start_focus: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Tray {
    pub close_to_tray: bool,
    pub show_timer_in_tray: bool,
}

impl Default for Tray {
    fn default() -> Self {
        Self {
            close_to_tray: true,
            show_timer_in_tray: true,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Plugins {
    pub enabled: HashMap<String, bool>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            core: Core::default(),
            appearance: Appearance::default(),
            overlay: Overlay::default(),
            keybindings: Keybindings::default(),
            pomodoro: Pomodoro::default(),
            tray: Tray::default(),
            plugins: Plugins::default(),
        }
    }
}

pub fn save(flint_dir: &Path, cfg: &Config) -> Result<(), String> {
    let path = flint_dir.join("config.toml");
    let s = toml::to_string_pretty(cfg).map_err(|e| format!("serialize config: {}", e))?;
    fs::write(&path, s).map_err(|e| format!("write {}: {}", path.display(), e))
}

pub fn load_or_create(flint_dir: &Path) -> Config {
    let path = flint_dir.join("config.toml");
    if path.exists() {
        if let Ok(content) = fs::read_to_string(&path) {
            match toml::from_str::<Config>(&content) {
                Ok(cfg) => return cfg,
                Err(e) => {
                    eprintln!(
                        "[flint] config.toml parse error: {} — preserving broken file and using defaults",
                        e
                    );
                    // B-H4: rename the broken file before we overwrite it
                    // with defaults, so the user can inspect/restore their
                    // edits.
                    crate::storage::rename_broken(&path);
                }
            }
        }
    }
    let cfg = Config::default();
    match toml::to_string_pretty(&cfg) {
        Ok(s) => {
            if let Err(e) = fs::write(&path, s) {
                eprintln!("[flint] failed to write default config.toml: {}", e);
            }
        }
        Err(e) => eprintln!("[flint] failed to serialize default config: {}", e),
    }
    cfg
}
