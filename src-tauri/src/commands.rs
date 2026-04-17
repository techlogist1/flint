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
use serde::{Deserialize, Serialize};
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

/// [C-2 / T1-A] An interval authored by a plugin via `set_first_interval` or
/// `set_next_interval`. The Rust engine consumes (takes) it the next time it
/// builds an interval. Slots are session-scoped: cleared on session start
/// (any stale `first` from an aborted prior attempt) and on finalize (any
/// unconsumed `next`). The metadata field is opaque to core — plugins put
/// whatever they need (section name, exam id, etc.) and read it back via
/// session events.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingInterval {
    pub interval_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_sec: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Value>,
}

/// Holds the two pending interval slots a plugin can set: `first` (consumed
/// by `start_session` on its very next call) and `next` (consumed by the next
/// `next_interval` transition). A single inner Mutex guards both slots so
/// `clear_all` is atomic — a concurrent `set_next` cannot race in between
/// clearing `first` and clearing `next` during `finalize_session`.
pub struct PendingIntervalState {
    inner: Mutex<(Option<PendingInterval>, Option<PendingInterval>)>,
}

impl PendingIntervalState {
    pub fn new_empty() -> Self {
        Self {
            inner: Mutex::new((None, None)),
        }
    }

    pub fn set_first(&self, p: PendingInterval) {
        if let Ok(mut g) = self.inner.lock() {
            g.0 = Some(p);
        }
    }

    pub fn set_next(&self, p: PendingInterval) {
        if let Ok(mut g) = self.inner.lock() {
            g.1 = Some(p);
        }
    }

    pub fn take_first(&self) -> Option<PendingInterval> {
        self.inner.lock().ok().and_then(|mut g| g.0.take())
    }

    pub fn take_next(&self) -> Option<PendingInterval> {
        self.inner.lock().ok().and_then(|mut g| g.1.take())
    }

    /// Clear both slots atomically. Called from `finalize_session` so a
    /// concurrent plugin write cannot leak a pending interval into the next
    /// session.
    pub fn clear_all(&self) {
        if let Ok(mut g) = self.inner.lock() {
            g.0 = None;
            g.1 = None;
        }
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
    // [M-13]: 64-bit hex IDs. With 32-bit IDs the birthday paradox produces a
    // collision after ~65k sessions; a power user at 200/day hits that in
    // ~10 months. 64 bits gives ~4 billion-fold more headroom and is still a
    // single-word format we can embed in the session filename.
    let n: u64 = rand::thread_rng().gen();
    format!("{:016x}", n)
}

/// Build the first interval for a session.
///
/// Resolution order (priority high → low):
/// 1. `pending` — a plugin-authored interval set via `set_first_interval`.
///    Highest priority so a custom timer mode can fully drive its own
///    interval logic without touching the hardcoded fallbacks below.
/// 2. The mode-specific hardcoded math (pomodoro / countdown) using the
///    merged config (which already incorporates any preset session overrides
///    via `merged_config`). Pure backward-compat path so an unmodified
///    pomodoro plugin keeps cycling correctly even when no plugin has wired
///    the new API yet.
///
/// This function is a pure helper (no Tauri state) so it is unit-testable.
fn build_first_interval(
    mode: &str,
    config: &Config,
    pending: Option<PendingInterval>,
) -> Interval {
    if let Some(p) = pending {
        return pending_to_interval(p, 0);
    }
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

fn pending_to_interval(p: PendingInterval, start_sec: u64) -> Interval {
    Interval {
        interval_type: p.interval_type,
        start_sec,
        elapsed_sec: 0,
        target_sec: p.target_sec,
        ended_emitted: false,
    }
}

/// Build the next interval for an active session.
///
/// Resolution order (priority high → low) mirrors `build_first_interval`:
/// 1. `pending` — a plugin-authored interval set via `set_next_interval`.
/// 2. The mode-specific hardcoded math:
///    - `pomodoro` → focus / break / long break cycling, using the merged
///      config so preset overrides are honoured.
///    - any other mode → an untimed focus interval (existing pre-T1-A
///      behaviour, kept for backward compat).
///
/// Pure helper — no Tauri state — so it is unit-testable. `start_sec` of the
/// new interval is supplied by the caller (it is the running elapsed-second
/// at which the previous interval ended).
fn build_next_interval(
    mode: &str,
    config: &Config,
    completed_intervals: &[Interval],
    ended_type: &str,
    next_start_sec: u64,
    pending: Option<PendingInterval>,
) -> Interval {
    if let Some(p) = pending {
        return pending_to_interval(p, next_start_sec);
    }
    match mode {
        "pomodoro" => {
            if ended_type == "focus" {
                let focus_count = completed_intervals
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
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri State injection — each State is a separate parameter
pub fn start_session(
    mode: String,
    tags: Vec<String>,
    overrides: Option<Value>,
    engine: State<'_, EngineState>,
    config: State<'_, ConfigState>,
    recovery: State<'_, storage::RecoveryWriter>,
    session_overrides: State<'_, SessionOverridesState>,
    pending_intervals: State<'_, PendingIntervalState>,
    tag_index: State<'_, TagIndex>,
    app: AppHandle,
) -> Result<TimerState, String> {
    // [T1-A] Always take the pending first-interval, even on the early-error
    // paths below. This guarantees a stale `set_first_interval` from an
    // aborted prior attempt does not leak into the next start.
    let pending_first = pending_intervals.take_first();

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
    // [T1-A] Pending takes precedence over the merged (override-aware) config,
    // which in turn takes precedence over the base config. Order: pending >
    // override > hardcoded.
    let interval = build_first_interval(&mode, &merged, pending_first);
    let it_type = interval.interval_type.clone();
    let it_target = interval.target_sec;

    state.session_id = Some(id.clone());
    state.started_at = Some(Utc::now());
    state.status = TimerStatus::Running;
    state.elapsed_sec = 0;
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

    // [T1-A] Drop any unconsumed pending intervals so a `set_next_interval`
    // that arrived after the user pressed Stop does not bleed into whatever
    // session starts next.
    app.state::<PendingIntervalState>().clear_all();

    // Recovery deletion is funneled through the background writer so it
    // serialises with any in-flight snapshot (P-C1).
    app.state::<storage::RecoveryWriter>().delete();

    let event = if completed {
        "session:complete"
    } else {
        "session:cancel"
    };
    let payload = serde_json::json!({
        "session_id": session_id,
        "duration_sec": duration_sec,
    });
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
    pending_intervals: State<'_, PendingIntervalState>,
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
    // unaffected because the state didn't change. NOTE: a rate-limited call
    // intentionally does NOT consume `pending_next`, so a plugin that set a
    // pending and then rapid-fires `next_interval` will still see the pending
    // honoured on the next call past the cooldown.
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

    // [T1-A] Take the pending next-interval AFTER the rate-limit check so a
    // dropped call does not eat the pending. Pending takes precedence over
    // override which takes precedence over hardcoded mode logic.
    let pending_next = pending_intervals.take_next();

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

    let next = build_next_interval(
        &state.mode,
        &config,
        &state.completed_intervals,
        &ended_type,
        next_start_sec,
        pending_next,
    );

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

/// [T1-A] Author the FIRST interval of the next session. Plugins call this
/// just before invoking `start_session` to declare what shape of interval
/// they want — type, target seconds, and arbitrary metadata. The pending
/// interval is consumed exactly once on the next `start_session` (taken,
/// not cloned). If the plugin sets a pending then calls `start_session` and
/// it errors, the pending is still cleared so a stale slot does not leak.
///
/// JS callers: `invoke("set_first_interval", { intervalType, targetSec, metadata })`
/// (Tauri auto-converts camelCase ↔ snake_case at the IPC boundary).
#[tauri::command]
pub fn set_first_interval(
    interval_type: String,
    target_sec: Option<u64>,
    metadata: Option<Value>,
    pending_intervals: State<'_, PendingIntervalState>,
) -> Result<(), String> {
    pending_intervals.set_first(PendingInterval {
        interval_type,
        target_sec,
        metadata,
    });
    Ok(())
}

/// [T1-A] Author the NEXT interval transition for an active session. Plugins
/// call this from a `session:tick` or `interval:end` handler just before
/// invoking `next_interval`, or pre-emptively to set the shape of the next
/// transition. The pending is consumed exactly once on the next successful
/// `next_interval` call (rate-limited drops do not eat the pending) and
/// `finalize_session` clears any unconsumed pending so it cannot leak into
/// the next session.
///
/// JS callers: `invoke("set_next_interval", { intervalType, targetSec, metadata })`.
#[tauri::command]
pub fn set_next_interval(
    interval_type: String,
    target_sec: Option<u64>,
    metadata: Option<Value>,
    pending_intervals: State<'_, PendingIntervalState>,
) -> Result<(), String> {
    pending_intervals.set_next(PendingInterval {
        interval_type,
        target_sec,
        metadata,
    });
    Ok(())
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
    // [H-1]: route plugin storage writes through `storage::write_atomic` so a
    // crash mid-write leaves either the previous file or the new file intact
    // — never a truncated half-write. Same atomic-write policy as sessions,
    // recovery, presets, state.json and exports.
    storage::write_atomic(&path, data.as_bytes())
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
                    Ok(mut value) => {
                        storage::migrate_session_json(&mut value);
                        all_sessions.push(value);
                    }
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

/// Validate a session id for path-safety before we use it to touch a file.
/// Rejects empty strings, anything containing `/`, `\`, or `..`, and any
/// character outside the ASCII alphanum / `_` / `-` class. Extracted from
/// `delete_session` so we can unit-test the predicate without spinning up
/// Tauri state.
fn validate_session_id(id: &str) -> Result<(), String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("session id must not be empty".into());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.contains("..") {
        return Err(format!("invalid session id: {}", trimmed));
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("invalid session id: {}", trimmed));
    }
    Ok(())
}

/// Delete a single session: removes the JSON source-of-truth file from
/// `~/.flint/sessions/` and drops the matching row from the SQLite cache.
/// The frontend passes the session `id` (the short hex token embedded in
/// the filename and stored as `.id` inside the JSON). We validate the id
/// is a plain ascii-alphanum / `_` / `-` token with no path separators or
/// `..` sequences so a compromised plugin cannot use this command to escape
/// the sessions directory and delete arbitrary files.
#[tauri::command]
pub fn delete_session(
    id: String,
    cache_state: State<'_, CacheState>,
) -> Result<(), String> {
    validate_session_id(&id)?;
    let trimmed = id.trim();

    let sessions_dir = storage::flint_dir()?.join("sessions");
    let entries = std::fs::read_dir(&sessions_dir)
        .map_err(|e| format!("read {}: {}", sessions_dir.display(), e))?;

    let mut target: Option<std::path::PathBuf> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&content) else {
            continue;
        };
        if value.get("id").and_then(|v| v.as_str()) == Some(trimmed) {
            target = Some(path);
            break;
        }
    }

    let Some(path) = target else {
        return Err(format!("session {} not found", trimmed));
    };

    // Canonicalise both sides and verify the match stays inside sessions_dir
    // — a belt-and-braces check against symlink shenanigans.
    let canon_file = std::fs::canonicalize(&path)
        .map_err(|e| format!("canonicalize {}: {}", path.display(), e))?;
    let canon_dir = std::fs::canonicalize(&sessions_dir)
        .map_err(|e| format!("canonicalize {}: {}", sessions_dir.display(), e))?;
    if !canon_file.starts_with(&canon_dir) {
        return Err(format!("session {} is outside sessions dir", trimmed));
    }

    std::fs::remove_file(&path)
        .map_err(|e| format!("delete session {}: {}", trimmed, e))?;

    let guard = cache_state.0.lock().map_err(|e| e.to_string())?;
    if let Some(conn) = guard.as_ref() {
        cache::delete_by_id(conn, trimmed)?;
    }

    Ok(())
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

    #[test]
    fn validate_session_id_accepts_hex_tokens() {
        assert!(validate_session_id("deadbeef").is_ok());
        assert!(validate_session_id("a1b2c3d4").is_ok());
        assert!(validate_session_id("abc-123_xyz").is_ok());
    }

    #[test]
    fn validate_session_id_rejects_path_traversal() {
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id("   ").is_err());
        assert!(validate_session_id("../etc/passwd").is_err());
        assert!(validate_session_id("..").is_err());
        assert!(validate_session_id("foo/bar").is_err());
        assert!(validate_session_id("foo\\bar").is_err());
        assert!(validate_session_id("foo..bar").is_err());
        assert!(validate_session_id("foo bar").is_err());
        assert!(validate_session_id("foo.json").is_err());
    }

    // [M-13] generate_id must produce 16-hex-char (64-bit) tokens — anything
    // shorter falls back to the previous 32-bit format and re-introduces the
    // birthday-paradox collision risk after ~65k sessions.
    #[test]
    fn generate_id_is_16_hex_chars() {
        for _ in 0..10 {
            let id = generate_id();
            assert_eq!(id.len(), 16, "expected 16 chars, got {} ({})", id.len(), id);
            assert!(
                id.chars().all(|c| c.is_ascii_hexdigit()),
                "expected hex chars only, got {}",
                id
            );
        }
    }

    // [T1-A] When no plugin has set a pending first interval, an unmodified
    // pomodoro mode must still produce a focus interval with the expected
    // hardcoded target. Backward-compat regression guard.
    #[test]
    fn build_first_interval_pomodoro_fallback() {
        let cfg = Config::default();
        let interval = build_first_interval("pomodoro", &cfg, None);
        assert_eq!(interval.interval_type, "focus");
        assert_eq!(interval.start_sec, 0);
        assert_eq!(interval.elapsed_sec, 0);
        // Default focus_duration is 25 minutes → 1500 seconds.
        assert_eq!(interval.target_sec, Some(1500));
    }

    // [T1-A] When no plugin has set a pending first interval, an unmodified
    // countdown mode must still pull from `core.countdown_default_min`.
    #[test]
    fn build_first_interval_countdown_fallback() {
        let cfg = Config::default();
        let interval = build_first_interval("countdown", &cfg, None);
        assert_eq!(interval.interval_type, "focus");
        // Default countdown_default_min is 60 → 3600 seconds.
        assert_eq!(interval.target_sec, Some(3600));
    }

    // [T1-A] An unmodified non-pomodoro / non-countdown mode (e.g. stopwatch
    // or any community mode) must produce an untimed focus interval — the
    // plugin is expected to drive its own intervals via the new API.
    #[test]
    fn build_first_interval_unknown_mode_is_untimed_without_pending() {
        let cfg = Config::default();
        let interval = build_first_interval("stopwatch", &cfg, None);
        assert_eq!(interval.interval_type, "focus");
        assert_eq!(interval.target_sec, None);
    }

    // [T1-A] When a pending first-interval is supplied, it MUST take
    // precedence over the hardcoded mode logic — even for pomodoro. This is
    // the central contract of the new plugin-driven engine.
    #[test]
    fn build_first_interval_pending_overrides_pomodoro() {
        let cfg = Config::default();
        let pending = PendingInterval {
            interval_type: "exam-section".into(),
            target_sec: Some(3600),
            metadata: Some(serde_json::json!({ "section": "physics" })),
        };
        let interval = build_first_interval("pomodoro", &cfg, Some(pending));
        assert_eq!(interval.interval_type, "exam-section");
        assert_eq!(interval.target_sec, Some(3600));
        assert_eq!(interval.start_sec, 0);
        assert_eq!(interval.elapsed_sec, 0);
    }

    // [T1-A] When a pending first-interval is supplied for an unknown mode,
    // it gives that mode a real target instead of the previous untimed
    // fallback — this is what unblocks custom timer modes (Exam Mode, etc.).
    #[test]
    fn build_first_interval_pending_unlocks_custom_mode() {
        let cfg = Config::default();
        let pending = PendingInterval {
            interval_type: "section".into(),
            target_sec: Some(120),
            metadata: None,
        };
        let interval = build_first_interval("exam-mode", &cfg, Some(pending));
        assert_eq!(interval.interval_type, "section");
        assert_eq!(interval.target_sec, Some(120));
    }

    // [T1-A] PendingIntervalState::take_first must consume (take, not clone)
    // — calling it twice in a row returns Some, then None.
    #[test]
    fn pending_interval_state_take_first_consumes() {
        let state = PendingIntervalState::new_empty();
        state.set_first(PendingInterval {
            interval_type: "focus".into(),
            target_sec: Some(60),
            metadata: None,
        });
        let first = state.take_first();
        assert!(first.is_some());
        assert_eq!(first.unwrap().target_sec, Some(60));
        // Second take returns None — slot was consumed.
        assert!(state.take_first().is_none());
    }

    // [T1-A] Same contract for take_next.
    #[test]
    fn pending_interval_state_take_next_consumes() {
        let state = PendingIntervalState::new_empty();
        state.set_next(PendingInterval {
            interval_type: "break".into(),
            target_sec: Some(300),
            metadata: None,
        });
        let next = state.take_next();
        assert!(next.is_some());
        assert_eq!(next.unwrap().interval_type, "break");
        assert!(state.take_next().is_none());
    }

    // [T1-A] clear_all must drop both slots — finalize_session relies on this
    // to prevent stale pending intervals from leaking into the next session.
    #[test]
    fn pending_interval_state_clear_all_drops_both_slots() {
        let state = PendingIntervalState::new_empty();
        state.set_first(PendingInterval {
            interval_type: "focus".into(),
            target_sec: Some(60),
            metadata: None,
        });
        state.set_next(PendingInterval {
            interval_type: "break".into(),
            target_sec: Some(300),
            metadata: None,
        });
        state.clear_all();
        assert!(state.take_first().is_none());
        assert!(state.take_next().is_none());
    }

    // [T1-A] When no pending and no override, pomodoro `next_interval`
    // produces a break of the configured duration following a focus.
    #[test]
    fn build_next_interval_pomodoro_fallback_focus_to_break() {
        let cfg = Config::default();
        let completed = vec![Interval {
            interval_type: "focus".into(),
            start_sec: 0,
            elapsed_sec: 1500,
            target_sec: Some(1500),
            ended_emitted: true,
        }];
        let next = build_next_interval("pomodoro", &cfg, &completed, "focus", 1500, None);
        assert_eq!(next.interval_type, "break");
        // Default break duration is 5 minutes → 300 seconds.
        assert_eq!(next.target_sec, Some(300));
        assert_eq!(next.start_sec, 1500);
    }

    // [T1-A] After cycles_before_long focuses, the next break must be a long
    // break, not a regular break. This is the existing pomodoro math —
    // regression guard so the fallback path keeps cycling correctly.
    #[test]
    fn build_next_interval_pomodoro_long_break_after_cycles() {
        let mut cfg = Config::default();
        cfg.pomodoro.cycles_before_long = 4;
        cfg.pomodoro.long_break_duration = 15.0;
        let completed: Vec<Interval> = (0..4)
            .map(|_| Interval {
                interval_type: "focus".into(),
                start_sec: 0,
                elapsed_sec: 1500,
                target_sec: Some(1500),
                ended_emitted: true,
            })
            .collect();
        let next = build_next_interval("pomodoro", &cfg, &completed, "focus", 6000, None);
        assert_eq!(next.interval_type, "break");
        // Long break is 15 minutes → 900 seconds.
        assert_eq!(next.target_sec, Some(900));
    }

    // [T1-A] When a pending next-interval is supplied, it MUST take
    // precedence over the pomodoro math — this is what lets a plugin
    // override the cycle (e.g. an Exam Mode that goes Physics → Chemistry
    // → Math instead of focus → break → focus).
    #[test]
    fn build_next_interval_pending_overrides_pomodoro() {
        let cfg = Config::default();
        let completed = vec![Interval {
            interval_type: "focus".into(),
            start_sec: 0,
            elapsed_sec: 1500,
            target_sec: Some(1500),
            ended_emitted: true,
        }];
        let pending = PendingInterval {
            interval_type: "chemistry".into(),
            target_sec: Some(3600),
            metadata: None,
        };
        let next = build_next_interval("pomodoro", &cfg, &completed, "focus", 1500, Some(pending));
        // Pending wins: type is chemistry, not break.
        assert_eq!(next.interval_type, "chemistry");
        assert_eq!(next.target_sec, Some(3600));
        assert_eq!(next.start_sec, 1500);
    }

    // [T1-A] Without a pending, an unknown mode falls back to an untimed
    // focus interval (existing behaviour) — important so the existing
    // stopwatch plugin keeps working without a Rust-side change.
    #[test]
    fn build_next_interval_unknown_mode_fallback_is_untimed() {
        let cfg = Config::default();
        let completed: Vec<Interval> = Vec::new();
        let next = build_next_interval("stopwatch", &cfg, &completed, "focus", 0, None);
        assert_eq!(next.interval_type, "focus");
        assert_eq!(next.target_sec, None);
    }

    // [T1-A] With a pending, an unknown mode produces a real timed interval
    // — this is what unblocks Plugin 2 (Exam Mode) from the audit.
    #[test]
    fn build_next_interval_pending_unlocks_unknown_mode() {
        let cfg = Config::default();
        let completed: Vec<Interval> = Vec::new();
        let pending = PendingInterval {
            interval_type: "section".into(),
            target_sec: Some(1800),
            metadata: None,
        };
        let next = build_next_interval("exam-mode", &cfg, &completed, "focus", 0, Some(pending));
        assert_eq!(next.interval_type, "section");
        assert_eq!(next.target_sec, Some(1800));
    }

    // [T1-A] End-to-end pending lifecycle: set first → simulate consumption
    // by `start_session` (i.e. take_first) → confirm slot empties → confirm
    // next slot is independent.
    #[test]
    fn pending_intervals_first_and_next_are_independent() {
        let state = PendingIntervalState::new_empty();
        state.set_first(PendingInterval {
            interval_type: "intro".into(),
            target_sec: Some(60),
            metadata: None,
        });
        state.set_next(PendingInterval {
            interval_type: "main".into(),
            target_sec: Some(120),
            metadata: None,
        });
        // Taking first does not consume next.
        let first = state.take_first().expect("first is set");
        assert_eq!(first.interval_type, "intro");
        let next = state.take_next().expect("next still set after first taken");
        assert_eq!(next.interval_type, "main");
    }
}
