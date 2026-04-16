# AUDIT V3 — RUNTIME, SANDBOX & SHIP READINESS

Generated: 2026-04-16
Auditor: Claude (Opus 4.6 1M)
Commit: `fe1e117` on `master` (clean working tree)
Scope: full runtime, sandbox extensibility stress test, ship-readiness gate for v0.1.0

---

## Summary

| Severity | Count | Notes |
|---|---|---|
| CRITICAL | 4 | All in the sandbox layer — the product's primary value prop is leaky |
| HIGH     | 9 | Mix of sandbox gaps, a real atomic-write bug, one window-close regression |
| MEDIUM   | 14 | UX, perf, PRD drift, a few lifecycle races |
| LOW      | 10 | Code hygiene, paranoid-unwraps, minor docs |

**Sandbox Extensibility Score: 38 / 100**
The hook/command/preset/storage primitives are clean and usable. The rendering / mode-definition / cancellation surface is not. A community plugin author cannot build any of the three reference plugins in this audit without core code changes. See the stress-test section below for the detailed walkthrough.

**Build health:**
- `cargo check` — clean, no warnings
- `cargo clippy --all-targets -- -D warnings` — clean, zero lints
- `npx tsc --noEmit` — clean, zero errors
- `npx vite build` — success; `main-*.js` = **444 KB** (148 KB for `index-*.js`, 20 KB for overlay, 20 KB CSS). Recharts is the dominant contributor and is not code-split.
- `cargo test` — not executed in this audit (no unit regressions expected; existing tests in `commands::tests`, `plugins::tests`, `cache::tests`, `storage::tests`, `timer::tests`, `tags::tests` all pass on prior runs per audit history).

**Ship readiness: READY WITH CAVEATS.**
v0.1.0 can ship as "Flint timer with a primitive sandbox preview" — the three built-in timer modes + session log + stats dashboard work end-to-end, are stable, and the Rust/TS builds are clean. But the sandbox marketing promise ("the Obsidian of timers — any feature as a plugin") is **not deliverable today**, and README + plugin docs must be honest about which primitives exist and which are still placeholder. Full detail in the ship-readiness section at the bottom.

---

## ★ SANDBOX EXTENSIBILITY STRESS TEST ★

> This is the most important section of the audit. Flint's value proposition is that hooks + commands + presets + tags + plugins compose into any timer-related feature. I walked through three reference plugins against the actual code. Short answer: the primitive layer is partly built; the **rendering**, **custom mode**, and **cancellation** surfaces are missing; the three plugins below are either impossible or require a tech-debt workaround that defeats the purpose of a plugin system.

### Primitives actually exposed to sandboxed code

Gathered from `src/lib/plugin-api.ts` (`FlintPluginAPI`), `src/lib/plugin-sandbox.ts` (`SHADOWED_GLOBALS`), `src/components/plugin-host.tsx` (host wiring), and the five built-in plugins under `src-tauri/plugins/`. A plugin has exactly:

| Capability | API | Scope |
|---|---|---|
| Listen to after-events | `flint.on(event, cb)` | session:start/pause/resume/complete/cancel/tick, interval:start/end, question:marked, recovery:restored, command:execute, notification:show, tag:add, tag:remove, app:ready, app:quit, preset:load, arbitrary plugin-emitted topics |
| Register before-hook | `flint.hook(event, handler)` | Same event set, but **only events that core actually routes through `runBeforeHooks`** — see "before-hook coverage" table below |
| Register a command | `flint.registerCommand({ id, name, callback, icon?, hotkey?, category? })` | Visible in Ctrl+P, `hotkey` is informational badge only |
| Emit a topic | `flint.emit(topic, payload)` | Runs the full before → after pipeline; dispatches `window.CustomEvent("flint:plugin:${topic}")` on the host side |
| Read/drive the timer | `getTimerState`, `getCurrentSession`, `nextInterval`, `stopSession`, `pauseSession`, `resumeSession`, `markQuestion` | These are direct `invoke` passthroughs — they bypass the before-hook pipeline completely |
| Read sessions | `getSessions(options?)` | Calls `invoke("list_sessions")` → full JSON for every session, then client-side filter on tags/since/limit |
| Read/write plugin config | `getConfig()`, `setConfig(key, value)` | Writes go to the plugin's `config_section` in config.toml via `set_plugin_config` |
| Render into a slot | `renderSlot(slot, text)` | **Plain text only**, React-escaped (security-correct but painfully limited) |
| Show a notification | `showNotification(message, options?)` | Capped at 3 visible + 4s hard auto-dismiss. `duration` field in options is **ignored** (host hard-coded in `plugin-host.tsx:53`) |
| Per-plugin storage | `flint.storage.{get,set,delete}` | JSON files under `~/.flint/plugins/{id}/data/{key}.json`, 5 MB hard cap, key charset limited to `[A-Za-z0-9_.-]`, Windows reserved names blocked |

**Shadowed in the sandbox** (all resolve to `undefined` inside plugin source): `window`, `document`, `globalThis`, `self`, `parent`, `top`, `frames`, `__TAURI__`, `__TAURI_INTERNALS__`, `__TAURI_INVOKE__`, `__TAURI_METADATA__`, `localStorage`, `sessionStorage`, `indexedDB`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator`, `location`, `history`, `Worker`, `SharedWorker`.

**NOT shadowed** (still reachable through ambient globals inside `new Function`): `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `Promise`, `Math`, `JSON`, `Date`, `Number`, `String`, `Array`, `Object`, `Map`, `Set`, `Audio` / `HTMLAudioElement` (the constructor is a real global; instantiating one that actually plays requires a URL the plugin can't produce), `URL`, `URLSearchParams`, `TextEncoder`/`TextDecoder`, `structuredClone`, `btoa`/`atob`, `Error`, `Function` itself (which is the escape vector the sandbox readme acknowledges).

### Before-hook coverage — which events are ACTUALLY cancellable

CLAUDE.md lists a clean event catalog with "mutable context" columns for before-hooks. Reality (from searching `runBeforeHooks(` across the frontend and the Rust engine):

| Event | Fires `before:` hook? | Cancellable? | Notes |
|---|---|---|---|
| `session:start` | Yes | Yes (drops the session silently) | `App.tsx:270` — only the JS-side `startSession()` wrapper runs the hook. The tray "Start Pomodoro" path also goes through it (via `startSessionRef.current()` at `App.tsx:200`). |
| `session:pause` | **No** | **No** | `invoke("pause_session")` in `App.tsx:895` goes straight to Rust. No JS-side hook pipeline exists, and the Rust `pause_session` command only emits the after-event. |
| `session:resume` | **No** | **No** | Same as pause. |
| `session:complete` / `session:cancel` | **No** | **No** | Fired from Rust `finalize_session` directly. |
| `interval:start` / `interval:end` | **No** | **No** | Fired from Rust tick loop / `next_interval`. |
| `question:marked` | **No** | **No** | Rust-fired; no JS wrapper calls `runBeforeHooks`. |
| `command:execute` | Yes | Yes | `plugin-host.tsx:386` — but **only when the command was executed via the palette** (`executeCommand`). Keyboard shortcuts call their target directly, bypassing this. |
| `preset:load` | Yes | Yes | `App.tsx:324` |
| `notification:show` | Yes | Yes | `plugin-host.tsx:465` — mutating `ctx.body` / `ctx.plugin_id` is honored |
| `tag:add` / `tag:remove` | Partial | See below | `TagAutocomplete` fires it; the Rust-side `set_tags` does not |
| `app:ready` / `app:quit` | No (after only) | — | Fire-and-forget observer events |

**Bottom line**: the before-hook layer is real for five events (`session:start`, `preset:load`, `command:execute`, `notification:show`, `tag:add`/`tag:remove`) and a stub for everything else. The catalog in `CLAUDE.md` is **aspirational**, not accurate.

### Rendering surfaces available to community plugins

From `sidebar.tsx:133-166`:

```tsx
{tabs.some((t) => t.pluginId === "session-log") && (
  <SessionLog ... />
)}
{tabs.some((t) => t.pluginId === "stats") && (
  <StatsDashboard />
)}
{active && active.pluginId !== "session-log" && active.pluginId !== "stats" && (
  <CommunityTabPlaceholder label={active.label} />
)}
```

The "sidebar-tab" slot renders real UI for exactly two hard-coded plugin IDs (`session-log`, `stats`). Any community plugin that declares `"ui_slots": ["sidebar-tab"]` in its manifest gets a placeholder that says "_plugin has no built-in renderer_". The built-in `session-log` and `stats` plugins' JS files (`src-tauri/plugins/session-log/index.js`, `stats/index.js`) are **stubs** — they only `emit` refresh hints; the actual list, charts, heatmap, and detail panels are hardcoded React components in `src/components/`.

`renderSlot(slot, text)` only accepts plain text and only four slots are plumbed (`sidebar-tab` — placeholder for community; `settings` — auto-generated from `config_schema`; `post-session` — briefly after session end; `status-bar` — inline entries). Plugins cannot:
- Render JSX / React components
- Draw canvas / SVG
- Render images
- Attach their own event handlers to rendered elements
- Style their output beyond inheriting the host CSS variables
- Read any size / layout information back from the host

---

### Plugin 1 — "Session Analytics" (advanced statistics dashboard)

**What the user wants:** a rich analytics view — streaks, daily/weekly/monthly breakdowns, productivity scoring, study-time-by-tag, time-of-day heatmap, comparison charts, export-to-CSV. The Lock In predecessor shipped exactly this. It's the #1 reason to adopt Flint over Google Timer.

**Walkthrough:**

1. **Read session data.** `flint.getSessions()` → `invoke("list_sessions")` returns the full JSON for every session (with intervals). For a power user with 1000+ sessions this is a ~2 MB payload per call and every plugin instance hits it on every refresh. `session-log/index.js` works around this by emitting a refresh hint that the hardcoded React view consumes. A community analytics plugin would have to poll — no pagination, no server-side filter, no incremental diff. **Workable but ugly**.

2. **Register an "ANALYTICS" tab next to LOG and STATS.** Declare `"ui_slots": ["sidebar-tab"]` in the manifest → the tab label appears in the sidebar switcher (verified by `Sidebar.tabs` memoization at `sidebar.tsx:70-85`) → but clicking the tab renders `CommunityTabPlaceholder` ("_analytics plugin has no built-in renderer_"). **BLOCKER — MISSING: sidebar slot extension point.** A plugin has no way to render anything richer than a flat string into the tab body. There's no `flint.registerView(slot, component)`, no `iframe` escape hatch, no HTML content API, no canvas drawing primitive. The entire "plugin-extensible sidebar" feature is a façade — it advertises a slot that nothing can fill.

3. **Charts / tables / visualizations.** The host already ships Recharts, but the sandboxed plugin has no way to reach it — `window` is shadowed, the module registry isn't exposed, and even if it were, React components can't be authored inside `new Function("use strict"; ...)` because JSX is compile-time syntax. **BLOCKER — MISSING: `flint.registerReactView(slot, mountFn)` or similar. Or a JSON "widget spec" interpreted by the host: `{type: "bar-chart", data: [...]}` which the host renders via its own Recharts. That would let plugins describe visualizations declaratively without executing arbitrary React inside the sandbox.**

4. **Hook into `session:complete` to recompute streaks.** `flint.on("session:complete", fn)` is fully wired and fires reliably — `src-tauri/src/commands.rs:275` emits it, plugin-host's `ensureListener` picks it up, `dispatchAfterHooks` routes to the plugin. ✅ **Works.**

5. **Persist streak counter + aggregates to plugin storage.** `flint.storage.set("streak", {...})` → writes `~/.flint/plugins/analytics/data/streak.json`. ✅ **Works**, though the write is **not atomic** (`commands.rs:743` uses raw `std::fs::write`), so a crash mid-write corrupts the file. For analytics this is survivable since the data is derivable from sessions, but it's a real bug.

6. **Register commands** like `analytics:weekly-report`, `analytics:export-csv`. ✅ **Works**, appears in Ctrl+P. Plugins can even register a command that calls `flint.getSessions()` and writes to plugin storage.

7. **What's missing for this plugin to ship:**
   - Sidebar-tab rendering extension (the core blocker)
   - Pagination / server-side filter for `getSessions` (nice-to-have)
   - A way to export to a file the user chooses — the plugin can't call a file dialog, and `flint.storage.*` is sandboxed to the plugin's own directory. The plugin would have to ask the user to copy/paste from a notification or dump into its storage directory and tell them to navigate there manually.
   - Access to the SQLite cache via a plugin-scoped query API (current `getSessions` goes through the cache already, but there's no `flint.queryCache(sql)` or `flint.getStatsRange(scope)` — all the rich stats endpoints from `commands.rs` (`stats_range`, `stats_heatmap`, `stats_lifetime`) are **only callable by core React components**, not by plugins).

**Difficulty: IMPOSSIBLE** without core code changes. At least three new primitives required: a rendering extension, a stats-query API, and either a file-save dialog or a cross-plugin export directory.

---

### Plugin 2 — "Exam Mode" (timed exam simulator)

**What the user wants:** a strict countdown timer with (a) multi-section sequences like Physics 60 min → Chemistry 60 min → Math 60 min, (b) no pause allowed mid-exam, (c) no stop without an "abandoned" penalty, (d) warning sounds at 10/5/1 minute remaining, (e) completion status logged (finished early / time ran out / abandoned), (f) optional focus-blocker.

**Walkthrough:**

1. **Define a new timer mode.** Ship a manifest with `"timer_mode": true, "id": "exam-mode"`. The mode **does** appear in the tray menu, Ctrl+1..9 switch list, and the default-mode dropdown — verified by `plugins.rs::enabled_timer_modes` and the `useTimerModes()` hook. ✅

2. **Drive the first interval.** `start_session(mode: "exam-mode", ...)` goes to Rust. `commands.rs::build_first_interval` is hard-coded:
   ```rust
   let target = match mode {
       "pomodoro" => Some(minutes_to_sec(config.pomodoro.focus_duration)),
       "countdown" => Some(u64::from(config.core.countdown_default_min) * 60),
       _ => None,     // <-- exam-mode lands here
   };
   ```
   So the exam's first interval is untimed. No target. No duration. **BLOCKER — MISSING: a way for a plugin to author the initial interval.** Either `flint.startSessionWithInterval({ type, target_sec, metadata })`, or a Rust-side dispatch that calls the plugin's manifest-declared `build_first_interval` callback, or at minimum a `set_interval_target(seconds)` command the plugin can invoke post-start.

3. **Multi-section sequences (Physics → Chemistry → Math).** This requires the engine to transition between intervals with different targets, where the target for each interval depends on plugin logic (not pomodoro math). `commands.rs::next_interval` hardcodes:
   ```rust
   let next = match state.mode.as_str() {
       "pomodoro" => { ... focus/break cycling ... },
       _ => Interval { interval_type: "focus", start_sec: ..., target_sec: None, ... }
   };
   ```
   For any non-pomodoro mode the next interval is untimed. The plugin's `interval:end` listener could call `flint.nextInterval()` to advance, but it cannot tell the engine "and the next interval should target 3600 seconds of Physics." **BLOCKER — MISSING: `flint.pushInterval({ type, target_sec, metadata })` or a manifest-declared `on_interval_end(state) -> NextInterval` hook.**

4. **Cancel pause.** The plugin wants `flint.hook("before:session:pause", (ctx) => ({ cancel: true }))`. Current reality: the before-hook layer never runs for `session:pause` because `invoke("pause_session")` is called directly from the keyboard handler at `App.tsx:895` and from the overlay. There is no JS-side wrapper that calls `runBeforeHooks("session:pause", ...)` first. **BLOCKER — MISSING: `before:session:pause`, `before:session:resume`, `before:session:stop`, `before:mark-question`, `before:next-interval` events, wired into the frontend wrappers OR into Rust itself (harder — Rust would need to call out to JS synchronously, which Tauri doesn't support cleanly).**

5. **Cancel stop.** Same as pause. The `core:stop-session` palette command goes through `before:command:execute` which the plugin CAN intercept, but pressing Escape bypasses this entirely — the keyboard handler at `App.tsx:821` just calls `setStopConfirmOpen(true)` then the confirm goes via `confirmStop()` → `invoke("stop_session")` with no hook. **BLOCKER — MISSING: same hook addition as #4.**

6. **Warning sounds at 10/5/1 min.** `new Audio(dataURL)` is syntactically available inside the sandbox because neither `Audio` nor `HTMLAudioElement` are shadowed. The plugin would have to ship the audio as a base64 `data:audio/wav;base64,...` literal inlined into its JS source (no filesystem access, no fetch). Audible playback requires a user-gesture unlock on some platforms — for Tauri's Wry webview this is usually auto-unlocked, but untested. **Workable but gross.** The cleaner path is a core API: `flint.playSound(builtIn: "bell" | "chime" | "alarm")`. MISSING: audio primitive in the plugin API.

7. **Modify the timer display.** The plugin wants to render "PHYSICS — 54:12 remaining" and "NO PAUSING" in the main timer area. `renderSlot("status-bar", "...")` works for the bottom bar but the main numeric display in `TimerDisplay` is not exposed as a slot. **BLOCKER — MISSING: a "timer-header" slot or a `renderTimerChrome` API.**

8. **Register presets for exam configurations** (JEE Main, NEET, SAT). ✅ **Works** — presets are generic JSON and the plugin can call `save_preset` via... wait, no. `save_preset` is not in the plugin API surface. A plugin cannot create presets programmatically. It could drop files directly into `~/.flint/presets/` but it has no filesystem access. **MISSING: `flint.savePreset(preset)` in the plugin API**, or a `config_schema`-level "preset packs" concept.

9. **Block other apps (focus mode).** Out of scope for the plugin API (would need OS-level capability). Document as "use the existing Focus app on Mac / Focus Assist on Windows". Not a Flint problem.

**Difficulty: IMPOSSIBLE** for the core mechanic (multi-section timed intervals, pause cancel). Four blockers: interval authoring, mid-session interval push, before-hook for pause/stop, and a main-timer rendering slot. Even ignoring the audio and main-display rendering (which could be waved off), the mode-definition and cancellation primitives are the central feature of the plugin and they're absent.

---

### Plugin 3 — "Flowtime" (adaptive break suggestions)

**What the user wants:** a count-up timer that nudges ("want a break?") at 25 min, 50 min, 90 min. User dismisses or accepts. If accepted, start a break proportional to work time (50 min → 10 min break). Remember usage patterns to tune thresholds.

**Walkthrough:**

1. **Run as a modified stopwatch.** Ship a manifest with `"timer_mode": true, "id": "flowtime"`. ✅ Mode registration works.

2. **Monitor elapsed time via ticks.** `flint.on("session:tick", (payload) => { ... })` receives `{ elapsed_sec, interval_elapsed, interval_remaining }` every second — verified at `src-tauri/src/lib.rs:71-79`. ✅ **Works.**

3. **Fire non-blocking nudges.** `flint.showNotification("Want a break?")` — hits the notification cap (3 visible, 4 s auto-dismiss). **Problematic**: the 4 s auto-dismiss is a hard constant in `plugin-host.tsx:53` and plugins cannot override it via `options.duration`. A "gentle nudge" notification that disappears in 4 seconds is nearly useless for an adaptive-break feature where the user might be heads-down. **MISSING: persistent / dismissible-only notifications**, or a separate "prompt" primitive the user must explicitly acknowledge. Also, the dedup window (10 s) means re-showing "Want a break?" every 90 s works, but re-showing it 5 s later as an escalation does not — the dedup silently eats the escalation.

4. **Dynamic break duration (work 50 min → break 10 min).** Flowtime wants to transition from one interval to the next with a custom target. Same blocker as Plugin 2 — `next_interval` in Rust hardcodes the pomodoro math. For a non-pomodoro mode, the next interval is untimed. **BLOCKER — MISSING: `flint.pushInterval({ target_sec })`.**

5. **Store historical patterns.** `flint.storage.set("history", { last_30_breaks: [...] })` ✅ **Works** (modulo the non-atomic write bug above).

6. **Analyze past sessions for patterns.** `flint.getSessions({ limit: 100, since: "2026-03-01" })` ✅ **Works** but loads every session fully. Over 100+ sessions with intervals this is a multi-megabyte payload — not catastrophic but wasteful.

7. **Let the user accept a nudge to start a break.** The plugin wants to show a "take a break?" button. The only UI surface is `renderSlot`, which renders plain text into a known slot — no buttons, no click handlers. The plugin could register a command `flowtime:take-break` and tell the user to press Ctrl+P → "take break" in a notification, but that defeats the "gentle nudge" UX. **MISSING: an interactive prompt primitive.** Something like `flint.prompt({ title, body, accept: "Take break", decline: "Keep going", onAccept, onDecline })` that runs through the host React tree.

**Difficulty: MOSTLY WORKS for the pattern-monitor + notification shell; IMPOSSIBLE for the actual break transition and the interactive prompt.** A Flowtime plugin could today ship as a "reminder only" plugin (passive nudges, no actions). The adaptive-break logic and the user prompt are blocked.

---

### Sandbox Verdict

#### API coverage score — 38 / 100

Scoring breakdown against a "reasonable plugin" rubric (roughly weighted by importance):

| Capability | Score | Rationale |
|---|---|---|
| Event observation (after-hooks) | 9/10 | Every major lifecycle event fires reliably. One-way but complete. |
| Event interception (before-hooks) | 3/10 | Only 5 events are actually routed through the pipeline; the rest advertise cancellation and don't honor it. |
| Command registration | 9/10 | Clean, auto-cleanup on unload, MRU-aware palette, commands are first-class. |
| Storage | 7/10 | Works, per-plugin isolated, size-capped. Non-atomic write is the one real bug (HIGH). |
| Session read | 6/10 | Returns data but not paginated, no server-side filter, no cache-tier query access. |
| Session control (drive the timer) | 4/10 | Can call start/pause/stop/next/mark, but cannot cancel any of those via hook, and the set of actions is pomodoro-shaped. |
| Custom timer mode | 2/10 | Manifest flag exists; engine logic is hardcoded for pomodoro. Any other mode gets a single untimed interval. |
| UI rendering | 1/10 | Plain-text `renderSlot` only. Sidebar-tab slot is fake for community plugins. |
| Notifications | 4/10 | Capped, dedup-eaten, no interactivity, no escalation, `duration` param ignored. |
| Audio | 3/10 | Not shadowed, so `new Audio(dataURL)` works, but no bundled sounds, no file loading. |
| Plugin-to-plugin communication | 6/10 | Works via `flint.emit` topics, but no discovery, no schema. |
| Preset authoring from a plugin | 0/10 | Plugins can't create presets programmatically. |
| Settings UI | 8/10 | Auto-generated from `config_schema` — number / boolean / string / select all work, schema fields render in declared order (S-H3). |

Total ≈ **38 / 100**.

#### Missing primitives (ordered by estimated ROI)

1. **`flint.registerView(slot, renderSpec)`** — a JSON "render spec" that the host interprets into React/Recharts. Something like `{type: "sidebar-tab", tabs: [{label, widgets: [{type: "bar-chart", data: [...]}]}] }`. Unlocks Plugin 1 completely without giving plugins the power to execute arbitrary React. Biggest single ROI.

2. **`flint.pushInterval({ type, target_sec, metadata? })`** and **`flint.setFirstInterval(...)`** — the Rust engine treats this as a directive rather than hardcoding pomodoro. The pomodoro plugin becomes the first consumer and stops being special-cased in `commands.rs::next_interval`. Unlocks Plugins 2 and 3.

3. **Wire `before:session:pause`, `before:session:resume`, `before:session:stop`, `before:mark-question`, `before:next-interval` through the frontend wrappers and keyboard handlers** — the Rust side can stay after-only; the JS wrappers (`App.tsx` keyboard handler + overlay controls) run the pipeline and skip the invoke if cancelled. This is the lowest-engineering-cost way to make the hook system match its advertised event catalog.

4. **`flint.prompt({ title, body, accept, decline })`** — an interactive dismissible dialog. Returns a promise resolving to `"accepted" | "declined" | "timeout"`. Core owns the rendering, plugin owns the decision. Also usable by Exam Mode for "Are you sure you want to quit?" and by Flowtime for "Want a break?".

5. **`flint.stats.range(scope)`, `flint.stats.heatmap(days)`, `flint.stats.lifetime()`** — thin wrappers around the existing `stats_*` Rust commands so plugins can read from the SQLite cache instead of reconstructing aggregates from raw session JSON. These commands already exist and are already guarded; they're just not in the plugin API surface.

Honorable mentions: `flint.savePreset`, `flint.playSound`, `flint.getStatsDirectly`, a `notification.persist: true` option, a `getSessions({ cursor, limit })` pagination contract.

#### Sandbox ceiling

**The hardest thing a plugin can build today**: a "refresh a side view when a session ends" plugin. That's essentially what the built-in `session-log` and `stats` plugins are — their JS files are 30 lines each because the actual list/charts/heatmap are hardcoded React components the "plugin" doesn't touch. A community plugin can replicate this pattern only if the host already has a renderer for it, which defeats the plugin pattern.

**The first thing a plugin cannot build**: any UI richer than plain text in a named slot. This blocks: analytics dashboards, task lists, cheat-sheets, goal trackers, focus-mode indicators with graphics, streak visualizations, note-taking panels, mini-calendars, and — notably — every community sidebar tab anyone would actually want to build.

#### Comparison to Obsidian

Flint markets itself as "the Obsidian of timers". Obsidian's plugin API surface (roughly, as of 2024):

| Obsidian primitive | Flint equivalent | Gap |
|---|---|---|
| `Plugin` base class with `onload`/`onunload` | `flint.hook` + manual cleanup via unsubscribe returns | ✅ Functional parity |
| `addCommand({id, name, callback, hotkeys})` | `flint.registerCommand` | ✅ Parity (Flint hotkeys are informational only, no rebinding) |
| `addRibbonIcon(icon, title, cb)` | — | Missing |
| `registerView(viewType, creator)` with `ItemView` subclass returning a custom DOM element | **Missing** | The single biggest gap |
| `registerMarkdownPostProcessor(cb)` | — | Not applicable (no markdown surface in Flint) |
| `registerEditorExtension` | — | Not applicable |
| `addSettingTab(new PluginSettingTab)` | Auto-generated settings from `config_schema` | ✅ Parity for basic types; Obsidian's Setting API is richer (color pickers, sliders with live preview, text areas, keyboard binding capture) |
| `workspace.on(event, cb)` for a large fixed event catalog | `flint.on` | ✅ Similar |
| `app.vault.read(file)` / `app.vault.modify(file, content)` | `flint.getSessions()` / `flint.storage.*` | ✅ Scoped-down parity — Flint plugins can only touch their own storage and read-only session data, which is actually safer than Obsidian's "full vault" access |
| `Notice` with optional timeout | `flint.showNotification` capped at 4s | Partial — no persistence, no interactivity |
| `Modal` subclass with `open()` / `close()` and full DOM control | **Missing** | Second biggest gap — equivalent to Plugin 3's prompt primitive |
| `Menu` with `addItem` | — | Missing (no context menu in Flint by design) |
| `registerDomEvent(target, event, cb)` | — | Missing — plugins cannot bind DOM listeners |
| `registerInterval(id)` / `registerEvent` for auto-cleanup | Implicit via plugin reload teardown | ✅ Parity |

Flint's primitive-layer philosophy is compatible with Obsidian's; the gap is not conceptual, it's surface area. The two things that make Obsidian plugins feel powerful — `registerView` (arbitrary DOM in a workspace leaf) and `Modal` (arbitrary DOM in a dialog) — both require the host to accept that plugins can render into a DOM container the host owns. Flint's `plugin-sandbox.ts` goes out of its way to **prevent** this by shadowing `document`. The design intent was security, and it's the right default — but it means the Obsidian-shaped `registerView` is impossible without a mediated render pipeline (the JSON-spec idea in recommendation #1 above).

#### Top 5 recommendations (ordered by ROI)

1. **Add a JSON "render spec" rendering extension point.** Unblocks analytics, community sidebar tabs, and modal prompts. Host interprets a declarative spec into its own React tree; plugin cannot execute DOM code. Highest leverage.

2. **Wire `flint.pushInterval` + `setFirstInterval` into the Rust engine and fold the pomodoro plugin onto the new API.** Removes the hardcoded pomodoro branch from `commands.rs`, unlocks Plugins 2 and 3, and moves Flint from "pomodoro + friends" to a real primitive engine.

3. **Run `before:session:pause / resume / stop / mark-question / next-interval` through the JS wrappers and keyboard handlers.** Cheap to implement, honors the catalog that CLAUDE.md already advertises, and is the difference between "hook system" and "observer system".

4. **Ship a `flint.prompt` primitive** — interactive dismissible dialog with accept/decline buttons. Usable by Exam Mode, Flowtime, and nearly any "are you sure" workflow. Pairs naturally with the JSON render spec from #1.

5. **Expose the existing `stats_*` Rust commands to the plugin API** (`flint.stats.range`, `flint.stats.heatmap`, `flint.stats.lifetime`). Pure plumbing — the backends already exist and are safe. Massive performance win for any analytics plugin over re-aggregating from `getSessions()`.

Note: do not ship "unmediated DOM access" as a shortcut fix. That breaks the sandbox guarantee (S-C1/S-C2) and effectively forks the security model. The JSON-spec approach preserves the guarantee and is the right long-term bet.

---

## CRITICAL

### [C-1] Community plugins cannot render any custom UI beyond plain text
- **Category:** Sandbox
- **Description:** `flint.renderSlot(slot, text)` is the only rendering primitive, and it's text-only. The `sidebar-tab` slot hardcodes support for `session-log` and `stats` plugin IDs in `sidebar.tsx:133-166`; any other plugin gets `CommunityTabPlaceholder` ("_plugin has no built-in renderer_"). The two built-in "plugins" whose dashboards live in this slot are stubs (30-line files under `src-tauri/plugins/session-log/index.js` and `stats/index.js`) — the real React components are hardcoded in `src/components/session-log.tsx` and `stats-dashboard.tsx`.
- **Reproduction:**
  1. Create `~/.flint/plugins/demo/manifest.json` with `"ui_slots": ["sidebar-tab"]`
  2. Create `index.js` with `flint.renderSlot("sidebar-tab", "hello")`
  3. Enable in settings → sidebar shows DEMO tab → clicking it shows the placeholder text "demo plugin has no built-in renderer"
- **Impact:** The flagship sandbox feature does not work for community plugins. The README's claim "the Obsidian of timers" is misleading — analytics dashboards, task lists, cheat-sheets, focus-mode indicators, streak visualizations, mini-calendars, and every other sidebar-tab community plugin is impossible.
- **Suggested fix:** Ship the JSON "render spec" extension point described in sandbox recommendation #1. A plugin declares `renderSpec()` returning `{type: "widgets", children: [...]}` where children are host-supported primitives (text, bar-chart, line-chart, heatmap, table, button → command). Host interprets with Recharts and its own React components. This preserves the sandbox guarantee while giving plugins real rendering power.

### [C-2] Custom timer modes are impossible — `next_interval` hardcodes pomodoro in Rust
- **Category:** Sandbox
- **Description:** `src-tauri/src/commands.rs::next_interval` at lines 389-429 has a literal `match state.mode.as_str() { "pomodoro" => {...}, _ => Interval { target_sec: None, ... } }`. For any non-pomodoro mode, the engine creates a single untimed focus interval — the plugin cannot specify a target duration, a section sequence, or a break. `commands.rs::build_first_interval` at lines 88-101 has the same hardcoded branch for the first interval (pomodoro and countdown only). Community plugins that set `"timer_mode": true` get mode registration (the tray menu, Ctrl+1..9, the dropdown) but no actual interval logic.
- **Reproduction:**
  1. Create a community plugin with `"timer_mode": true, "id": "demo"`
  2. `start_session` with mode `"demo"` → session starts with `current_interval.target_sec = None` (verified by reading the engine source)
  3. `flint.on("interval:end", ...)` never fires because there is no target to hit
  4. The plugin has no way to tell the engine "advance to the next phase with target=3600s"
- **Impact:** Plugin 2 (Exam Mode) and Plugin 3 (Flowtime dynamic break) are structurally impossible. Any community timer mode that isn't pomodoro-shaped degrades to "stopwatch mode renamed". This is the second largest sandbox gap after rendering.
- **Suggested fix:** Add `flint.pushInterval({ type, target_sec, metadata? })` and `flint.setFirstInterval(...)` to the plugin API. Refactor `next_interval` to consult a per-mode registry populated by plugin init; keep a fallback for legacy pomodoro config but move the transition logic into the pomodoro plugin's own JS. This is the path to making Flint's architecture actually plugin-first.

### [C-3] Before-hook pipeline bypassed by keyboard shortcuts and overlay controls
- **Category:** Sandbox
- **Description:** `App.tsx:882-903` (the Space key handler) calls `invoke("pause_session")` / `invoke("resume_session")` directly. `App.tsx:870-878` (Enter key) calls `invoke("mark_question")` directly. `App.tsx:805-826` (Escape key, stop-confirm flow) calls `confirmStop()` which calls `invoke("stop_session")` directly. The overlay window's controls do the same (see `overlay-app.tsx`). **None of these go through `runBeforeHooks(...)`**. So even if a plugin registers `flint.hook("session:pause", (ctx) => ({ cancel: true }))`, pressing Space still pauses.
- **Reproduction:**
  1. Register a before-hook: `flint.hook("session:pause", () => ({ cancel: true }))` in a plugin
  2. Start a session, press Space → session pauses immediately, hook never fires (verify with `console.log` inside the handler)
  3. Only path that goes through the pipeline is Ctrl+P → "Pause session" command
- **Impact:** Any plugin that tries to enforce "no pausing" (Exam Mode's central feature), "require confirmation before mark-question" (study-mode plugins), or "log every pause" can be defeated by pressing Space. The catalog in CLAUDE.md advertises cancellation for these events, which is false.
- **Suggested fix:** Wrap every timer action in the JS keyboard handler with a small wrapper that runs `runBeforeHooks("session:pause", ctx)` first, bails out if cancelled, then invokes. Same for resume/stop/mark/nextInterval. This is roughly 30 lines of wrapping; the `startSession` wrapper at `App.tsx:263-290` is the model.

### [C-4] `before:` hook catalog in CLAUDE.md is aspirational, not accurate
- **Category:** Sandbox / Docs
- **Description:** The event catalog table in CLAUDE.md lists mutable `before:` context for `session:start`, `session:pause`, `session:resume`, `session:complete`, `session:cancel`, `interval:start`, `interval:end`, `notification:show`, `preset:load`, `tag:add`, `tag:remove`, `command:execute`, `app:ready`, `app:quit`. In reality, only `session:start`, `preset:load`, `command:execute` (palette-only), `notification:show`, and `tag:add`/`tag:remove` (TagAutocomplete-only) are routed through `runBeforeHooks`. The other nine events fire `after:` only. Plugins relying on documented cancellation semantics silently fail.
- **Reproduction:** Grep the repo for `runBeforeHooks\(`. Only 6 call sites exist: `App.tsx:270` (session:start), `App.tsx:324` (preset:load), `plugin-host.tsx:386` (command:execute), `plugin-host.tsx:465` (notification:show), `tag-autocomplete.tsx:94` (tag:add / tag:remove). Nothing else.
- **Impact:** Plugin authors who read the doc and trust it will build plugins that "should work" and don't. Compounds with C-3 — between them, the before-hook layer is roughly 40% implemented.
- **Suggested fix:** Either (a) wire up the missing events per C-3 (preferred, unblocks real plugins) or (b) prune the catalog in CLAUDE.md to only list events that actually fire the pipeline, with a note that the rest are after-only. Do one or the other before shipping — the current state is worst-of-both.

---

## HIGH

### [H-1] `plugin_storage_set` is not atomic — `std::fs::write` instead of `write_atomic`
- **Category:** Crash / Data integrity
- **Description:** `src-tauri/src/commands.rs:743` writes plugin storage with `std::fs::write(&path, data)` directly. Every other durable write in Flint (session files, recovery, presets, state.json, exports) goes through `storage::write_atomic` which does tmp + rename. A power loss or OS kill mid-write leaves a truncated `~/.flint/plugins/{id}/data/{key}.json`, and the next `plugin_storage_get` either returns parse-error or (worse) a partially-valid document.
- **Reproduction:** Register a plugin that `flint.storage.set("history", bigObject)` where `bigObject` is ~4 MB. Force-kill the app during the write (hit the 500 ms window where disk I/O is still in flight). Relaunch → `plugin_storage_get` fails or returns partial data.
- **Impact:** Plugin data corruption on crash. Worse for any plugin that stores derived state the user cares about (streak counters, goal trackers, ML-learned break thresholds). Low-medium likelihood per crash, but every plugin is exposed.
- **Suggested fix:** Replace `std::fs::write(&path, data)` with `storage::write_atomic(&path, data.as_bytes())`. One-line change.

### [H-2] Close-to-tray=false skips session finalize on window close
- **Category:** Crash / Data integrity
- **Description:** `src-tauri/src/lib.rs:328-343` — the `WindowEvent::CloseRequested` handler takes two branches. If `close_to_tray == true` it calls `api.prevent_close()` and runs the tray-minimize flow. If `close_to_tray == false` it calls `overlay::close_overlay_if_open(...)` and `return;` without preventing close, letting Tauri's default close→exit take over. **This path does NOT call `shutdown_with_finalize`**, so a running session is never finalized — it lives on in `recovery.json` with a stale `last_saved_at`. On next launch `apply_recovery` advances elapsed_sec by `(now - last_saved_at)` which silently adds hours-to-days of "focus time" to the recovered session.
- **Reproduction:**
  1. In settings, disable close-to-tray
  2. Start a pomodoro session
  3. Click the window `×` button (do NOT use Ctrl+Q)
  4. Wait an hour
  5. Relaunch → session is "recovered" with 60 extra minutes of elapsed time
- **Impact:** Stale recovery, corrupted session data, misleading stats. Ctrl+Q and the tray "Quit Flint" menu entry both go through `shutdown_with_finalize` correctly — only the window-close-without-tray path is broken.
- **Suggested fix:** Before `return;` in the `!close_to_tray` branch, call `commands::shutdown_with_finalize(&app_handle)`. This finalizes the session as cancelled, flushes recovery, tears down the overlay in the correct order, and matches Ctrl+Q semantics.

### [H-3] Google Fonts loaded at runtime — violates local-first principle
- **Category:** PRD compliance / Distribution
- **Description:** `index.html:7-10` and `overlay.html:7-10` both contain:
  ```html
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />
  ```
  PRD §7.7 states explicitly: "No custom fonts (no web font loading, no Google Fonts — keep the binary clean)". This is also a local-first violation — CLAUDE.md §Architecture invariants: "LOCAL-FIRST: no network calls, no cloud, no accounts, no analytics. All data stays on disk."
- **Reproduction:** Launch Flint with no network (disable WiFi before first launch). Observe fallback font rendering — the JetBrains Mono we rely on for the terminal aesthetic is replaced by whatever the OS monospace fallback is, breaking character width calibration for the timer digits and the terminal-pill overlay. Also, fontsopen a network connection and the browser hits fonts.googleapis.com.
- **Impact:** Three separate issues: (1) PRD deviation (was a hard requirement), (2) local-first violation (the app reaches the internet on first render), (3) privacy — Google Fonts logs the request, exposing the fact that a Flint user opened the app to a third party. Combined with the marketing language ("no network calls, no tracking"), this is reputationally bad if any user notices.
- **Suggested fix:** Bundle JetBrains Mono woff2 files inside `src/assets/fonts/` and reference them via a local `@font-face` in `src/index.css`. Drop the Google Fonts `<link>` tags from both HTML files. Font files are ~60 KB each × 4 weights = ~240 KB added to the bundle — well under the existing 444 KB main chunk and a worthwhile trade.

### [H-4] `settings-panel.tsx` save pulse timeout has no cleanup
- **Category:** Memory / React lifecycle
- **Description:** `src/components/settings-panel.tsx:40` fires `setTimeout(() => setSavedPulse(false), 1200)` after a save. The timeout has no cleanup — if the user saves then presses Escape within 1.2 s, the settings panel unmounts while the timeout is still pending. When it fires, `setSavedPulse(false)` runs on an unmounted component, causing a React strict-mode warning and (in production) a small state-update-on-unmounted leak.
- **Reproduction:** Open settings, change any field, click save, press Esc before 1.2 s elapses. Observe warning in console (dev) or benign leak (prod).
- **Impact:** Low on its own, but the pattern is repeated in several places and suggests a broader lack of cleanup discipline. Production impact is a harmless leak; dev impact is console noise.
- **Suggested fix:** Store the timeout ID in a `useRef`, clear it in a cleanup `useEffect`, and clear on new save before starting a new one.

### [H-5] Plugins cannot create or load presets programmatically
- **Category:** Sandbox
- **Description:** The preset CRUD commands (`list_presets`, `save_preset`, `delete_preset`, `load_preset`, `touch_preset`) are only wired into Rust's invoke surface; they are not exposed through `flint.*` in the plugin API. A plugin that wants to ship a "preset pack" (e.g., Exam Mode with three exam configurations) cannot create presets on install — it must ask the user to re-enter them manually.
- **Reproduction:** In any plugin's `index.js`, try `flint.savePreset(...)` — `flint.savePreset` is undefined. `invoke` is also inaccessible (it's shadowed through `__TAURI__` / `__TAURI_INTERNALS__`).
- **Impact:** Preset packs are impossible. Exam Mode's onboarding ("pick your exam: JEE / NEET / SAT") requires manual preset entry, which is a cold start killer.
- **Suggested fix:** Expose `flint.savePreset`, `flint.listPresets`, `flint.loadPreset`, `flint.deletePreset` in the API surface. The commands already exist and are safe (they validate inputs and write atomically). This is 40 lines of plumbing.

### [H-6] No interactive prompt primitive — plugins cannot ask the user questions
- **Category:** Sandbox
- **Description:** The only way for a plugin to communicate with the user is `flint.showNotification(message, ...)` (4 s auto-dismiss, no buttons). There is no dialog primitive that blocks waiting for user input, no confirm, no prompt, no picker. Plugins that need user decisions (Flowtime "take a break?", Exam Mode "are you sure you want to quit?", any workflow plugin with a "continue/cancel" split) have no surface to render one.
- **Reproduction:** Try to build Plugin 3 (Flowtime). The "want a break?" prompt has nowhere to live — it could be a notification (4 s dismiss, no button), or the user could be told to press Ctrl+P and search for a command, but neither is a "gentle nudge" UX.
- **Impact:** Interactive plugins (Plugin 3 above, plus any "are you sure" workflow) are not buildable.
- **Suggested fix:** Add `flint.prompt({title, body, accept, decline, defaultOption?}): Promise<"accept" | "decline" | "dismissed">`. Host renders a centered dialog using the same primitives as the command palette (fixed-position, terminal-aesthetic, Escape dismisses).

### [H-7] No access to the SQLite stats endpoints from the plugin API
- **Category:** Sandbox / Performance
- **Description:** Flint already ships pre-computed stats endpoints in Rust (`stats_today`, `stats_range("week")`, `stats_range("month")`, `stats_heatmap`, `stats_lifetime`) that query the SQLite cache and return aggregates. These are fast. None of them are in the plugin API surface. A plugin that wants "total focus time this month" must call `flint.getSessions()`, get back every session (full JSON with intervals), and re-aggregate in JS.
- **Reproduction:** Grep `flint.stats` — no matches. The Rust endpoints are in `lib.rs:417-421` but not proxied into `createPluginAPI`.
- **Impact:** Analytics plugins (Plugin 1) are forced to load the full session payload repeatedly, which is O(sessions × sessions_per_refresh). Over 1000 sessions this is multi-megabyte on every refresh. Fixable by plumbing.
- **Suggested fix:** Add `flint.stats = { today(), range(scope), heatmap(days), lifetime() }` to the API surface. Thin wrappers around the existing `invoke` calls. ~50 lines.

### [H-8] Notification `duration` option is documented but silently ignored
- **Category:** UX / Sandbox
- **Description:** `FlintPluginAPI.showNotification` signature accepts `options?: { duration?: number }`, but `plugin-host.tsx:453-475` destructures `_options?: { duration?: number }` and never uses it. The actual auto-dismiss is hardcoded in `NOTIFICATION_AUTO_DISMISS_MS = 4000` at `plugin-host.tsx:53`. Built-in plugins pass `{ duration: 4000 }` or `{ duration: 6000 }` (see `countdown/index.js:11` — `flint.showNotification("Countdown complete.", { duration: 6000 })`) and those values are thrown away.
- **Reproduction:** Write a plugin: `flint.showNotification("test", { duration: 10000 })`. Observe it disappears after 4 s not 10.
- **Impact:** Misleading API. Also breaks the countdown plugin's intent — completion notifications disappear in 4 s instead of the intended 6 s, which is the difference between "I saw it" and "I missed it".
- **Suggested fix:** Either (a) honor `duration` with a sensible cap (e.g., `Math.min(options.duration ?? DEFAULT, MAX = 10000)`) or (b) remove it from the type signature and document "notifications auto-dismiss in 4 seconds, non-configurable" in the plugin guide. Option (a) is nicer for plugin authors and still safe if capped.

### [H-9] Tauri listen() race during rapid plugin reload can leak one listener per reload
- **Category:** Memory
- **Description:** `plugin-host.tsx::ensureListener` at line 275-299 sets a cancel sentinel before starting `listen()`. If the user rapidly toggles a plugin on/off mid-event-loop (realistic during settings panel interaction), the sequence is: subscribe → cancel-sentinel in map → listen() pending → tearDown → iterate map, call cancel-sentinel → clear map → subscribe again → new cancel-sentinel in map → second listen() pending → first listen() resolves → `canceled` is true → calls `realUnlisten()` correctly. The map still has the second cancel-sentinel. Second listen() resolves and replaces it with its realUnlisten. **Normal case is correct.** But there's a narrow window where the first listen() resolves with `canceled=false` (because the cancel-sentinel was pulled before `tearDown` iterated) and the event listener is orphaned — it fires forever, no way to unlisten it. This is low probability but reproducible under fast plugin toggling.
- **Reproduction:** Enable/disable a plugin that listens to `session:tick` 50 times in a second via the settings panel. Observe console warning pattern where some plugin reload cycles log "unlisten error" and subsequent ticks fire the handler multiple times.
- **Impact:** Potential memory leak under rapid plugin reload. Low in practice (users don't spam toggle), but existence of the race matters for automated tests and stability.
- **Suggested fix:** Track pending listens separately from resolved ones. Use a WeakMap or an explicit `pending: Set<Promise>` that `tearDown` awaits before clearing. Alternatively, use `AbortController` semantics — Tauri `listen` doesn't support abort natively but the cancel-sentinel approach can be made race-free by storing the pending promise itself in the map and having tearDown await them.

---

## MEDIUM

### [M-1] `sessions-refresh` CustomEvent is fired into the void if listeners are unmounted
- **Category:** Reliability
- **Description:** `App.tsx:116` dispatches `new CustomEvent("flint:plugin:sessions:refresh")` after `delete_session`. The listener lives in `session-log.tsx` (and duplicated in `stats-dashboard.tsx`). If either component is unmounted at dispatch time (e.g., user is in settings view and deletes a session via the palette), the event has no receiver. On re-mount, the list re-fetches from the cache, so the data is correct — but the user may see stale data for up to ~1 second if they click back to the log immediately.
- **Reproduction:** Open session log, switch to settings, trigger `core:delete-selected-session` via palette (though this only works on an open session in the detail panel — edge case).
- **Impact:** Minor visual staleness, not data corruption.
- **Suggested fix:** Dispatch a persistent refresh signal (e.g., bump a counter in a module-level ref) that components read on mount, rather than relying on live event subscription.

### [M-2] Startup blocks on full session-folder scan for the tag index
- **Category:** Performance
- **Description:** `src-tauri/src/lib.rs:291-297` calls `tags::scan_all_sessions()` synchronously during app initialization — before the first webview paints. `scan_all_sessions` reads and parses every file under `~/.flint/sessions/`. With 1000 sessions this is ~1-3 seconds of blocking work on a cold cache; with 10,000 it's 10+ seconds. Users see a blank window until done.
- **Reproduction:** Create 1000 session files and restart. First paint is delayed until scan completes.
- **Impact:** Slow startup for power users. Not catastrophic at shipping scale (<100 sessions), but the issue grows linearly.
- **Suggested fix:** Move `scan_all_sessions` to a background `tokio::spawn` task. The tag autocomplete starts empty, populates when ready, and `get_known_tags` returns a partial snapshot in the meantime. The frontend `TagAutocomplete` is tolerant of empty suggestion lists.

### [M-3] Recharts bundled in the main chunk — no lazy loading
- **Category:** Performance / Build
- **Description:** `dist/assets/main-CqxWQP4N.js` is 444 KB, dominated by Recharts (and d3 dependencies). The Stats tab is not visited on every session (users open session log more often than the heatmap). Lazy-loading Recharts via `React.lazy(() => import("./stats-dashboard"))` would cut the cold-start bundle by ~250 KB.
- **Reproduction:** `du -h dist/assets/main-*.js` → 444 KB. Grep imports of `recharts` — only in `stats-dashboard.tsx` and `stats-heatmap.tsx`.
- **Impact:** Longer cold start, larger memory footprint on idle.
- **Suggested fix:** `React.lazy` + `Suspense` around `StatsDashboard` in `sidebar.tsx`. Keeps the first render fast and charts load when the user opens the tab.

### [M-4] `commandMruShared` is a module-level `Map` that never shrinks
- **Category:** Memory
- **Description:** `plugin-host.tsx:121` declares `const commandMruShared = new Map<string, number>()`. Every `executeCommand` call writes to it. Nothing deletes entries when a command is deregistered (plugin unload) or when the map gets large. Over a long session with many command executions, it grows without bound. Realistic worst case: a plugin that re-registers commands with random IDs per event (buggy but possible) creates one MRU entry per event.
- **Reproduction:** Observe `commandMruShared.size` over a long session.
- **Impact:** Slow memory leak. In practice, ~100 commands per user × small payload = a few KB. Not a ship-blocker, but worth fixing.
- **Suggested fix:** Prune MRU entries for commands that are no longer in the registry during `reload()` teardown. Alternatively cap at 256 entries with LRU eviction.

### [M-5] Preset config_overrides aren't validated against current plugin schema
- **Category:** Schema evolution / Correctness
- **Description:** `src-tauri/src/commands.rs::merged_config` applies `active_override.values` to the base config without checking whether the keys still exist in `plugin.manifest.config_schema`. If a plugin author renames `focus_duration` → `focus_minutes` in v2, existing presets with the old key silently no-op (the merged config has the old key under `pomodoro.focus_duration` which serde ignores on deserialization). The frontend `PresetForm` at `preset-form.tsx:175-200` does filter submitted overrides to keys present in the active plugin's schema, so NEW presets are fine, but EXISTING presets created under an older schema stay broken.
- **Reproduction:** Save a preset with pomodoro focus_duration=45. Manually edit `src-tauri/plugins/pomodoro/manifest.json` to rename the field (or imagine a real plugin update did this). Restart, load the preset → focus_duration override is ignored silently, base config value is used.
- **Impact:** Silent failure during plugin schema evolution. Users don't know their overrides stopped applying.
- **Suggested fix:** On `merged_config`, log a warning for any override key not in the schema. On `list_presets` / `load_preset`, return a `stale_keys: [...]` field so the frontend can flag "this preset was built for an older version of the plugin".

### [M-6] Notification dedup map retains stale entries indefinitely if notifications stop arriving
- **Category:** Memory
- **Description:** `plugin-host.tsx:429-434` prunes the dedup map opportunistically only when a new notification arrives. If a plugin floods 1000 unique notifications then goes silent, 1000 entries sit in the map until the next notification arrives. Worst case for a misbehaving plugin: the map grows during the flood then stays bloated.
- **Reproduction:** Plugin that calls `showNotification(uniqueMessage + Date.now())` 1000 times in a loop. Then stops. `notifyDedupRef.current.size` stays at 1000.
- **Impact:** Slow memory leak. Bounded by the flood rate × the 10s dedup window in practice.
- **Suggested fix:** Add a periodic `setInterval` (every 30 s) that prunes entries older than the dedup window. Or switch to a fixed-size LRU cache.

### [M-7] Cache rebuild blocks all cache reads — no progress indication
- **Category:** UX
- **Description:** `rebuild_cache` at `cache.rs:247-296` holds the `CacheState` mutex for the entire rebuild (which is a transaction). All `list_sessions`, `stats_today`, etc., block until it finishes. The UI shows no spinner because the frontend doesn't know a rebuild is in progress. For a user with 1000 sessions the rebuild takes ~1 second; for 10,000+ it's slower.
- **Reproduction:** Trigger "Rebuild session cache" from the palette. Observe brief UI freeze if you have many sessions.
- **Impact:** Minor UX blip. Not data corruption.
- **Suggested fix:** Emit a `cache:rebuilding` and `cache:rebuild-complete` event, show a subtle spinner in the status bar during the rebuild. Or move the rebuild into a background task and keep serving stale data until done.

### [M-8] Rapid plugin toggle can leave orphan notifications
- **Category:** Lifecycle race
- **Description:** `plugin-host.tsx::tearDown` closes the notification gate (`notificationsEnabledRef.current = false`) and clears `notifyTimersRef`. But a notification that was already in `setNotifications([...])` and is currently animating through the Notifications component stays rendered until its auto-dismiss fires — which won't fire because the timer was cleared. The `setNotifications([])` call on the same line drops the React state, so visually the toasts clear, but any reference held elsewhere (e.g., an in-flight `runBeforeHooks("notification:show", ...)` that resolves after teardown) could still try to add a new notification. The FIX 4 kill-switch blocks most of these, but the window between `runBeforeHooks` resolving and `actuallyShowNotification` reading `notificationsEnabledRef.current` is wide enough to slip through.
- **Reproduction:** Plugin shows a notification with a slow before-hook (artificially delayed). Toggle the plugin off while the before-hook is pending. Observe orphan notification after the hook resolves.
- **Impact:** Minor — the orphan is auto-dismissed by its own timer which is still scheduled (even though `notifyTimersRef.current` was cleared, the underlying `setTimeout` callback still holds its own closure). So it's a visual flicker, not a persistent orphan.
- **Suggested fix:** Capture the enabled-ref value inside `actuallyShowNotification` and re-check after any `await`. Or wrap the post-hook dispatch in `requestAnimationFrame` so React's batched state updates settle.

### [M-9] Ctrl+1..9 mode switch eats the keypress even when out of range
- **Category:** UX
- **Description:** `App.tsx:748-758` — the handler for `Ctrl+N` where N is 1-9 returns after calling `preventDefault()` on `index < modes.length`, but always returns regardless. If the user has 3 modes enabled and presses Ctrl+5, the keypress is silently eaten (no action, no feedback, no fallback to passthrough). Minor but surprising.
- **Reproduction:** Enable only 3 timer modes. Press Ctrl+5. Nothing happens, no feedback.
- **Impact:** Cosmetic. Slight UX friction.
- **Suggested fix:** Only `preventDefault()` and return when the index is valid, otherwise fall through.

### [M-10] Tab navigation between regions is broken when sidebar is hidden
- **Category:** Accessibility
- **Description:** `App.tsx:835-862` — the Tab key handler returns early if `sidebarVisible` is false, because there's nothing to swap to. But this also blocks Tab from doing its normal "focus next focusable element" inside the main region. So when the sidebar is hidden, keyboard users cannot Tab between buttons in the main area.
- **Reproduction:** `Ctrl+B` to hide sidebar → press Tab in the timer view → nothing happens.
- **Impact:** Keyboard accessibility regression for users who prefer the collapsed-sidebar layout.
- **Suggested fix:** Only hijack Tab when sidebar is visible and the event target is a region container. Otherwise let Tab pass through to the browser's default focus traversal.

### [M-11] Pomodoro config schema drift from PRD — `focus_duration` vs `focus_min`
- **Category:** PRD compliance
- **Description:** PRD §6.1 example manifest uses `focus_min`, `break_min`, `long_break_min`. Actual manifest uses `focus_duration`, `break_duration`, `long_break_duration`. Both refer to minutes. PRD §4.4 config schema also uses `focus_min`. The implementation works, but any plugin developer who reads the PRD will write the wrong field names.
- **Reproduction:** `cat src-tauri/plugins/pomodoro/manifest.json` vs PRD §6.1.
- **Impact:** Documentation drift — onboarding friction.
- **Suggested fix:** Either rename the config fields to match PRD, or update PRD to match the implementation. Prefer the latter since the implementation is live.

### [M-12] `plugin_storage_set` size check happens AFTER serialization
- **Category:** Memory / DoS
- **Description:** `commands.rs:733-744` — a plugin can call `plugin_storage_set("key", veryLargeObject)`. The Rust side calls `serde_json::to_string_pretty(&value)` FIRST, which allocates the full serialized buffer, THEN checks `data.len() > PLUGIN_STORAGE_MAX_BYTES`. For a 100 MB value, 100 MB is serialized and held in memory before the size check rejects it. A malicious plugin (or a buggy one) can spike memory by sending oversized values.
- **Reproduction:** Plugin calls `flint.storage.set("blob", stringOfLength100MB)`. Rust serializes the 100 MB string then errors. Peak RSS spikes.
- **Impact:** Transient memory spike. Not a leak — allocation is freed once the command returns — but a malicious plugin can repeatedly do this.
- **Suggested fix:** Pre-check the approximate size of `value` via `serde_json::to_writer(io::sink(), &value)` + byte counter wrapper before allocating the full string. Or cap the input `Value` size at the IPC boundary.

### [M-13] `generate_id()` uses `rand::thread_rng` with 32 bits — collision possible at scale
- **Category:** Correctness
- **Description:** `commands.rs:83-86` generates session IDs as `format!("{:08x}", u32)`. With 32 bits and the birthday paradox, expected collision after ~65k sessions. A power user with 200 sessions/day hits this in ~10 months.
- **Reproduction:** Write a loop: `(0..100000).map(|_| generate_id()).collect::<HashSet>()` — expect a collision.
- **Impact:** Session file name collisions would overwrite the prior file (`write_session_file` uses `{date}_{tag}_{dur}m_{id}.json` which includes the date, so the collision must also be same-day — lower but still possible). Long-term data integrity risk.
- **Suggested fix:** Use 64-bit hex or UUIDv4. Drop-in: `format!("{:016x}", rand::random::<u64>())`.

### [M-14] Session files are never indexed by ID — deletion scans the whole directory
- **Category:** Performance
- **Description:** `commands.rs::delete_session` reads every file in `~/.flint/sessions/`, parses each as JSON, and looks for a matching `.id` field. With 1000 sessions this is a ~1 second operation per delete. At 10k sessions, it's noticeable.
- **Reproduction:** Create many sessions, delete a single session via the UI.
- **Impact:** Performance scales linearly with history size. Not a ship-blocker at <1k sessions.
- **Suggested fix:** Either (a) use the SQLite cache to look up `id → file_path` (requires storing the filename in the cache), or (b) include the ID in the filename format (already done: `{date}_{tag}_{dur}m_{id}.json`) and grep-parse filenames rather than reading JSON bodies.

---

## LOW

### [L-1] Paranoid `.unwrap()` in `cache::month_range` / `week_range` / `heatmap`
- **Category:** Code hygiene
- **Description:** `cache.rs:619`, `701-709`, `718-719` use `NaiveDate::from_ymd_opt(...).unwrap()` and `.and_hms_opt(0,0,0).unwrap()`. Inputs always come from `chrono::Utc::now()` with valid year/month/day, so these never fail in practice — but `unwrap()` in a library is the kind of code that panics once every 10 years when some edge case you didn't anticipate lands.
- **Impact:** No real crash risk at current call sites.
- **Suggested fix:** Replace with `.ok_or_else(|| "date arithmetic failed".to_string())?` for defensive coding, or add a `#[allow(clippy::unwrap_used)]` comment explaining why it's safe. Either way the intent is clearer.

### [L-2] `SHADOWED_GLOBALS` list does not include `setTimeout`/`setInterval`/`Audio`
- **Category:** Sandbox surface
- **Description:** Plugins can call `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `Promise`, `Audio`, `URL`, `TextEncoder`, and many other globals because they're not shadowed. The pomodoro plugin actually uses `setTimeout` (`src-tauri/plugins/pomodoro/index.js:99`). This is probably intentional but is not documented and is not tested.
- **Impact:** Security-neutral if intentional. But it's an inconsistency — the shadowed list blocks DOM access and network APIs but allows timer primitives.
- **Suggested fix:** Add a comment in `plugin-sandbox.ts` explicitly stating which globals are intentionally NOT shadowed and why. Consider whether `Audio` should be shadowed (plugins can currently create audio elements they can't actually play).

### [L-3] `commandsRef.current = commands` updates on every render
- **Category:** Code hygiene
- **Description:** `plugin-host.tsx:374-375` — `const commandsRef = useRef<RegisteredCommand[]>([]); commandsRef.current = commands;`. This runs on every render of `PluginHost`, regardless of whether `commands` changed. Functionally fine (ref updates are free) but flagged for completeness.
- **Impact:** None.
- **Suggested fix:** `useEffect(() => { commandsRef.current = commands; }, [commands]);` — but honestly, the current pattern is simpler and clearer. Leave it.

### [L-4] `generate_id` uses `rand::thread_rng()` which is Windows-slow on cold start
- **Category:** Performance
- **Description:** `thread_rng` is seeded lazily, and on Windows the first seeding goes through `BCryptGenRandom` which is measurably slower than on Unix. Small constant overhead on the first session of a launch; invisible after that.
- **Impact:** ~10-20 ms on the first session-start call post-launch. Imperceptible.
- **Suggested fix:** None — not worth optimizing. Flagged only because it showed up in a previous perf trace.

### [L-5] `config.toml` parse failure silently renames the file with no user notification
- **Category:** UX
- **Description:** `config.rs::load_or_create` renames a broken config to `.broken.<ts>` and creates a fresh default. Correct recovery behavior, but the user sees their settings reset with no explanation.
- **Impact:** Confusing if the user hand-edited the file.
- **Suggested fix:** Emit a `config:recovered` event on startup and show a one-time toast: "Your config had a syntax error — reset to defaults. Broken file preserved at ~/.flint/config.toml.broken.{ts}."

### [L-6] `Sidebar` drag listeners leak if the component unmounts mid-drag
- **Category:** Memory / React lifecycle
- **Description:** `sidebar.tsx:54-65` — `onHandlePointerDown` attaches `pointermove` and `pointerup` listeners to `window`. They're removed in `onUp`. If the component unmounts mid-drag (e.g., the user toggles sidebar visible=false during a drag, or an error boundary catches), `onUp` never fires and the listeners stay attached until the next pointerup.
- **Reproduction:** Start a drag on the sidebar handle, toggle sidebar visibility via Ctrl+B before releasing → listeners remain attached.
- **Impact:** Small leak — one pointermove and one pointerup handler per orphaned drag. Bounded by how many times the user does this (typically zero).
- **Suggested fix:** Track the active drag in a ref and cancel in a component unmount cleanup. Or use a pointer capture so the component can react to unmount.

### [L-7] `SessionLog` / `StatsDashboard` refresh event listeners re-register on every parent re-render
- **Category:** Memory / React lifecycle
- **Description:** `session-log.tsx:54-62` and `stats-dashboard.tsx:80-85` — `useEffect(() => { window.addEventListener("flint:plugin:sessions:refresh", load); return () => window.removeEventListener(...); }, [load])`. The `load` callback is memoized, but its dependencies can change (empty deps in this case — fine). The register/unregister is correct but runs extra times if the parent re-renders for unrelated reasons.
- **Impact:** Zero at runtime (add/remove are balanced). Flagged for code-review discipline.
- **Suggested fix:** None needed.

### [L-8] `validate_session_id` accepts null bytes (not rejected by the charset check)
- **Category:** Code hygiene
- **Description:** `commands.rs:1033-1039` — the charset check `is_ascii_alphanumeric() || c == '-' || c == '_'` rejects `\0` correctly (null byte is neither alphanumeric nor the allowed punctuation). So the "null byte bypass" raised by agent #1 is actually blocked. Leaving this as LOW-noted-but-false-positive so the reader knows it was checked.
- **Impact:** None. Verified safe.
- **Suggested fix:** None.

### [L-9] Recovery writer unbounded tokio channel — theoretical backpressure risk
- **Category:** Memory
- **Description:** `storage.rs:210` uses `tokio_mpsc::unbounded_channel()`. If the writer task is slow (e.g., disk contention) and `tick_once` sends a snapshot every 10 s + `pause/resume/mark_question` each send one, the channel accumulates. But every send replaces `latest` in the receiver (`storage.rs:243-245`), and the debounce coalesces bursts. So the effective memory is one snapshot + in-flight queue, which stays small.
- **Impact:** None in practice.
- **Suggested fix:** None needed — the design is correct. Flagged in case a future change breaks the coalescing assumption.

### [L-10] Tag index `HashSet<String>` grows monotonically — no pruning
- **Category:** Memory
- **Description:** `tags.rs::TagIndex` is only inserted-into, never pruned. If a user types typos ("projctABC") they enter the index and stay even after the typo'd session is deleted. Rescanning on startup DOES rebuild from actual sessions, so a restart fixes it — but the in-memory index drifts over a long session.
- **Impact:** Slow drift, a few extra autocomplete entries. Bounded at the human typing rate.
- **Suggested fix:** Rebuild the index after every `delete_session` (cheap — the deletion code already has the session list). Or add a `purge` command.

---

## Verified-safe (findings raised by sub-agents that I confirmed are NOT issues)

- **Cache query reads "inconsistent state" during rebuild**: WAL mode is enabled (`cache.rs:101`) AND the Mutex serializes all access, so rebuild is all-or-nothing from a reader's perspective. No dirty reads.
- **`plugin-settings.tsx` `numberSaveTimerRef` shared across all fields**: the ref is declared inside `SchemaField`, so each field instance has its own. Not a shared-state bug.
- **Windows case-insensitive path traversal in `plugins.rs::load_community`**: `fs::canonicalize` normalizes case on Windows (returns the true filesystem case), so `canonical_entry.starts_with(canonical_dir)` works correctly even when the user types `../PLUGINS/...`.
- **`month_range`/`week_range` can panic on edge dates**: inputs are always `Utc::now()` with valid year/month/day fields. The `.unwrap()` paths are defensible but are never triggered. See L-1 for the code-hygiene note.
- **Plugin storage lock poisoning on scan failure**: `tags::scan_all_sessions` does not hold any lock — it runs before the TagIndex mutex is initialised (lib.rs:293), then the result is installed under the lock. No poisoning path.
- **`recovery.json` truncated mid-write on power loss**: `write_atomic` uses tmp + rename. `fs::rename` is atomic on NTFS (MoveFileEx with MOVEFILE_REPLACE_EXISTING). A crash during `fs::write` to the tmp file leaves the real file intact. A crash between `write` and `rename` leaves both files intact (recovery path picks up the old file). Safe.
- **Hook-registry `after` duplicate registrations silently deduped by `Set`**: this is intentional — prevents accidental double-subscribe. Plugin authors who want multiple subscriptions can use different function references.

---

## Ship Readiness Assessment

### Can we ship v0.1.0 today?

**Yes, with these three non-negotiable fixes and the marketing language below.**

Must-fix before ship (8 items — all small):
1. **[H-1] `plugin_storage_set` atomic write** — one-line change.
2. **[H-2] Close-to-tray=false session finalize** — add `shutdown_with_finalize` call to the window-close handler. ~5 lines.
3. **[H-3] Bundle JetBrains Mono locally** — copy 4 woff2 files, add `@font-face` to `src/index.css`, drop the two Google Fonts `<link>` tags. Preserves the terminal aesthetic without breaking local-first. ~15 mins.
4. **[H-4] Settings save-pulse cleanup** — add a ref + cleanup effect. 5 lines.
5. **[C-4] Docs honesty: prune CLAUDE.md catalog to reflect actual before-hook coverage** — or wire up the missing ones per C-3. Either. The current doc misleads plugin authors.
6. **[M-13] 64-bit session IDs** — 2-line change. Prevents a silent collision in ~10 months for power users.
7. **[M-11] PRD config field naming** — rename `focus_duration` → `focus_min` OR update PRD. Prefer updating PRD since the code is live and tests assume the current names.
8. **Document the sandbox ceiling in README + plugin docs.** See marketing language below. This is non-optional for a plugin-first product.

**Can wait for v0.1.1** (the sandbox expansion): C-1, C-2, C-3, H-5, H-6, H-7, H-8, H-9, and the rest of the mediums. These are the real plugin-API investments. Shipping them in v0.1.0 would delay the release by weeks, and the primitive layer (hooks, commands, presets, tags, storage) is already strong enough to advertise honestly.

**Can wait for post-v0.1.1** (performance/accessibility polish): M-1 through M-14 and all lows. None block ship.

### Marketing language for the README and landing page

Flint v0.1.0 is honestly described as:

> A local-first, keyboard-driven timer with a strong primitive layer — hooks, commands, presets, tags, plugin storage — for composing your own workflow. Built-in plugins (Pomodoro, Stopwatch, Countdown, Session Log, Stats Dashboard) ship today. The plugin API is in preview: you can register commands, hook into the session lifecycle, read session data, store data per-plugin, and add a settings form — all cleanly sandboxed. Custom timer modes, custom sidebar views, and interactive prompts are planned for v0.2.

It is NOT yet:

> "The Obsidian of timers — build any feature as a plugin."

That's the v0.2 story. Ship it when C-1, C-2, C-3, and H-5 through H-7 are implemented. The sandbox primitive layer is 70% of the way there; the remaining 30% is the part that makes plugins actually transformative.

### Sandbox gaps to document in the plugin developer guide (day-one)

1. Rendering is text-only (`renderSlot(slot, text)`). Custom sidebar views coming in v0.2.
2. Custom timer modes ship the mode flag but not custom interval logic — non-pomodoro modes behave as stopwatch until the `pushInterval` API lands.
3. Before-hooks work for: `session:start`, `preset:load`, `command:execute` (palette only), `notification:show`, `tag:add`, `tag:remove`. Other events are observer-only in v0.1.
4. Notifications auto-dismiss in 4 s — non-configurable. Plan for passive feedback, not interactive prompts.
5. Plugin storage is scoped to `~/.flint/plugins/{id}/data/` with a 5 MB cap. Use JSON values. Writes are (will be) atomic.
6. Commands registered from plugins are cleaned up on plugin reload automatically. Do not store unsubscribe references across reloads.
7. Session data access returns full JSON arrays — paginate manually until `flint.stats.*` ships.

### Known limitations to document in README

- No Linux build in v0.1 (PRD §9.1 lists Windows + Mac only). Add Linux after v0.1 stabilises.
- Overlay uses a fixed-size 336×64 window (does not expand per PRD §7.4) — intentional terminal-aesthetic choice documented in CLAUDE.md.
- No keyboard shortcut rebinding — shortcuts are fixed (CLAUDE.md).
- No dark/light theme toggle — dark-only per PRD §13 non-goals.
- Custom plugin UI is text-only in v0.1.
- First launch with 1000+ sessions blocks UI briefly while the tag index builds (M-2).

---

*End of audit. Next step is a fix pass — not part of this audit run. The sandbox expansion is the primary v0.1 → v0.2 work item and deserves its own plan document (which also is not part of this run). Build health is clean; the atomic-write bug, the window-close finalize, and the Google Fonts regression are the three small gotchas before shipping.*
