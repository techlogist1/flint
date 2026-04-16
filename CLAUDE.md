# Flint

Open-source, local-first, keyboard-driven, plugin-extensible timer for focused work. Tauri 2.0 + React + TypeScript + Tailwind + Rust + SQLite.

## Philosophy

The Obsidian of timers. Flint provides primitives — hooks, commands, presets, tags, render specs, prompts, plugin storage — and users compose their own workflow on top. After the v0.1 → v0.2 sandbox expansion (the AUDIT_V3 follow-on), adding any new capability is writing a `manifest.json` + `index.js`, never a core code change. The Pomodoro plugin is the proof: it now drives its own focus/break/long-break math through `flint.setFirstInterval` / `flint.setNextInterval` instead of relying on hardcoded engine logic.

The constraint that makes this work is that plugins never execute against the DOM directly. They describe what to render via JSON specs the host interprets; they describe what to ask via a prompt primitive the host renders; they declare interval directives the engine consumes. The sandbox keeps the security guarantee, the primitive layer keeps the power.

## Stack

- Tauri 2.0 (Rust backend + React frontend, ~5–8 MB binary)
- React 18 + TypeScript (strict, no `any`) + Tailwind CSS
- SQLite read cache + JSON session files (source of truth)
- JS plugins with `manifest.json`, loaded at startup from built-in resources and `~/.flint/plugins/`

## File locations

```
~/.flint/
├── sessions/              # completed sessions, one JSON per session (source of truth)
├── plugins/               # community plugins, each in its own folder
│   └── {id}/
│       ├── manifest.json
│       ├── index.js
│       └── data/          # per-plugin storage (flint.storage API)
├── presets/               # saved session configurations, one JSON per preset
├── config.toml            # global configuration
├── cache.db               # SQLite read cache (rebuildable, deletable)
├── recovery.json          # active-session auto-save; deleted on clean end
└── state.json             # app state (first-close toast shown, etc.)
```

## Architecture invariants

- **Timer engine runs in Rust.** Frontend listens to Tauri events. Frontend NEVER runs its own timer.
- **Timer engine is plugin-driven** with hardcoded fallbacks. The engine consumes `pending_first_interval` / `pending_next_interval` slots populated by `flint.setFirstInterval` / `flint.setNextInterval` calls from plugins. If a plugin doesn't push an interval (or the slot is empty), the engine falls back to its hardcoded pomodoro / countdown branch for backward compatibility. The Pomodoro plugin is the first consumer; community timer modes can ship the same way.
- **Before-hook coverage spans the full timer lifecycle.** `session:start`, `session:pause`, `session:resume`, `session:stop`, `session:cancel`, `question:mark`, `interval:next`, `preset:load`, `command:execute`, `notification:show`, `tag:add`, `tag:remove` all fire through `runBeforeHooks` from the JS wrappers. The keyboard handlers, palette commands, and tray menu all go through these wrappers — there is no "back door" that bypasses the pipeline. (See [C-3] / [C-4] in `AUDIT_V3_RUNTIME.md` for the historical gap.)
- **Session files are source of truth.** SQLite cache is rebuildable — treat it as disposable.
- **Recovery file is written off the engine mutex** via the background `RecoveryWriter` tokio task (`storage.rs`). Snapshots are cheap clones taken under the lock and shipped to the writer; the disk write happens outside the lock.
- **All file writes are atomic** (`storage::write_atomic` → tmp + rename). Applies to sessions, recovery, presets, state.json, plugin storage, exports.
- **Plugins are sandboxed.** They receive a `flint` API object and have `window`, `document`, `fetch`, `localStorage`, `__TAURI__`, etc. shadowed to `undefined` (`plugin-sandbox.ts`). They cannot reach the filesystem or core state except through the API.
- **Plugin handlers run inside `safeCallPlugin` / `safeCallHook`** with a 5-second timeout. A buggy or slow plugin cannot wedge the host.
- **Notifications honor per-notification duration** within a 1-second to 15-second cap. Capped at 3 visible + per-plugin dedup window. Plugins request a duration via `options.duration`; the host clamps it to the safe range. (Replaces the old hardcoded 4 s.)
- **Render specs are JSON, never HTML.** Plugin-authored content reaches React as structured children only — there is no `dangerouslySetInnerHTML` path. Every widget type is a host-defined React component selected by `spec.type`.
- **Interval transitions are rate-limited** at 2 seconds between calls (`INTERVAL_TRANSITION_COOLDOWN`) so no plugin can stack rapid-fire transitions.
- **Tick loop uses `MissedTickBehavior::Skip`** so a stalled tick body doesn't cause a burst of catch-up ticks.

## Hook system (`flint.hook` / `flint.on` / `flint.emit`)

Flint has a two-phase hook pipeline:

- `flint.hook(event, handler)` — register a **before-hook** (interceptor). Handlers run sequentially in registration order. Each receives a context object they can mutate. Any handler that returns `{ cancel: true }` aborts the action entirely. Returns an unsubscribe function.
- `flint.on(event, handler)` — register an **after-hook** (observer). Maps to the existing plugin API unchanged. Observers cannot cancel.
- `flint.emit(event, context)` — runs the full pipeline: before-hooks → (optional action by core code) → after-hooks, plus a legacy `window.CustomEvent("flint:plugin:${event}")` broadcast for host-React listeners.

Handlers are tracked per plugin id. On plugin reload (enable/disable/reload), every handler owned by that plugin is cleared automatically via the Component-style teardown in `plugin-host.tsx`. Core-owned hooks (registered by `registerCoreHook`) are preserved across reloads.

### Event catalog

| Event | `before:` context (mutable) | After payload | Notes |
| --- | --- | --- | --- |
| `session:start` | `{ plugin_id, mode, config, tags, preset_id }` | `{ session_id, mode, tags }` | Cancel drops the session before any Rust work runs |
| `session:pause` | `{ elapsed_sec }` | same | Wired through the keyboard / palette / overlay wrappers |
| `session:resume` | `{ elapsed_sec }` | same | Same wrappers as pause |
| `session:stop` | `{ session_id, elapsed_sec, source }` | n/a (engine fires `session:complete`) | Cancel suppresses the stop entirely |
| `session:complete` | — (engine-fired) | `{ session_id, duration_sec, questions_done }` | After-only |
| `session:cancel` | — (engine-fired) | `{ session_id, duration_sec }` | After-only |
| `interval:start` | — (engine-fired) | `{ type, target_sec? }` | After-only |
| `interval:end` | — (engine-fired) | `{ type, duration_sec }` | After-only — call `setNextInterval` here to author the next phase |
| `interval:next` | `{ from_type, to_type?, target_sec?, source }` | n/a | Cancel suppresses the transition; mutate to override the next type |
| `question:mark` | `{ current_count }` | `{ total_questions }` | Cancel ignores the keypress |
| `notification:show` | `{ title, body, plugin_id, duration }` | same (after render) | Mutating `body` rewrites the toast |
| `preset:load` | `{ preset, config_overrides }` | same | Cancel keeps the user on their current config |
| `tag:add` / `tag:remove` | `{ tag, current_tags }` | same | Cancel keeps the tag set unchanged |
| `command:execute` | `{ command_id, source }` | same | Both palette and direct invocation route through this hook |
| `app:ready` | — | `{}` | After-only — fires once, after plugins finish loading |
| `app:quit` | — | `{}` | After-only — fires before tear-down |

**Cancellation semantics:** A before-hook returning `{ cancel: true }` short-circuits the pipeline — no action runs and no after-hook fires. Handlers can also mutate the context object in place to modify downstream behavior (e.g. rewriting `tags` or `config_overrides`).

**Caveat:** `interval:start` / `interval:end` / `session:complete` / `session:cancel` are still fired from Rust directly. They are observer-only because the engine cannot synchronously call back into JS during a tick. Use `interval:next` (the JS-side wrapper that runs before the engine advances) if you need to intercept.

## Command system (`flint.registerCommand`)

Every action in Flint is a named, searchable, executable command. The command palette (Ctrl+P) is the universal entry point.

```ts
flint.registerCommand({
  id: "plugin_id:action_name",
  name: "Display name",
  callback: () => void | Promise<void>,
  icon?: "▶",           // unicode glyph, optional
  hotkey?: "Ctrl+P",    // informational badge, optional — Flint does not bind it
  category?: "session", // grouping label, optional
});
// Returns an unsubscribe function. Auto-cleaned on plugin unload.
```

Id format: `plugin_id:action_name` for plugin commands, `core:action_name` for core commands. Duplicate ids lose to the last registration (warned in console).

### Core commands registered by the app shell

- `core:start-session`, `core:stop-session`, `core:pause-session`, `core:resume-session`, `core:mark-question`
- `core:switch-plugin:{id}` — one per enabled timer-mode plugin, re-registered when the plugin list changes
- `core:toggle-overlay`, `core:toggle-sidebar`, `core:open-settings`, `core:toggle-command-palette`
- `core:open-tag-input`, `core:create-preset`, `core:manage-presets`
- `core:export-sessions`, `core:open-data-folder`, `core:rebuild-cache`
- `core:delete-selected-session` — deletes the session currently open in the detail view (no-op otherwise)
- `core:quit-app`
- `preset:load:{preset_id}` — auto-registered per preset, appears as `Start: {preset_name}`
- `core:edit-preset:{preset_id}` / `core:delete-preset:{preset_id}` — one each per preset, re-registered when the preset list changes

### Built-in plugin commands

After the AUDIT_V3 sandbox polish, every built-in plugin registers commands so the palette always has actionable entries:

- `pomodoro:skip-interval` — ends current interval and triggers nextInterval
- `pomodoro:reset-cycle` — resets the in-session cycle counter
- `stopwatch:mark-lap` — fires `flint.markQuestion()` (interpreted as a lap in stopwatch mode)
- `countdown:abort` — calls `flint.stopSession()` for the active countdown
- `session-log:refresh` — emits the sessions-refresh event
- `stats:refresh` — emits the stats-refresh event

### Palette behaviour

- Opens on Ctrl+P, closes on Escape or click-outside. No animation.
- Fuzzy search (consecutive char matches, word-boundary bonus, prefix bonus) via `src/lib/command-registry.ts`.
- Arrow keys navigate, Enter executes, Ctrl+P toggles.
- Empty-query ordering is MRU (last-used timestamps in `commandMruShared`, not persisted).
- Every execution fires `before:command:execute` → callback → `after:command:execute`, so plugins can veto commands or observe them.

## Preset system (`~/.flint/presets/*.json`)

Saved session configurations. Presets are first-class citizens stored as plain JSON files, one per preset. The source of truth is the filesystem; there is no in-memory cache beyond the rendered list.

### Schema

```json
{
  "id": "16-char-hex × 2",
  "name": "Deep Work",
  "plugin_id": "pomodoro",
  "config_overrides": {
    "focus_duration": 45.0,
    "break_duration": 10.0,
    "cycles_before_long": 0,
    "auto_start_breaks": true
  },
  "tags": ["project", "deep-work"],
  "pinned": true,
  "sort_order": 0,
  "created_at": "2026-04-15T10:00:00Z",
  "last_used_at": null
}
```

### Tauri commands (`src-tauri/src/commands.rs` → `presets.rs`)

- `list_presets() -> Vec<Preset>` — scans `~/.flint/presets/`, sorted pinned-first then `sort_order` then name.
- `save_preset(preset: PresetDraft) -> Preset` — validates, writes atomically via `storage::write_atomic`. If `id` is supplied, updates in place preserving `created_at`/`last_used_at` (this is also the edit flow — the frontend passes the existing preset id to update in place).
- `delete_preset(id: String) -> ()`
- `load_preset(id: String) -> Preset`
- `touch_preset(id: String) -> ()` — bumps `last_used_at` to now.

### Preset form (create vs edit)

`PresetForm` (`src/components/preset-form.tsx`) is used for both create and edit. When `editing` is null the form is a blank "NEW PRESET"; when `editing` is a `Preset`, fields are pre-populated and the header flips to "EDIT PRESET". Save always goes through `save_preset` — the distinguishing factor is whether `id` is supplied in the draft.

The configuration section is **dynamic**: when a plugin is selected, the form reads `plugin.manifest.config_schema` and renders number / boolean / string / select fields for every entry (same renderer as the settings panel). The baseline is fetched live from `get_plugin_config(pluginId)` on mount / plugin change, so overriding "focus duration" starts at whatever the user's current config.toml has for that plugin. When editing, existing `config_overrides` are layered on top of the live baseline. On submit, the form filters overrides down to keys actually present in the active plugin's schema so switching plugins mid-edit does not leak stale keys into the preset JSON.

### Config override mechanics (`SessionOverridesState`)

Preset overrides are **session-scoped and temporary**. They live in `SessionOverridesState(Mutex<Option<ActiveOverride>>)` and never touch `config.toml`. The flow:

1. User loads preset → frontend `loadPreset()` fires `before:preset:load`.
2. `start_session` is invoked with `overrides: Option<Value>`.
3. Rust stores overrides in `SessionOverridesState` and uses `merged_config()` (base config + overrides serialized through `presets::apply_overrides_to_config`) to build the first interval.
4. Subsequent `next_interval` calls read `SessionOverridesState` via `session_overrides.snapshot()` so long/short break durations honour the preset.
5. `get_plugin_config` merges overrides into its return value, so `flint.getConfig()` from the running plugin reflects the overridden values.
6. `finalize_session` clears `SessionOverridesState` — the next session falls back to saved config.toml values.

This is what makes presets safe: users can experiment with durations knowing they will not clobber their base config.

## Tag system (`get_known_tags`)

Tag index is a plain `Mutex<HashSet<String>>` (`src-tauri/src/tags.rs`) that holds every unique tag seen across saved sessions. The index is **not persisted** — it is derived:

- At startup, `tags::scan_all_sessions` is dispatched **asynchronously** on a background tokio task so the first paint is not blocked. The index is empty until the scan completes and `get_known_tags` returns whatever subset has been added so far. (Pre-AUDIT_V3 the scan was synchronous; see `[M-2]` in the audit.)
- `start_session` and `finalize_session` both call `tags::insert_many` so new tags are visible immediately without waiting for a restart.
- `get_known_tags` returns a case-insensitively sorted snapshot.

Frontend `TagAutocomplete` (`src/components/tag-autocomplete.tsx`) calls `get_known_tags` once on mount and filters client-side. Suggestions match `includes()` on a lowercased query, ranked by `startsWith()` bonus. `tag:add` / `tag:remove` hook events fire for every change so plugins can veto or react.

## Quick-start bar

Idle-view strip that renders up to 4 pinned presets (`src/components/quick-start-bar.tsx`). Number keys `1..4` map to these slots while the timer is idle, the view is `timer`, and no overlay (tag input / stop confirm / palette / preset form) is open. Bare keys — no modifier — so the muscle memory is instant. If no presets exist, the bar renders a muted hint pointing at `Ctrl+P → "create preset"`.

## Interval authoring (`flint.setFirstInterval` / `flint.setNextInterval`)

The Rust engine no longer hardcodes pomodoro math as the only "real" mode. Plugins now author their own intervals through two API methods:

```ts
flint.setFirstInterval({ type: string, target_sec?: number, metadata?: unknown }): Promise<void>
flint.setNextInterval({ type: string, target_sec?: number, metadata?: unknown }): Promise<void>
```

Both methods push a directive into a per-session pending slot (`pending_first_interval` / `pending_next_interval`) inside `EngineState`. The engine consumes the slot when it builds the next interval — replacing whatever its hardcoded fallback would have produced. After consumption the slot clears, so the plugin must push a fresh directive for every transition.

### When to call

- **`setFirstInterval`** — call from a `before:session:start` hook. The engine consumes the pending slot inside the same `start_session` invocation, before any timer ticks fire. If you call it after the session is already running, the engine ignores it (the first interval is already built).
- **`setNextInterval`** — call from an `after:interval:end` handler (or a `before:interval:next` hook). The plugin handler runs synchronously before the user's auto-start logic — or before the `flint.nextInterval()` call you issue yourself — so the pending slot is populated before the engine consumes it.

### Backward compatibility

Both methods are wrapped in try/catch in every built-in plugin. If the host doesn't expose them (older Rust build), the call silently no-ops and the engine falls back to its hardcoded pomodoro / countdown branch. The Pomodoro plugin verifies the typeof check before calling — see `src-tauri/plugins/pomodoro/index.js` for the exact pattern.

### Pomodoro plugin (worked example)

```js
// before-hook: declare the first focus interval
flint.hook("session:start", (ctx) => {
  if (ctx.mode !== "pomodoro") return;
  const cfg = await flint.getConfig();
  const focusSec = Math.round((cfg.focus_duration ?? 25) * 60);
  await flint.setFirstInterval({ type: "focus", target_sec: focusSec });
});

// after-hook: drive the next transition
let cyclesDone = 0;
flint.on("interval:end", async (payload) => {
  if (payload.type === "focus") cyclesDone += 1;
  const cfg = await flint.getConfig();
  const isLong = cyclesDone > 0 && cyclesDone % cfg.cycles_before_long === 0;
  const next =
    payload.type === "focus"
      ? { type: isLong ? "long-break" : "break",
          target_sec: Math.round((isLong ? cfg.long_break_duration : cfg.break_duration) * 60) }
      : { type: "focus", target_sec: Math.round(cfg.focus_duration * 60) };
  await flint.setNextInterval(next);
  await flint.nextInterval();
});
```

The actual file (`src-tauri/plugins/pomodoro/index.js`) wraps every call in defensive try/catch and includes a 500 ms transition-deferral guard (FIX 2) plus a `transitioning` flag against stacked transitions. The shape above is the pattern; copy the live file for production-quality scaffolding.

### Custom timer modes

A plugin that wants to ship a brand-new mode declares `"timer_mode": true` in its manifest, then uses the same two API calls. The mode appears automatically in the tray menu, `Ctrl+1..9`, the default-mode dropdown, and the quick-start bar. Inside `start_session` the engine looks up the pending interval slot first, so a plugin that pushes its own directive bypasses the Rust fallback completely. Plugins that don't push anything still get the legacy untimed-focus interval (which acts like a stopwatch).

## Render spec system (`flint.registerView`)

Plugins describe UI declaratively. The host renders. Plugins never execute React, never touch the DOM, never see layout information.

```ts
flint.registerView(slot: string, renderFn: () => RenderSpec): () => void
```

`renderFn` is called by the host whenever the slot needs to repaint. The function returns a JSON-serialisable spec the host walks recursively to build a React tree.

### Slots

- `sidebar-tab` — full sidebar tab body. The tab label comes from the manifest. Multiple plugins can register sidebar tabs; the user picks one via the tab switcher.
- `settings` — appended to the plugin's settings section in Settings → Plugins. Auto-generated `config_schema` form still renders above whatever the plugin paints here.
- `post-session` — rendered briefly after a session ends in the main area.
- `status-bar` — inline entries in the bottom status bar.

### Widget types

The host walks `spec.type` and selects a React component. Unknown types render a muted placeholder.

| `type` | Props | Renders as |
| --- | --- | --- |
| `container` | `direction?: "row" \| "column"`, `gap?: number`, `padding?: number`, `children: RenderSpec[]` | A flex container — the default layout primitive |
| `text` | `value: string`, `variant?: "title" \| "body" \| "muted" \| "code"` | A `<span>` with terminal-aesthetic typography |
| `stat-row` | `label: string`, `value: string \| number`, `accent?: boolean` | Two-column "LABEL ……… VALUE" row |
| `bar-chart` | `data: { label: string, value: number }[]`, `height?: number`, `unit?: string` | Recharts `BarChart` with terminal palette |
| `line-chart` | `data: { x: string \| number, y: number }[]`, `height?: number` | Recharts `LineChart` |
| `heatmap` | `cells: { date: string, value: number }[]`, `weeks?: number` | GitHub-style square grid |
| `table` | `columns: { key: string, label: string }[]`, `rows: Record<string, unknown>[]`, `maxRows?: number` | Compact monospace table |
| `button` | `label: string`, `command: string` (registered command id), `icon?: string` | Click invokes the named command through the palette pipeline |

### Minimal example: a Session Analytics sidebar tab

```js
flint.registerView("sidebar-tab", () => {
  // The host calls this whenever it repaints the slot. Read from your
  // plugin's local state / cached stats here.
  return {
    type: "container",
    direction: "column",
    gap: 16,
    padding: 16,
    children: [
      { type: "text", value: "ANALYTICS", variant: "title" },
      {
        type: "stat-row",
        label: "Sessions today",
        value: stats.sessionsToday,
        accent: true,
      },
      {
        type: "stat-row",
        label: "Focus minutes",
        value: stats.focusMinutes,
      },
      {
        type: "bar-chart",
        height: 160,
        unit: "min",
        data: stats.lastSevenDays.map((d) => ({
          label: d.date,
          value: d.minutes,
        })),
      },
    ],
  };
});
```

### Why a spec instead of a callback

Plugins run in `new Function("use strict"; ...)` with the DOM globals shadowed. They cannot import React, cannot author JSX, cannot reach into the host's component tree. The spec system gives them a way to describe rich visualizations without granting access to the host's DOM. The host's spec interpreter wraps every plugin-authored render in `FlintErrorBoundary` so a malformed spec degrades to a placeholder instead of crashing the sidebar.

## Prompt primitive (`flint.prompt`)

```ts
flint.prompt({
  title: string,
  body?: string,
  accept: string,
  decline: string,
  timeout?: number, // ms, capped at 60000
}): Promise<"accepted" | "declined" | "dismissed">
```

The host renders a centered terminal-aesthetic dialog over the main view. The promise resolves when the user picks accept (`Enter` or click), decline (`Escape` or click), times out (the timeout argument), or the host tears the prompt down (e.g., session ends, plugin reload).

### Behaviour

- **Queue depth.** At most one prompt is visible at a time. Concurrent calls queue FIFO; a plugin that races against itself sees its later prompts wait until the earlier ones resolve.
- **Keyboard shortcuts.** Enter accepts, Escape dismisses, Tab toggles between the two buttons. The dialog steals focus when shown and returns it on resolve.
- **Timeout semantics.** If `timeout` is not supplied or is zero, the dialog is sticky until the user acts. Otherwise the promise resolves with `"dismissed"` after the timeout expires.
- **Cancellation.** If the plugin is reloaded while a prompt is open, the host resolves the pending promise with `"dismissed"` and tears the dialog down — same teardown pattern as the rest of the plugin lifecycle.

## Stats API (`flint.stats`)

Thin wrappers around the existing Rust `stats_*` commands so plugins can read pre-aggregated data from the SQLite cache instead of re-aggregating from raw session JSON.

```ts
flint.stats.today(): Promise<{ sessions: number, focus_sec: number, questions: number }>
flint.stats.range(scope: "week" | "month" | "year"): Promise<{ buckets: { date: string, focus_sec: number }[], total_sec: number }>
flint.stats.heatmap(days: number): Promise<{ cells: { date: string, value: number }[] }>
flint.stats.lifetime(): Promise<{ sessions: number, focus_sec: number, questions: number, longest_streak_days: number }>
```

These calls hit the cache directly and are O(rows in scope), not O(all sessions). Use them in any plugin that needs aggregate stats — Plugin 1 in `AUDIT_V3_RUNTIME.md` (Session Analytics) is the motivating example.

## Preset API (`flint.presets`)

Plugins can ship preset packs. The five preset commands are exposed verbatim:

```ts
flint.presets.list(): Promise<Preset[]>
flint.presets.save(preset: PresetDraft): Promise<Preset>
flint.presets.delete(id: string): Promise<void>
flint.presets.load(id: string): Promise<Preset>
```

`save` accepts a draft with or without an `id`. With an id, it updates in place preserving `created_at`. Without one, it creates a new preset with a freshly-generated id. The same atomic-write path used by the frontend applies — plugins never touch the filesystem directly.

Use this to bundle "starter packs" (e.g., Exam Mode shipping JEE / NEET / SAT presets on first load) without asking the user to manually re-enter durations.

## Plugin API (TypeScript reference)

```ts
interface FlintPluginAPI {
  // Hook system
  on(event: string, callback: (payload: any) => void): void;
  hook(event: string, handler: (ctx: any) => any | Promise<any>): () => void;
  emit(topic: string, payload?: unknown): Promise<{ cancelled: boolean }>;

  // Commands
  registerCommand(command: {
    id: string;
    name: string;
    callback: () => void | Promise<void>;
    icon?: string;
    hotkey?: string;
    category?: string;
  }): () => void;

  // Engine control (direct invokes — wrap in your own before-hook if you
  // need cancellation; the keyboard / palette / overlay paths already do).
  getTimerState(): Promise<TimerStateView>;
  getCurrentSession(): Promise<TimerStateView | null>;
  nextInterval(): Promise<void>;
  stopSession(): Promise<void>;
  pauseSession(): Promise<void>;
  resumeSession(): Promise<void>;
  markQuestion(): Promise<void>;

  // Interval authoring (NEW)
  setFirstInterval(spec: {
    type: string;
    target_sec?: number;
    metadata?: unknown;
  }): Promise<void>;
  setNextInterval(spec: {
    type: string;
    target_sec?: number;
    metadata?: unknown;
  }): Promise<void>;

  // Render spec (NEW)
  registerView(slot: string, renderFn: () => RenderSpec): () => void;

  // Prompt primitive (NEW)
  prompt(opts: {
    title: string;
    body?: string;
    accept: string;
    decline: string;
    timeout?: number;
  }): Promise<"accepted" | "declined" | "dismissed">;

  // Stats (NEW)
  stats: {
    today(): Promise<StatsToday>;
    range(scope: "week" | "month" | "year"): Promise<StatsRange>;
    heatmap(days: number): Promise<StatsHeatmap>;
    lifetime(): Promise<StatsLifetime>;
  };

  // Presets (NEW)
  presets: {
    list(): Promise<Preset[]>;
    save(preset: PresetDraft): Promise<Preset>;
    delete(id: string): Promise<void>;
    load(id: string): Promise<Preset>;
  };

  // Data
  getSessions(options?: {
    limit?: number;
    tags?: string[];
    since?: string;
  }): Promise<unknown[]>;
  getConfig(): Promise<Record<string, unknown>>;
  setConfig(key: string, value: unknown): Promise<void>;

  // UI
  renderSlot(slot: string, text: string): void; // text-only, never HTML
  showNotification(
    message: string,
    options?: { duration?: number; title?: string },
  ): void;

  // Per-plugin storage (atomic JSON files in ~/.flint/plugins/{id}/data/)
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
}
```

## Plugin sandbox

### Shadowed globals (resolve to `undefined` inside plugin source)

`window`, `document`, `globalThis`, `self`, `parent`, `top`, `frames`, `__TAURI__`, `__TAURI_INTERNALS__`, `__TAURI_INVOKE__`, `__TAURI_METADATA__`, `localStorage`, `sessionStorage`, `indexedDB`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator`, `location`, `history`, `Worker`, `SharedWorker`.

### NOT shadowed (intentionally — used by built-in plugins)

`setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `Promise`, `Math`, `JSON`, `Date`, `Number`, `String`, `Array`, `Object`, `Map`, `Set`, `Error`, `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `structuredClone`, `btoa`, `atob`. The Pomodoro plugin uses `setTimeout` to defer transitions; do not remove these without checking the built-ins first.

### `new Function` caveat

Plugins are evaluated with `new Function("flint", source)`. The shadowing happens by binding the listed globals to `undefined` inside the function scope, but `Function` itself is reachable from inside any function expression (`(function(){return Function})()`), and a determined plugin can therefore reach the real ambient globals. We treat this as a known limitation: the sandbox is a defense-in-depth boundary against accidental DOM access, not against malicious code execution. The right model is "trust the plugin author the same way you trust a script you `npm install`". Future hardening will move plugins into a Web Worker for a real cross-realm boundary.

### `safeCallPlugin` / `safeCallHook`

Every plugin-authored function — event handlers, commands, hook handlers, render functions, prompt callbacks — runs inside a 5-second `Promise.race`. If the handler exceeds the timeout, the host abandons the call, logs an error, and continues. This is the line of defense against a buggy plugin that hangs the event loop.

### Notification cap

At most 3 notifications are visible at once. The fourth is queued. Per-plugin dedup window suppresses repeats of the same `(plugin_id, body)` pair within 10 seconds. Per-notification duration is honored within a 1–15 second cap (`min` and `max` enforced in `plugin-host.tsx`); requests outside the range are clamped silently.

## Deletion flows

Flint's sandbox philosophy: users should be able to create *and* destroy freely. Every user-authored entity (sessions, presets) can be deleted from the UI, and every destructive action is gated by an inline `[YES] [NO]` confirmation — no modal dialogs.

**Sessions** (`delete_session(id: String)` in `commands.rs`):
- Scans `~/.flint/sessions/*.json`, locates the file whose JSON `.id` matches the argument, `fs::remove_file`s it, then drops the matching row via `cache::delete_by_id`. The session log listens for its own refresh event and re-renders.
- **Path-traversal guard**: `validate_session_id` rejects empty strings, `/`, `\`, `..`, and any non-[A-Za-z0-9_-] character before we use the id to find a file. Tests live in `commands::tests`. After locating the candidate file we also canonicalise both it and `sessions_dir` and verify the match stays under `sessions_dir` as a belt-and-braces check against symlink shenanigans.
- UI surfaces: hover × icon on each session log row (inline confirm replaces the row); `[DELETE]` control in the session detail header; `core:delete-selected-session` command which acts on whatever session is open in the detail view.

**Presets** (`delete_preset(id: String)`):
- UI surfaces: hover `×` / `✎` on each quick-start bar tile (inline confirm replaces the tile); `[DELETE]` control in the preset form when editing; `core:edit-preset:{id}` / `core:delete-preset:{id}` commands auto-registered per preset.
- Deleting a preset automatically deregisters its three per-preset commands on the next effect tick because the `useEffect` in `App.tsx` cleans up old registrations when the `presets` array changes.

Per-session tag edits happen through `TagAutocomplete`, which already supports removing tags via the `×` pill or Backspace. Bulk tag deletion is intentionally not implemented — the tag index is derived from session files, so the right way to "remove" a tag is to edit the sessions that have it.

## Context-aware hover actions

Because the global right-click context menu is disabled, Flint uses an Obsidian-inspired hover-reveal pattern for item-level actions:
- Each row / tile is a `group` with a primary clickable surface and trailing action icons (`×`, `✎`) that are `opacity-0` by default and `opacity-100 group-hover:`.
- Actions are muted (`var(--text-muted)`) until hover so they never compete with the primary content. On hover they light up in accent or `--status-error` depending on intent.
- Clicking a destructive action flips the row into an inline confirmation — `[YES] [NO]` text buttons replace the row content. Escape / clicking elsewhere cancels.
- Action buttons use `tabIndex={-1}` so keyboard navigation still lands on the primary row button first, and arrow-key traversal stays predictable.

Apply this pattern when adding any new per-item action. Never add a right-click menu — the terminal aesthetic assumes keyboard + hover-first interaction.

## Keyboard map

Fixed, non-configurable:
- `Space` — start / pause / resume
- `Enter` — mark question (while running or paused)
- `Escape` — stop-confirm, or close modal

App shortcuts (also available as commands):
- `Ctrl+P` — toggle command palette
- `Ctrl+B` — toggle sidebar
- `Ctrl+Shift+O` — toggle overlay
- `Ctrl+,` — open settings
- `Ctrl+T` — open tag input (legacy mid-session text input)
- `Ctrl+Q` — quit
- `Ctrl+1..9` — switch timer mode (when idle)
- `1..4` — load pinned preset (when idle, no modifier)

## Design system

- **Terminal / brutalist-minimal.** JetBrains Mono everywhere, bundled locally (no Google Fonts after [H-3]). Near-black void (`#050505` / `#0a0a0a`). Phosphor green accent (`#16a34a`). 2px max border-radius. Zero shadows, gradients, glows, or decorative animations.
- **Tokens live in `src/index.css`.** Every color is a CSS variable (`--bg-void`, `--text-bright`, `--accent`, `--status-paused`, etc.). Prefer `var(--...)` over raw hex in new code.
- **Unicode icons only** — `●`, `‖`, `■`, `▶`, `×`, `«`, `»`, `⟳`, `✦`, `★`. No SVG icon libraries.
- **Animation budget:** 150–200ms ease-out, state transitions only. No particles, no glows, no gradients. The palette and preset form are *instant* — terminal apps don't animate modals.
- **Components:** use `FlintSelect` (not native `<select>`) for dropdowns, `FlintErrorBoundary` around anything that renders plugin-authored content or triggered-by-plugin UI (this includes every render-spec slot and the prompt dialog).
- **Modals are viewport-centered, not flex-centered.** Command palette, preset form, and prompt dialog use explicit `position: fixed; top: 14–20vh; left: 50%; transform: translateX(-50%)` so centering is relative to the viewport regardless of the sidebar / main-area flexbox. The backdrop is a separate `position: fixed; inset: 0` div with z-index 60+, and the dialog itself sits at z-index 61. Don't fall back to `flex items-start justify-center` — it subtly interacts with sidebar width under some layout modes.
- **Overlay is off-limits** for sandbox features. The pill is fixed at 336×64 with its existing controls. Sandbox features live in the main window.

## Invariants that must NOT be broken

- **Existing `flint.on()` calls in built-in plugins are sacred.** The hook migration is purely additive — `on()` maps to after-hooks, zero changes to Stopwatch / Countdown / Session Log / Stats event handling. Pomodoro now also registers a `flint.hook("session:start", ...)` and authors intervals via `setFirstInterval` / `setNextInterval`, but its existing `on()` calls are unchanged. Only *add* new `registerCommand` / `hook` calls to built-ins; never rewrite their `on()` handlers.
- **Plugin-driven intervals are the primary path.** When refactoring engine code, do not bypass `pending_first_interval` / `pending_next_interval` consumption order. The engine consumes the pending slot first, then falls back to its hardcoded branch. If you reorder this, plugin-authored modes silently break.
- **Render spec must NEVER use `dangerouslySetInnerHTML`.** All plugin-authored content reaches React as structured children only. Adding HTML strings into a render path is a sandbox escape — block it at code review.
- **Recovery writes are off the engine mutex.** Always snapshot under the lock and ship to `RecoveryWriter`. Never `write_recovery` inline.
- **Atomic writes only.** Use `storage::write_atomic` for any new file destination. The plugin storage atomic write fix from [H-1] is the model — never raw `fs::write` for durable state.
- **Plugin callbacks go through `safeCallPlugin` / `safeCallHook`.** Every plugin-authored function gets the 5-second timeout treatment.
- **Notifications honor the duration cap.** Use the `clampDuration(min=1000, max=15000)` helper in `plugin-host.tsx`. Don't add new notification APIs that bypass the cap.
- **Interval rate limiter (2s).** Don't remove the `INTERVAL_TRANSITION_COOLDOWN` check in `next_interval` — it is the last line of defense against plugin-driven rapid-fire transitions.
- **Context menu stays disabled.** Don't add right-click menus.
- **Config overrides are session-scoped.** Never persist preset overrides to `config.toml`. The `SessionOverridesState` flow exists specifically to keep experimentation safe.
- **Before-hook coverage stays complete.** When adding a new timer action (or moving an existing one), wrap it in the JS-side wrapper that calls `runBeforeHooks(...)` first. The keyboard handler, the palette, the overlay, and the tray menu all converge on these wrappers — don't add a fourth path that goes directly to `invoke`.

## Plugin developer guide

This section is the practical "how to ship a plugin" walkthrough. It assumes you've read the API reference above.

### 1. Build a custom timer mode

`~/.flint/plugins/exam-mode/manifest.json`:

```json
{
  "id": "exam-mode",
  "name": "Exam Mode",
  "version": "1.0.0",
  "description": "Multi-section exam timer with strict pause and abandon penalties.",
  "author": "you",
  "type": "community",
  "entry": "index.js",
  "ui_slots": ["sidebar-tab", "settings"],
  "events": ["session:start", "session:pause", "interval:end"],
  "timer_mode": true,
  "config_section": "exam_mode",
  "config_schema": {
    "section_minutes": {
      "type": "number", "default": 60, "label": "Minutes per section",
      "min": 1, "max": 240
    },
    "sections": {
      "type": "string", "default": "Physics,Chemistry,Math",
      "label": "Section names (comma-separated)"
    }
  }
}
```

`~/.flint/plugins/exam-mode/index.js`:

```js
let sectionsRemaining = [];

flint.hook("session:start", async (ctx) => {
  if (ctx.mode !== "exam-mode") return;
  const cfg = await flint.getConfig();
  const sections = (cfg.sections || "").split(",").map((s) => s.trim());
  sectionsRemaining = sections.slice(1); // first one drives the first interval
  const targetSec = (cfg.section_minutes || 60) * 60;
  await flint.setFirstInterval({
    type: "section",
    target_sec: targetSec,
    metadata: { name: sections[0] },
  });
});

flint.hook("session:pause", () => {
  flint.showNotification("Pausing is disabled during exam mode.", { duration: 4000 });
  return { cancel: true };
});

flint.on("interval:end", async () => {
  if (sectionsRemaining.length === 0) {
    await flint.stopSession();
    return;
  }
  const next = sectionsRemaining.shift();
  const cfg = await flint.getConfig();
  const targetSec = (cfg.section_minutes || 60) * 60;
  await flint.setNextInterval({
    type: "section",
    target_sec: targetSec,
    metadata: { name: next },
  });
  await flint.nextInterval();
});

flint.registerCommand({
  id: "exam-mode:abandon",
  name: "Exam Mode: abandon (penalty)",
  category: "exam",
  callback: async () => {
    const result = await flint.prompt({
      title: "Abandon exam?",
      body: "This counts as a 0% score in your stats.",
      accept: "Abandon",
      decline: "Continue",
    });
    if (result === "accepted") {
      await flint.storage.set("last_abandon", { at: new Date().toISOString() });
      await flint.stopSession();
    }
  },
});
```

The flow:
1. Manifest declares `timer_mode: true` so the mode appears in the tray and Ctrl+1..9.
2. `before:session:start` reads config, primes the first interval, and stashes the remaining sections in plugin scope.
3. `before:session:pause` cancels every pause attempt.
4. `interval:end` advances through the section list, pushing each next interval through `setNextInterval` before calling `nextInterval`.
5. Abandonment uses the prompt primitive and stores history through plugin storage.

### 2. Render through the spec system

For a sidebar tab body, register a render function:

```js
flint.registerView("sidebar-tab", () => {
  return {
    type: "container",
    direction: "column",
    gap: 12,
    children: [
      { type: "text", value: "EXAM MODE", variant: "title" },
      { type: "stat-row", label: "Sections left", value: sectionsRemaining.length, accent: true },
      {
        type: "button",
        label: "Abandon",
        command: "exam-mode:abandon",
      },
    ],
  };
});
```

The host calls the render function whenever the slot needs to repaint (initially, on plugin reload, when the tab is shown). To force a repaint after your own state changes, emit a topic the host listens to; the conventional pattern is `flint.emit("view:dirty", { slot: "sidebar-tab" })`.

### 3. Use hooks to control behavior

Hooks are the policy layer. Use them when you need to *change* what would otherwise happen, not just observe it:

```js
// Veto: prevent stop unless a confirmation prompt is accepted
flint.hook("session:stop", async (ctx) => {
  const result = await flint.prompt({
    title: "Stop the session?",
    body: "You'll lose any in-progress section.",
    accept: "Stop",
    decline: "Keep going",
  });
  if (result !== "accepted") return { cancel: true };
});

// Mutate: rewrite tags before a session starts
flint.hook("session:start", (ctx) => {
  if (!ctx.tags.includes("focus")) ctx.tags = [...ctx.tags, "focus"];
});

// Cancel: block notifications from a noisy plugin
flint.hook("notification:show", (ctx) => {
  if (ctx.plugin_id === "noisy-plugin") return { cancel: true };
});
```

### 4. Store data

```js
await flint.storage.set("history", { last_30: [...] });
const history = await flint.storage.get("history");
await flint.storage.delete("history");
```

Per key one JSON file under `~/.flint/plugins/{id}/data/{key}.json`. Atomic writes after [H-1]. 5 MB cap per key. Key charset is `[A-Za-z0-9_.-]`. The directory is created on first write.

### 5. Use prompts for user decisions

```js
const choice = await flint.prompt({
  title: "Take a break?",
  body: "You've been focused for 90 minutes.",
  accept: "Yes, 10 minutes",
  decline: "Keep going",
  timeout: 30000, // dismiss automatically after 30 s
});
if (choice === "accepted") {
  await flint.setNextInterval({ type: "break", target_sec: 600 });
  await flint.nextInterval();
}
```

Prompts queue, so a plugin that fires multiple in quick succession sees them resolve one at a time.

## Knowledge graph

A Graphify knowledge graph exists at `graphify-out/`. Auto-updates on git commit. Before answering architecture questions, read `graphify-out/GRAPH_REPORT.md` for god nodes and community structure. If `graphify-out/wiki/index.md` exists, navigate it instead of reading raw files. Manual refresh: `python3 -c "from graphify.watch import _rebuild_code; from pathlib import Path; _rebuild_code(Path('.'))"` after modifying code, or `/graphify . --update` for a full rebuild.

## Commands

- Dev: `cargo tauri dev`
- Build: `cargo tauri build`
- Frontend only: `npx vite` (in repo root)
- Typecheck: `npx tsc --noEmit`
- Frontend production build: `npx vite build`
- Rust test: `cargo test`
- Rust check: `cargo check`
- Format Rust: `cargo fmt`
