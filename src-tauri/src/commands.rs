use crate::cache::{
    self, CacheState, CachedSession, HeatmapCell, RangeStats, SessionDetail, TodayStats,
};
use crate::config::{self, Config};
use crate::plugins::{LoadedPlugin, PluginDescriptor};
use crate::storage;
use crate::timer::{Interval, TimerState, TimerStatus};
use chrono::Utc;
use rand::Rng;
use serde_json::{Map, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct EngineState(pub Mutex<TimerState>);
pub struct ConfigState(pub Mutex<Config>);
pub struct PluginRegistry(pub Mutex<Vec<LoadedPlugin>>);

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
    config: State<'_, ConfigState>,
    app: AppHandle,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    if state.status != TimerStatus::Idle {
        return Err("a session is already active".into());
    }
    let id = generate_id();
    let cfg = config.0.lock().map_err(|e| e.to_string())?;
    let interval = build_first_interval(&mode, &cfg);
    drop(cfg);
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
    config: State<'_, ConfigState>,
    app: AppHandle,
) -> Result<TimerState, String> {
    let mut state = engine.0.lock().map_err(|e| e.to_string())?;
    if state.status == TimerStatus::Idle {
        return Err("no active session".into());
    }
    let config = config.0.lock().map_err(|e| e.to_string())?;
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

#[tauri::command]
pub fn get_config(config: State<'_, ConfigState>) -> Result<Config, String> {
    let cfg = config.0.lock().map_err(|e| e.to_string())?;
    Ok(cfg.clone())
}

#[tauri::command]
pub fn update_config(
    new_config: Config,
    config: State<'_, ConfigState>,
) -> Result<Config, String> {
    let dir = storage::flint_dir()?;
    config::save(&dir, &new_config)?;
    let mut cfg = config.0.lock().map_err(|e| e.to_string())?;
    *cfg = new_config.clone();
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
) -> Result<(), String> {
    let mut cfg = config.0.lock().map_err(|e| e.to_string())?;
    cfg.plugins.enabled.insert(plugin_id, enabled);
    let dir = storage::flint_dir()?;
    config::save(&dir, &cfg)?;
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
    let full = serde_json::to_value(&*cfg).map_err(|e| e.to_string())?;
    drop(cfg);

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
    if key.is_empty() || key.contains('/') || key.contains('\\') || key.contains("..") {
        return Err(format!("invalid storage key: {}", key));
    }
    Ok(plugin_storage_dir(plugin_id)?.join(format!("{}.json", key)))
}

#[tauri::command]
pub fn plugin_storage_get(plugin_id: String, key: String) -> Result<Value, String> {
    let path = plugin_storage_key_path(&plugin_id, &key)?;
    if !path.exists() {
        return Ok(Value::Null);
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
pub fn rebuild_cache(cache_state: State<'_, CacheState>) -> Result<i64, String> {
    let mut guard = cache_state.0.lock().map_err(|e| e.to_string())?;
    let Some(conn) = guard.as_mut() else {
        return Err("cache not initialised".into());
    };
    cache::rebuild(conn)?;
    conn.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get::<_, i64>(0))
        .map_err(|e| e.to_string())
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
