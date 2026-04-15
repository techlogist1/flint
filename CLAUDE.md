# Flint

Open-source, local-first, keyboard-driven, plugin-extensible timer for focused work. Tauri 2.0 + React + TypeScript + Tailwind + Rust + SQLite.

**Philosophy:** the Obsidian of timers. Flint provides primitives — hooks, commands, presets, tags, plugins — and users compose their own workflow on top. After the Phase 6.5 sandbox layer, adding any new capability is writing a `manifest.json` + `index.js`, never a core code change.

## Stack

- Tauri 2.0 (Rust backend + React frontend)
- React 18 + TypeScript (strict) + Tailwind CSS
- SQLite read cache + JSON session files (source of truth)
- JS/TS plugins with `manifest.json`, loaded at startup from built-in resources and `~/.flint/plugins/`

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
- **Session files are source of truth.** SQLite cache is rebuildable — treat it as disposable.
- **Recovery file is written off the engine mutex** via the background `RecoveryWriter` tokio task (`storage.rs`). Snapshots are cheap clones taken under the lock and shipped to the writer; the disk write happens outside the lock.
- **All file writes are atomic** (`storage::write_atomic` → tmp + rename). Applies to sessions, recovery, presets, state.json, exports.
- **Plugins are sandboxed.** They receive a `flint` API object and have `window`, `document`, `fetch`, etc. shadowed to `undefined` (`plugin-sandbox.ts`). They cannot reach the filesystem or core state except through the API.
- **Plugin handlers run inside `safeCallPlugin` / `safeCallHook`** with a 5-second timeout. A buggy plugin cannot wedge the host.
- **Notifications are capped** at 3 visible + 4-second hard auto-dismiss + per-plugin dedup window. Non-negotiable; plugins cannot override.
- **Interval transitions are rate-limited** at 2 seconds between calls (`INTERVAL_TRANSITION_COOLDOWN`) so no plugin can stack rapid-fire transitions.
- **Tick loop uses `MissedTickBehavior::Skip`** so a stalled tick body doesn't cause a burst of catch-up ticks.

## Hook system (`flint.hook` / `flint.on` / `flint.emit`)

Flint has a two-phase hook pipeline:

- `flint.hook(event, handler)` — register a **before-hook** (interceptor). Handlers run sequentially in registration order. Each receives a context object they can mutate. Any handler that returns `{ cancel: true }` aborts the action entirely. Returns an unsubscribe function.
- `flint.on(event, handler)` — register an **after-hook** (observer). Maps to the existing plugin API unchanged. Observers cannot cancel.
- `flint.emit(event, context)` — runs the full pipeline: before-hooks → (optional action by core code) → after-hooks, plus a legacy `window.CustomEvent("flint:plugin:${event}")` broadcast for host-React listeners.

Handlers are tracked per plugin id. On plugin reload (enable/disable/reload), every handler owned by that plugin is cleared automatically via the Component-style teardown in `plugin-host.tsx`. Core-owned hooks (registered by `registerCoreHook`) are preserved across reloads.

### Event catalog

| Event | `before:` context (mutable) | `after:` payload |
| --- | --- | --- |
| `session:start` | `{ plugin_id, config, tags, preset_id }` | Tauri payload `{ session_id, mode, tags }` |
| `session:pause` / `session:resume` | `{ elapsed_sec }` | same |
| `session:complete` / `session:cancel` | — (fired by the engine) | `{ session_id, duration_sec, questions_done? }` |
| `interval:start` / `interval:end` | — | `{ type, target_sec? }` / `{ type, duration_sec }` |
| `notification:show` | `{ title, body, plugin_id }` | same (after render) |
| `preset:load` | `{ preset, config_overrides }` | same (after start) |
| `tag:add` / `tag:remove` | `{ tag, current_tags }` | same |
| `command:execute` | `{ command_id, source }` | same |
| `app:ready` | — | `{}` (fires after plugins load) |
| `app:quit` | — | `{}` (fires before tear-down) |

**Cancellation semantics:** A before-hook returning `{ cancel: true }` short-circuits the pipeline — no action runs and no after-hook fires. Handlers can also mutate the context object in place to modify downstream behavior (e.g. rewriting `tags` or `config_overrides`).

## Command system (`flint.registerCommand`)

Every action in Flint is a named, searchable, executable command. The command palette (Ctrl+P) is the universal entry point.

```ts
flint.registerCommand({
  id: "plugin_id:action_name",
  name: "Display name",
  callback: () => void | Promise<void>,
  icon?: "▶",           // unicode glyph, optional
  hotkey?: "Ctrl+P",    // informational badge, optional
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
- `core:quit-app`
- `preset:load:{preset_id}` — auto-registered per preset, appears as `Start: {preset_name}`

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
  "name": "BITSAT Grind",
  "plugin_id": "pomodoro",
  "config_overrides": {
    "focus_duration": 45.0,
    "break_duration": 10.0,
    "cycles_before_long": 0,
    "auto_start_breaks": true
  },
  "tags": ["physics", "math"],
  "pinned": true,
  "sort_order": 0,
  "created_at": "2026-04-15T10:00:00Z",
  "last_used_at": null
}
```

### Tauri commands (`src-tauri/src/commands.rs` → `presets.rs`)

- `list_presets() -> Vec<Preset>` — scans `~/.flint/presets/`, sorted pinned-first then `sort_order` then name.
- `save_preset(preset: PresetDraft) -> Preset` — validates, writes atomically via `storage::write_atomic`. If `id` is supplied, updates in place preserving `created_at`/`last_used_at`.
- `delete_preset(id: String) -> ()`
- `load_preset(id: String) -> Preset`
- `touch_preset(id: String) -> ()` — bumps `last_used_at` to now.

### Config override mechanics (`SessionOverridesState`)

Preset overrides are **session-scoped and temporary**. They live in `SessionOverridesState(Mutex<Option<ActiveOverride>>)` and never touch `config.toml`. The flow:

1. User loads preset → frontend `loadPreset()` fires `before:preset-load`.
2. `start_session` is invoked with `overrides: Option<Value>`.
3. Rust stores overrides in `SessionOverridesState` and uses `merged_config()` (base config + overrides serialized through `presets::apply_overrides_to_config`) to build the first interval.
4. Subsequent `next_interval` calls read `SessionOverridesState` via `session_overrides.snapshot()` so long/short break durations honour the preset.
5. `get_plugin_config` merges overrides into its return value, so `flint.getConfig()` from the running plugin reflects the overridden values.
6. `finalize_session` clears `SessionOverridesState` — the next session falls back to saved config.toml values.

This is what makes presets safe: users can experiment with durations knowing they will not clobber their base config.

## Tag system (`get_known_tags`)

Tag index is a plain `Mutex<HashSet<String>>` (`src-tauri/src/tags.rs`) that holds every unique tag seen across saved sessions. The index is **not persisted** — it is derived:

- At startup, `tags::scan_all_sessions` reads every `~/.flint/sessions/*.json` and unions their `tags` arrays.
- `start_session` and `finalize_session` both call `tags::insert_many` so new tags are visible immediately without waiting for a restart.
- `get_known_tags` returns a case-insensitively sorted snapshot.

Frontend `TagAutocomplete` (`src/components/tag-autocomplete.tsx`) calls `get_known_tags` once on mount and filters client-side. Suggestions match `includes()` on a lowercased query, ranked by `startsWith()` bonus. `tag:add` / `tag:remove` hook events fire for every change so plugins can veto or react.

## Quick-start bar

Idle-view strip that renders up to 4 pinned presets (`src/components/quick-start-bar.tsx`). Number keys `1..4` map to these slots while the timer is idle, the view is `timer`, and no overlay (tag input / stop confirm / palette / preset form) is open. Bare keys — no modifier — so the muscle memory is instant. If no presets exist, the bar renders a muted hint pointing at `Ctrl+P → "create preset"`.

## Plugin API (TypeScript)

```ts
interface FlintPluginAPI {
  on(event: string, callback): void;                  // after-hook
  hook(event: string, handler): () => void;           // before-hook
  emit(topic: string, payload?): Promise<{ cancelled }>;
  registerCommand(command): () => void;

  // Engine control
  getTimerState(): Promise<TimerStateView>;
  getCurrentSession(): Promise<TimerStateView | null>;
  nextInterval(): Promise<void>;
  stopSession(): Promise<void>;
  pauseSession(): Promise<void>;
  resumeSession(): Promise<void>;
  markQuestion(): Promise<void>;

  // Data
  getSessions(options?): Promise<unknown[]>;
  getConfig(): Promise<Record<string, unknown>>;
  setConfig(key, value): Promise<void>;

  // UI
  renderSlot(slot: string, text: string): void;       // text only, never HTML
  showNotification(message, options?): void;          // capped at 3, 4s auto-dismiss

  // Per-plugin storage (JSON file in ~/.flint/plugins/{id}/data/{key}.json)
  storage: {
    get(key): Promise<unknown>;
    set(key, value): Promise<void>;
    delete(key): Promise<void>;
  };
}
```

### Writing a new plugin

1. Create `~/.flint/plugins/my-plugin/manifest.json`:
   ```json
   {
     "id": "my-plugin",
     "name": "My Plugin",
     "version": "1.0.0",
     "description": "…",
     "author": "me",
     "entry": "index.js",
     "ui_slots": [],
     "events": ["session:start"],
     "config_schema": {}
   }
   ```
2. Create `~/.flint/plugins/my-plugin/index.js`. The `flint` object is in scope.
3. To add a new timer mode, set `"timer_mode": true` in the manifest. The mode appears automatically in the tray menu, `Ctrl+1..9`, the default-mode dropdown, and the quick-start bar — no core changes required.
4. Enable the plugin in Settings → Plugins. Auto-enabled for built-ins; community plugins need explicit enable.

### UI slots

- `sidebar-tab` — renders in the sidebar tab switcher (core shell currently only renders known built-ins; community sidebar tabs get a placeholder).
- `settings` — the settings panel auto-generates a form from `config_schema`.
- `post-session` — rendered briefly after a session ends.
- `status-bar` — inline entries in the bottom status bar.

Plugins call `flint.renderSlot(slot, text)` — the payload is rendered as React text content (never HTML) so a plugin cannot inject script into the host (S-C2).

### Rust-side manifest parsing (`plugins.rs`)

- `config_schema` is stored as `IndexMap<String, ConfigSchemaField>` so render order matches the manifest.
- Community plugin entry paths are canonicalized and rejected if they escape the plugin dir (S-H1).
- Built-in plugins are embedded via `include_str!` and always active unless explicitly disabled.

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

- **Terminal / brutalist-minimal.** JetBrains Mono everywhere. Near-black void (`#050505` / `#0a0a0a`). Phosphor green accent (`#16a34a`). 2px max border-radius. Zero shadows, gradients, glows, or decorative animations.
- **Tokens live in `src/index.css`.** Every color is a CSS variable (`--bg-void`, `--text-bright`, `--accent`, `--status-paused`, etc.). Prefer `var(--...)` over raw hex in new code.
- **Unicode icons only** — `●`, `‖`, `■`, `▶`, `×`, `«`, `»`, `⟳`, `✦`, `★`. No SVG icon libraries.
- **Animation budget:** 150–200ms ease-out, state transitions only. No particles, no glows, no gradients. The palette and preset form are *instant* — terminal apps don't animate modals.
- **Components:** use `FlintSelect` (not native `<select>`) for dropdowns, `FlintErrorBoundary` around anything that renders plugin-authored content or triggered-by-plugin UI.
- **Overlay is off-limits** for sandbox features. The pill is fixed at 336×64 with its existing controls. Sandbox features live in the main window.

## Invariants that must NOT be broken

- **Existing `flint.on()` calls in built-in plugins are sacred.** The hook migration is purely additive — `on()` maps to after-hooks, zero changes to Pomodoro / Stopwatch / Countdown / Session Log / Stats event handling. Only *add* new `registerCommand` / `hook` calls to built-ins; never rewrite their `on()` handlers.
- **Recovery writes are off the engine mutex.** Always snapshot under the lock and ship to `RecoveryWriter`. Never `write_recovery` inline.
- **Atomic writes only.** Use `storage::write_atomic` for any new file destination (presets already do). Never raw `fs::write` for durable state.
- **Plugin callbacks go through `safeCallPlugin` / `safeCallHook`.** Every plugin-authored function gets the 5-second timeout treatment.
- **Notifications are capped.** Don't add new notification APIs that bypass the 3-visible + 4-second-dismiss limit.
- **Interval rate limiter (2s).** Don't remove the `INTERVAL_TRANSITION_COOLDOWN` check in `next_interval` — it is the last line of defense against plugin-driven rapid-fire transitions.
- **Context menu stays disabled.** Don't add right-click menus.
- **Config overrides are session-scoped.** Never persist preset overrides to `config.toml`. The `SessionOverridesState` flow exists specifically to keep experimentation safe.

## Knowledge graph

A Graphify knowledge graph exists at `graphify-out/`. Auto-updates on git commit. Before answering architecture questions, read `graphify-out/GRAPH_REPORT.md`. Manual refresh: `/graphify . --update`.

## Commands

- Dev: `cargo tauri dev`
- Build: `cargo tauri build`
- Frontend only: `npx vite` (in repo root)
- Typecheck: `npx tsc --noEmit`
- Frontend production build: `npx vite build`
- Rust test: `cargo test`
- Rust check: `cargo check`
- Format Rust: `cargo fmt`

## PRD

Read `PRD.md` for the original product requirements. Some UI sections (colors, overlay) are superseded by the current terminal aesthetic; the architecture sections are still canonical.

## Audit history

Read `AUDIT_V2.md` for the comprehensive bug/perf/security audit. Every fix has an `[ID]` marker in the relevant source comment. The sandbox primitive layer (Phase 6.5) is the follow-on to the last audit row.
