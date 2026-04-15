use crate::cache::{
    self, CacheState, CachedSession, HeatmapCell, LifetimeTotals, RangeStats, SessionDetail,
    TodayStats,
};
use crate::config::{self, Config};
use crate::plugins::{LoadedPlugin, PluginDescriptor};
use crate::presets::{self, Preset, PresetDraft};
use crate::storage::{self, AppState};
use crate::tags::{self, TagIndex};
use crate::timer::{Interval, TimerState, TimerStatus};
use chrono::Utc;
use rand::Rng;
use serde_json::{Map, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

pub struct EngineState(pub Mutex<TimerState>);
pub struct ConfigState(pub Mutex<Config>);
pub struct PluginRegistry(pub Mutex<Vec<LoadedPlugin>>);
pub struct AppStateStore(pub Mutex<AppState>);

/// Session-scoped config overrides applied by presets. Lives for the
/// duration of the active session only; cleared on finalize_session. Never
/// written to config.toml — this is what makes presets safe to experiment
/// with.
#[derive(Debug, Clone)]
pub struct ActiveOverride {
    pub plugin_id: String,
    pub values: Map<String, Value>,
}

pub struct SessionOverridesState(pub Mutex<Option<ActiveOverride>>);

impl SessionOverridesState {
    pub fn new_empty() -> Self {
        Self(Mutex::new(None))
    }

    pub fn snapshot(&self) -> Option<ActiveOverride> {
        self.0.lock().ok().and_then(|g| g.clone())
    }
}

/// Clone the base config and merge any active session overrides into the
/// section owned by `plugin_id`. Used by `build_first_interval` and
/// `next_interval` so a running preset session honours the overridden
/// durations without ever touching config.toml.
fn merged_config(base: &Config, plugin_id: &str, overrides: Option<&ActiveOverride>) -> Config {
    let Some(ov) = overrides else {
        return base.clone();
    };
    if ov.plugin_id != plugin_id || ov.values.is_empty() {
        return base.clone();
    }
    let mut value = match serde_json::to_value(base) {
        Ok(v) => v,
        Err(_) => return base.clone(),
    };
    presets::apply_overrides_to_config(&mut value, plugin_id, &ov.values);
    serde_json::from_value(value).unwrap_or_else(|_| base.clone())
}

/// FIX 1: minimum gap between two consecutive interval transitions. Any
/// `next_interval` call that arrives inside this window after the last
/// successful transition is silently dropped. This is a hard safety net
/// against a plugin (or queued-up events after an alt-tab) firing
/// transitions faster than the user could possibly intend.
const INTERVAL_TRANSITION_COOLDOWN: Duration = Duration::from_millis(2000);

/// Convert a decimal-minute duration (as supplied by the Pomodoro plugin
/// config) into whole seconds for the engine. Clamped to 1 second minimum
/// so a hand-edited `focus_duration = 0` cannot livelock the tick loop.
fn minutes_to_sec(min: f64) -> u64 {
    let s = (min * 60.0).round();
    if s.is_finite() && s > 0.0 {
        (s as u64).max(1)
    } else {
        1
    }
}

fn generate_id() -> String {
    let n: u32 = rand::thread_rng().gen();
    format!("{:08x}", n)
}

fn build_first_interval(mode: &str, config: &Config) -> Interval {
    let target = match mode {
        "pomodoro" => Some(minutes_to_sec(config.pomodoro.focus_duration)),
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
    overrides: Option<Value>,
    engine: State<'_, EngineState>,
    config: State<'_, ConfigState>,
    recovery: State<'_, storage::RecoveryWriter>,
    session_overrides: State<'_, SessionOverridesState>,
    tag_index: State<'_, TagIndex>,
    app: AppHandle,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    if state.status != TimerStatus::Idle {
        return Err("a session is already active".into());
    }

    // Materialise the override payload (if any) into the shared state so
    // next_interval / get_plugin_config see it for the rest of the session.
    let override_map: Option<Map<String, Value>> = match overrides {
        Some(Value::Object(m)) => Some(m),
        _ => None,
    };
    let active_override = override_map.map(|values| ActiveOverride {
        plugin_id: mode.clone(),
        values,
    });
    if let Ok(mut guard) = session_overrides.0.lock() {
        *guard = active_override.clone();
    }

    // Push any new tags into the in-memory tag index so autocomplete picks
    // them up before the session even ends.
    tags::insert_many(&tag_index, &tags);

    let id = generate_id();
    let cfg = config.0.lock().map_err(|e| e.to_string())?;
    let merged = merged_config(&cfg, &mode, active_override.as_ref());
    drop(cfg);
    let interval = build_first_interval(&mode, &merged);
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

    recovery.send_state(&state);

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
    recovery: State<'_, storage::RecoveryWriter>,
    app: AppHandle,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    if state.status != TimerStatus::Running {
        return Err("not running".into());
    }
    state.status = TimerStatus::Paused;
    recovery.send_state(&state);
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
    recovery: State<'_, storage::RecoveryWriter>,
    app: AppHandle,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    if state.status != TimerStatus::Paused {
        return Err("not paused".into());
    }
    state.status = TimerStatus::Running;
    recovery.send_state(&state);
    app.emit(
        "session:resume",
        serde_json::json!({ "elapsed_sec": state.elapsed_sec }),
    )
    .ok();
    Ok(state.clone())
}

pub(crate) fn finalize_session(
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
    let ending_tags = state.tags.clone();

    let path = storage::write_session_file(state, ended_at, completed)?;
    println!("[flint] wrote session file {}", path.display());

    if let Ok(content) = std::fs::read_to_string(&path) {
        if let Ok(value) = serde_json::from_str::<Value>(&content) {
            let cache_state = app.state::<CacheState>();
            let guard_result = cache_state.0.lock();
            if let Ok(guard) = guard_result {
                if let Some(conn) = guard.as_ref() {
                    if let Err(e) = cache::upsert_from_file(conn, &value) {
                        eprintln!("[flint] cache upsert failed: {}", e);
                    }
                }
            }
        }
    }

    // Push the session's tags into the autocomplete index so the next idle
    // session sees them without waiting for a restart.
    tags::insert_many(&app.state::<TagIndex>(), &ending_tags);

    // Clear session-scoped preset overrides so the next session falls back
    // to the saved config.toml values.
    if let Ok(mut guard) = app.state::<SessionOverridesState>().0.lock() {
        *guard = None;
    }

    // Recovery deletion is funneled through the background writer so it
    // serialises with any in-flight snapshot (P-C1).
    app.state::<storage::RecoveryWriter>().delete();

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
    recovery: State<'_, storage::RecoveryWriter>,
    app: AppHandle,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    if state.status == TimerStatus::Idle {
        return Err("no active session".into());
    }
    state.questions_done += 1;
    recovery.send_state(&state);
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
    config: State<'_, ConfigState>,
    recovery: State<'_, storage::RecoveryWriter>,
    session_overrides: State<'_, SessionOverridesState>,
    app: AppHandle,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    if state.status == TimerStatus::Idle {
        return Err("no active session".into());
    }

    // FIX 1: hard rate limit. If the last interval transition happened less
    // than 2 seconds ago, silently accept the call without doing anything —
    // this prevents the Pomodoro plugin from stacking rapid-fire transitions
    // if events queue up during an alt-tab or under contention. Returning
    // Ok keeps the plugin's await-chain from blowing up; the UI is
    // unaffected because the state didn't change.
    let now = Instant::now();
    if let Some(last) = state.last_interval_transition_at {
        if now.duration_since(last) < INTERVAL_TRANSITION_COOLDOWN {
            eprintln!(
                "[flint] interval transition rate-limited, skipping (gap = {:?})",
                now.duration_since(last)
            );
            return Ok(state.clone());
        }
    }

    let overrides = session_overrides.snapshot();
    let cfg = config.0.lock().map_err(|e| e.to_string())?;
    let config = merged_config(&cfg, &state.mode, overrides.as_ref());
    drop(cfg);
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
                    config.pomodoro.long_break_duration
                } else {
                    config.pomodoro.break_duration
                };
                Interval {
                    interval_type: "break".into(),
                    start_sec: next_start_sec,
                    elapsed_sec: 0,
                    target_sec: Some(minutes_to_sec(target_min)),
                    ended_emitted: false,
                }
            } else {
                Interval {
                    interval_type: "focus".into(),
                    start_sec: next_start_sec,
                    elapsed_sec: 0,
                    target_sec: Some(minutes_to_sec(config.pomodoro.focus_duration)),
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
    state.last_interval_transition_at = Some(now);

    recovery.send_state(&state);

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
    recovery: State<'_, storage::RecoveryWriter>,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    if state.status == TimerStatus::Idle {
        return Err("no active session".into());
    }
    state.tags = tags;
    recovery.send_state(&state);
    Ok(state.clone())
}

#[tauri::command]
pub fn get_config(config: State<'_, ConfigState>) -> Result<Config, String> {
    let cfg = config.0.lock().map_err(|e| e.to_string())?;
    Ok(cfg.clone())
}

#[tauri::command]
pub fn update_config(
    new_config: Config,
    config: State<'_, ConfigState>,
    app: AppHandle,
) -> Result<Config, String> {
    let dir = storage::flint_dir()?;
    config::save(&dir, &new_config)?;
    let mut cfg = config.0.lock().map_err(|e| e.to_string())?;
    *cfg = new_config.clone();
    // O-H3: live-apply overlay opacity/position — no restart needed.
    let overlay_cfg = cfg.overlay.clone();
    drop(cfg);
    crate::overlay::apply_overlay_config(&app, &overlay_cfg);
    Ok(new_config)
}

#[tauri::command]
pub fn get_flint_dir() -> Result<String, String> {
    storage::flint_dir().map(|p| p.display().to_string())
}

fn plugin_is_enabled(cfg: &Config, id: &str, builtin: bool) -> bool {
    cfg.plugins
        .enabled
        .get(id)
        .copied()
        .unwrap_or(builtin)
}

#[tauri::command]
pub fn list_plugins(
    registry: State<'_, PluginRegistry>,
    config: State<'_, ConfigState>,
) -> Result<Vec<PluginDescriptor>, String> {
    let plugins = registry.0.lock().map_err(|e| e.to_string())?;
    let cfg = config.0.lock().map_err(|e| e.to_string())?;
    let list = plugins
        .iter()
        .map(|p| PluginDescriptor {
            manifest: p.manifest.clone(),
            source: p.source.clone(),
            enabled: plugin_is_enabled(&cfg, &p.manifest.id, p.builtin),
            builtin: p.builtin,
        })
        .collect();
    Ok(list)
}

#[tauri::command]
pub fn set_plugin_enabled(
    plugin_id: String,
    enabled: bool,
    config: State<'_, ConfigState>,
    app: AppHandle,
) -> Result<(), String> {
    let mut cfg = config.0.lock().map_err(|e| e.to_string())?;
    cfg.plugins.enabled.insert(plugin_id, enabled);
    let dir = storage::flint_dir()?;
    config::save(&dir, &cfg)?;
    drop(cfg);
    // Rebuild the tray menu so any newly enabled/disabled timer-mode plugin
    // shows up (or disappears) in the right-click menu without a restart.
    if let Err(e) = crate::tray::rebuild_menu(&app) {
        eprintln!("[flint] tray rebuild after plugin toggle failed: {}", e);
    }
    Ok(())
}

fn resolve_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = value;
    for part in path.split('.') {
        cur = cur.get(part)?;
    }
    Some(cur)
}

fn set_path(value: &mut Value, path: &str, new_val: Value) -> Result<(), String> {
    let parts: Vec<&str> = path.split('.').collect();
    let mut cur = value;
    for (i, part) in parts.iter().enumerate() {
        if i == parts.len() - 1 {
            if let Value::Object(map) = cur {
                map.insert((*part).to_string(), new_val);
                return Ok(());
            }
            return Err(format!("path {} segment {} is not an object", path, part));
        }
        cur = cur
            .get_mut(*part)
            .ok_or_else(|| format!("path {} missing segment {}", path, part))?;
    }
    Err(format!("path {} is empty", path))
}

#[tauri::command]
pub fn get_plugin_config(
    plugin_id: String,
    registry: State<'_, PluginRegistry>,
    config: State<'_, ConfigState>,
    session_overrides: State<'_, SessionOverridesState>,
) -> Result<Value, String> {
    let plugins = registry.0.lock().map_err(|e| e.to_string())?;
    let plugin = plugins
        .iter()
        .find(|p| p.manifest.id == plugin_id)
        .ok_or_else(|| format!("unknown plugin: {}", plugin_id))?;
    let schema_keys: Vec<String> = plugin.manifest.config_schema.keys().cloned().collect();
    let section = plugin.manifest.config_section.clone();
    drop(plugins);

    let cfg = config.0.lock().map_err(|e| e.to_string())?;
    let mut full = serde_json::to_value(&*cfg).map_err(|e| e.to_string())?;
    drop(cfg);

    // Merge any active session overrides for this plugin so getConfig()
    // returns the effective values while a preset session is running. The
    // overrides never persist — they disappear when finalize_session
    // clears SessionOverridesState.
    if let Some(active) = session_overrides.snapshot() {
        if active.plugin_id == plugin_id {
            presets::apply_overrides_to_config(&mut full, &plugin_id, &active.values);
        }
    }

    let section_value = match section {
        Some(s) => resolve_path(&full, &s).cloned().unwrap_or(Value::Null),
        None => Value::Null,
    };

    let mut out = Map::new();
    if let Value::Object(section_obj) = section_value {
        for key in schema_keys {
            if let Some(v) = section_obj.get(&key) {
                out.insert(key, v.clone());
            }
        }
    }
    Ok(Value::Object(out))
}

#[tauri::command]
pub fn set_plugin_config(
    plugin_id: String,
    key: String,
    value: Value,
    registry: State<'_, PluginRegistry>,
    config: State<'_, ConfigState>,
) -> Result<Value, String> {
    let plugins = registry.0.lock().map_err(|e| e.to_string())?;
    let plugin = plugins
        .iter()
        .find(|p| p.manifest.id == plugin_id)
        .ok_or_else(|| format!("unknown plugin: {}", plugin_id))?;
    if !plugin.manifest.config_schema.contains_key(&key) {
        return Err(format!(
            "key '{}' not in config schema for plugin '{}'",
            key, plugin_id
        ));
    }
    let section = plugin
        .manifest
        .config_section
        .clone()
        .ok_or_else(|| format!("plugin '{}' has no config_section", plugin_id))?;
    drop(plugins);

    let mut cfg = config.0.lock().map_err(|e| e.to_string())?;
    let mut full = serde_json::to_value(&*cfg).map_err(|e| e.to_string())?;
    set_path(&mut full, &format!("{}.{}", section, key), value.clone())?;
    let new_cfg: Config = serde_json::from_value(full).map_err(|e| e.to_string())?;
    *cfg = new_cfg.clone();

    let dir = storage::flint_dir()?;
    config::save(&dir, &cfg)?;
    Ok(value)
}

/// S-H2: hard cap on plugin storage file size. A runaway plugin (malicious
/// or buggy) cannot OOM the Tauri backend by stuffing arbitrary blobs into
/// its storage directory. 5 MB is well above any legitimate plugin need and
/// small enough to always fit in RAM.
const PLUGIN_STORAGE_MAX_BYTES: u64 = 5 * 1024 * 1024;

const STORAGE_KEY_ERROR: &str =
    "Storage key must contain only letters, numbers, underscores, hyphens, and dots";

/// S-H1: strict validation for the filename component of a plugin storage
/// key. Accepts only `[A-Za-z0-9_.-]+` and rejects Windows reserved device
/// names case-insensitively, with or without extension (`CON`, `CON.txt`,
/// `NUL`, `COM0`..`COM9`, `LPT0`..`LPT9`, etc). Without this, a plugin
/// could call `flint.storage.set("CON", …)` and `fs::write` would fail with
/// an opaque Windows error; worse, names containing `:` or `*` would pass
/// the old blocklist and still crash.
fn validate_storage_key(key: &str) -> Result<(), String> {
    if key.is_empty() {
        return Err(STORAGE_KEY_ERROR.into());
    }
    if !key
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return Err(STORAGE_KEY_ERROR.into());
    }
    let stem = key.split('.').next().unwrap_or(key).to_ascii_uppercase();
    const RESERVED: &[&str] = &["CON", "PRN", "AUX", "NUL"];
    if RESERVED.contains(&stem.as_str()) {
        return Err(STORAGE_KEY_ERROR.into());
    }
    if stem.len() == 4 {
        let mut chars = stem.chars();
        let a = chars.next();
        let b = chars.next();
        let c = chars.next();
        let d = chars.next();
        if let (Some(a), Some(b), Some(c), Some(d)) = (a, b, c, d) {
            let is_com_or_lpt =
                (a == 'C' && b == 'O' && c == 'M') || (a == 'L' && b == 'P' && c == 'T');
            if is_com_or_lpt && d.is_ascii_digit() {
                return Err(STORAGE_KEY_ERROR.into());
            }
        }
    }
    Ok(())
}

fn plugin_storage_dir(plugin_id: &str) -> Result<std::path::PathBuf, String> {
    if plugin_id.is_empty()
        || plugin_id.contains('/')
        || plugin_id.contains('\\')
        || plugin_id.contains("..")
    {
        return Err(format!("invalid plugin id: {}", plugin_id));
    }
    let dir = storage::flint_dir()?
        .join("plugins")
        .join(plugin_id)
        .join("data");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {}", dir.display(), e))?;
    Ok(dir)
}

fn plugin_storage_key_path(
    plugin_id: &str,
    key: &str,
) -> Result<std::path::PathBuf, String> {
    validate_storage_key(key)?;
    Ok(plugin_storage_dir(plugin_id)?.join(format!("{}.json", key)))
}

#[tauri::command]
pub fn plugin_storage_get(plugin_id: String, key: String) -> Result<Value, String> {
    let path = plugin_storage_key_path(&plugin_id, &key)?;
    if !path.exists() {
        return Ok(Value::Null);
    }
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.len() > PLUGIN_STORAGE_MAX_BYTES {
        return Err("Storage value exceeds 5 MB limit".into());
    }
    let data = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_storage_set(
    plugin_id: String,
    key: String,
    value: Value,
) -> Result<(), String> {
    let path = plugin_storage_key_path(&plugin_id, &key)?;
    let data = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    if data.len() as u64 > PLUGIN_STORAGE_MAX_BYTES {
        return Err("Storage value exceeds 5 MB limit".into());
    }
    std::fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_storage_delete(plugin_id: String, key: String) -> Result<(), String> {
    let path = plugin_storage_key_path(&plugin_id, &key)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_sessions(cache_state: State<'_, CacheState>) -> Result<Vec<Value>, String> {
    // The plugin API uses this via flint.getSessions(); return full JSON
    // payloads (with intervals) by reading from the cache.
    let guard = cache_state.0.lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Ok(Vec::new());
    };
    let sessions = cache::list_sessions(conn, None)?;
    let mut out: Vec<Value> = Vec::with_capacity(sessions.len());
    for s in sessions {
        if let Some(detail) = cache::get_session_detail(conn, &s.id)? {
            out.push(serde_json::to_value(detail).unwrap_or(Value::Null));
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn cache_list_sessions(
    cache_state: State<'_, CacheState>,
    limit: Option<i64>,
) -> Result<Vec<CachedSession>, String> {
    let guard = cache_state.0.lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Ok(Vec::new());
    };
    cache::list_sessions(conn, limit)
}

#[tauri::command]
pub fn cache_session_detail(
    cache_state: State<'_, CacheState>,
    id: String,
) -> Result<Option<SessionDetail>, String> {
    let guard = cache_state.0.lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Ok(None);
    };
    cache::get_session_detail(conn, &id)
}

#[tauri::command]
pub fn stats_today(cache_state: State<'_, CacheState>) -> Result<TodayStats, String> {
    let guard = cache_state.0.lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Ok(TodayStats {
            focus_sec: 0,
            session_count: 0,
            questions_done: 0,
        });
    };
    cache::today_stats(conn, Utc::now())
}

#[tauri::command]
pub fn stats_range(
    cache_state: State<'_, CacheState>,
    scope: String,
) -> Result<RangeStats, String> {
    let guard = cache_state.0.lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Ok(RangeStats {
            total_focus_sec: 0,
            total_sessions: 0,
            total_questions: 0,
            current_streak: 0,
            longest_streak: 0,
            daily: Vec::new(),
            tags: Vec::new(),
        });
    };
    let now = Utc::now();
    let (start, end) = match scope.as_str() {
        "week" => cache::week_range(now),
        "month" => cache::month_range(now),
        other => return Err(format!("unknown scope: {}", other)),
    };
    cache::range_stats(conn, start, end)
}

#[tauri::command]
pub fn stats_heatmap(
    cache_state: State<'_, CacheState>,
    days: Option<i64>,
) -> Result<Vec<HeatmapCell>, String> {
    let guard = cache_state.0.lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Ok(Vec::new());
    };
    let n = days.unwrap_or(182).clamp(7, 730);
    cache::heatmap(conn, n)
}

#[tauri::command]
pub fn stats_lifetime(cache_state: State<'_, CacheState>) -> Result<LifetimeTotals, String> {
    let guard = cache_state.0.lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_ref() else {
        return Ok(LifetimeTotals {
            longest_session_sec: 0,
            best_day_date: None,
            best_day_focus_sec: 0,
            all_time_focus_sec: 0,
        });
    };
    cache::lifetime_totals(conn)
}

#[tauri::command]
pub fn rebuild_cache(cache_state: State<'_, CacheState>) -> Result<i64, String> {
    let mut guard = cache_state.0.lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_mut() else {
        return Err("cache not initialised".into());
    };
    cache::rebuild(conn)?;
    conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_app_state(state: State<'_, AppStateStore>) -> Result<AppState, String> {
    let s = state.0.lock().map_err(|e| e.to_string())?;
    Ok(s.clone())
}

#[tauri::command]
pub fn mark_first_close_shown(state: State<'_, AppStateStore>) -> Result<(), String> {
    let mut s = state.0.lock().map_err(|e| e.to_string())?;
    if s.first_close_toast_shown {
        return Ok(());
    }
    s.first_close_toast_shown = true;
    storage::save_app_state(&s)
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Shared shutdown logic used by both Ctrl+Q (`quit_app`) and the tray "Quit
/// Flint" menu entry (`tray::quit_from_tray`). Finalises any running session
/// as cancelled (S-C3 / C-H1), tears the overlay down before the main window
/// (Win32 ordering), and flushes any pending recovery writes (P-C1) so the
/// state on disk reflects what just happened. Caller is responsible for
/// `app.exit(0)`.
pub fn shutdown_with_finalize(app: &AppHandle) {
    if let Ok(mut state) = app.state::<EngineState>().0.lock() {
        if state.status != TimerStatus::Idle {
            if let Err(e) = finalize_session(&mut state, app, false) {
                eprintln!("[flint] finalize session on quit failed: {}", e);
            }
        }
    }
    // Block until any queued snapshot/delete has hit disk so the recovery
    // file reflects the post-finalize state when the next launch reads it.
    app.state::<storage::RecoveryWriter>().flush_blocking();
    crate::overlay::close_overlay_if_open(app);
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    shutdown_with_finalize(&app);
    app.exit(0);
}

/// PR-H3: open the user's ~/.flint/ directory in the system file explorer.
/// Uses the platform-native command (explorer on Windows, open on macOS,
/// xdg-open on Linux) — a tiny shell-out avoids pulling in the full
/// tauri-plugin-opener dependency for a single button.
#[tauri::command]
pub fn open_data_folder() -> Result<(), String> {
    let dir = storage::flint_dir()?;
    open_path_in_explorer(&dir)
}

#[cfg(target_os = "windows")]
fn open_path_in_explorer(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("explorer")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("explorer: {}", e))
}

#[cfg(target_os = "macos")]
fn open_path_in_explorer(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open: {}", e))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_path_in_explorer(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("xdg-open: {}", e))
}

/// PR-H3: export every JSON session file under ~/.flint/sessions/ as a
/// single combined JSON array, written atomically to ~/.flint/exports/.
/// Returns the final path so the UI can surface it in a success toast.
/// Kept self-contained (no dialog plugin) to match the local-first,
/// minimal-dep ethos — the user can reveal the export via "Open data folder".
#[tauri::command]
pub fn export_all_sessions() -> Result<String, String> {
    let root = storage::flint_dir()?;
    let exports_dir = root.join("exports");
    std::fs::create_dir_all(&exports_dir)
        .map_err(|e| format!("create {}: {}", exports_dir.display(), e))?;

    let sessions_dir = root.join("sessions");
    let mut all_sessions: Vec<Value> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&sessions_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            match std::fs::read_to_string(&path) {
                Ok(content) => match serde_json::from_str::<Value>(&content) {
                    Ok(value) => all_sessions.push(value),
                    Err(e) => eprintln!(
                        "[flint] skip malformed session {}: {}",
                        path.display(),
                        e
                    ),
                },
                Err(e) => eprintln!("[flint] read {}: {}", path.display(), e),
            }
        }
    }

    // Sort by started_at so the export is deterministic regardless of the
    // order the filesystem walks returned files.
    all_sessions.sort_by(|a, b| {
        let ak = a.get("started_at").and_then(|v| v.as_str()).unwrap_or("");
        let bk = b.get("started_at").and_then(|v| v.as_str()).unwrap_or("");
        ak.cmp(bk)
    });

    let ts = Utc::now().format("%Y-%m-%d_%H%M%S");
    let out_path = exports_dir.join(format!("flint_sessions_{}.json", ts));
    let json = serde_json::to_string_pretty(&all_sessions).map_err(|e| e.to_string())?;
    storage::write_atomic(&out_path, json.as_bytes())?;
    Ok(out_path.display().to_string())
}

// ============================================================================
// PRESET CRUD
// ============================================================================

#[tauri::command]
pub fn list_presets() -> Result<Vec<Preset>, String> {
    presets::list_all()
}

#[tauri::command]
pub fn save_preset(preset: PresetDraft) -> Result<Preset, String> {
    presets::save(preset)
}

#[tauri::command]
pub fn delete_preset(id: String) -> Result<(), String> {
    presets::delete(&id)
}

#[tauri::command]
pub fn load_preset(id: String) -> Result<Preset, String> {
    presets::load(&id)
}

#[tauri::command]
pub fn touch_preset(id: String) -> Result<(), String> {
    presets::touch(&id)
}

// ============================================================================
// TAG INDEX
// ============================================================================

#[tauri::command]
pub fn get_known_tags(tag_index: State<'_, TagIndex>) -> Result<Vec<String>, String> {
    Ok(tags::snapshot(&tag_index))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolve_nested_path() {
        let v = json!({
            "pomodoro": { "focus_min": 25, "break_min": 5 },
            "core": { "default_mode": "pomodoro" }
        });
        assert_eq!(
            resolve_path(&v, "pomodoro.focus_min"),
            Some(&json!(25))
        );
        assert_eq!(
            resolve_path(&v, "core.default_mode"),
            Some(&json!("pomodoro"))
        );
        assert_eq!(resolve_path(&v, "pomodoro.missing"), None);
    }

    #[test]
    fn set_nested_path() {
        let mut v = json!({
            "pomodoro": { "focus_min": 25 }
        });
        set_path(&mut v, "pomodoro.focus_min", json!(45)).unwrap();
        assert_eq!(v["pomodoro"]["focus_min"], json!(45));
    }

    #[test]
    fn set_path_rejects_missing_segment() {
        let mut v = json!({ "pomodoro": { "focus_min": 25 } });
        let result = set_path(&mut v, "unknown.key", json!(1));
        assert!(result.is_err());
    }
}
