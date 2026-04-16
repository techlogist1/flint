# Changelog

All notable changes to Flint will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-16 — The Real Sandbox

First public release. Flint ships as a keyboard-driven, plugin-extensible desktop timer with a real primitive layer — every built-in mode is itself a plugin using the same API community authors use.

### Core

- Tauri 2.0 desktop app with Rust timer engine and React + TypeScript frontend.
- Tick loop runs in Rust with `MissedTickBehavior::Skip`; the frontend listens to Tauri events and never runs its own timer.
- Plugin-driven interval engine: the engine consumes `pending_first_interval` / `pending_next_interval` slots populated by plugins before falling back to hardcoded pomodoro / countdown behavior.
- Session files are the source of truth under `~/.flint/sessions/`, one JSON per session. Atomic writes via `storage::write_atomic`.
- SQLite read cache (`cache.db`) for fast stats queries — rebuildable, safe to delete, reconstructed from session files via `core:rebuild-cache`.
- Recovery file written off the engine mutex through a background `RecoveryWriter` tokio task. Snapshots are cheap clones taken under the lock and shipped to the writer.
- Interval transitions rate-limited at 2 seconds (`INTERVAL_TRANSITION_COOLDOWN`).
- System tray with start / switch-mode / stop / quit entries; tray menu rebuilds on plugin enable/disable.
- Floating overlay pill (fixed 336×64) with corner-pinned positioning, expand/collapse, and drag-to-move.
- Global config at `~/.flint/config.toml` with per-plugin config schemas rendered automatically in Settings → Plugins.
- Built-in timer modes: Pomodoro, Stopwatch, Countdown — all implemented as plugins.
- Built-in sidebar plugins: Session Log, Stats Dashboard.

### Plugin System

- **Hooks** — Two-phase pipeline: `flint.hook(event, handler)` registers before-hooks that can mutate context or cancel via `{ cancel: true }`; `flint.on(event, cb)` registers observe-only after-hooks. Cancellation short-circuits the pipeline and suppresses after-hooks.
- **Full before-hook coverage** — `session:start`, `session:pause`, `session:resume`, `session:stop`, `session:cancel`, `question:mark`, `interval:next`, `preset:load`, `command:execute`, `notification:show`, `tag:add`, `tag:remove`. Keyboard handlers, palette commands, overlay wrappers, and tray menu all converge on the same wrappers — no "back door" that bypasses the pipeline.
- **Commands** — `flint.registerCommand({ id, name, callback, icon?, hotkey?, category? })`. Every action in Flint is a named, searchable, executable command. `Ctrl+P` opens a fuzzy-search palette; empty-query ordering is MRU.
- **Render spec system** — `flint.registerView(slot, renderFn)` returns a JSON render spec the host interprets into React. Widgets: `container`, `text`, `stat-row`, `bar-chart`, `line-chart`, `heatmap`, `table`, `button`. Plugin-authored content reaches React as structured children only — no `dangerouslySetInnerHTML` path.
- **Interval authoring** — `flint.setFirstInterval` (from `before:session:start`) and `flint.setNextInterval` (from `after:interval:end`) push interval directives into the engine. Custom timer modes ship by declaring `"timer_mode": true` in their manifest.
- **Prompt primitive** — `flint.prompt({ title, body, accept, decline, timeout? })` shows a centered terminal-aesthetic dialog and resolves with `"accepted" | "declined" | "dismissed"`. Enter accepts, Escape dismisses, Tab toggles; prompts queue FIFO.
- **Preset system** — First-class `~/.flint/presets/*.json` files with plugin + config_overrides + tags + pinned + sort_order. Config overrides are session-scoped and never persist back to `config.toml`. Pinned presets show in the quick-start bar with `1..4` shortcuts.
- **Tag system** — Derived tag index scanned asynchronously from session files at startup, updated on `start_session` / `finalize_session`. `TagAutocomplete` with hover-reveal removal. `tag:add` / `tag:remove` hooks fire for every change.
- **Stats API** — `flint.stats.today() / range(scope) / heatmap(days) / lifetime()` — thin wrappers around pre-aggregated SQLite cache queries.
- **Preset API** — `flint.presets.list / save / delete / load` lets plugins ship preset packs.
- **Plugin storage** — `flint.storage.{get,set,delete}` writes per-plugin atomic JSON files under `~/.flint/plugins/{id}/data/`. 5 MB cap per key, key charset restricted to `[A-Za-z0-9_.-]`.
- **Notifications** — `flint.showNotification(msg, { duration?, title? })` with duration clamped to 1–15 seconds. At most 3 visible at once; per-plugin dedup window prevents spam.
- **Sandbox** — Plugins run in `new Function("flint", source)` with `window`, `document`, `fetch`, `localStorage`, `__TAURI__`, and related globals shadowed to `undefined`. Every plugin-authored callback runs inside `safeCallPlugin` / `safeCallHook` with a 5-second timeout — a buggy plugin cannot wedge the host.
- **Render spec error boundaries** — Every plugin-authored render slot is wrapped in `FlintErrorBoundary`; a malformed spec degrades to a muted placeholder instead of crashing the sidebar.
- **Per-plugin handler tracking** — On plugin reload (enable/disable/reload), every handler owned by that plugin is cleared automatically. Core-owned hooks are preserved.

### Design

- Terminal / brutalist-minimal aesthetic. Near-black void backgrounds (`#050505` / `#0a0a0a`), phosphor green accent (`#16a34a`), 2px max border-radius, zero shadows or gradients.
- **JetBrains Mono** bundled locally — no Google Fonts network dependency.
- Every color is a CSS variable (`--bg-void`, `--text-bright`, `--accent`, `--status-paused`, etc.) in `src/index.css`.
- Unicode icons only (`●`, `‖`, `■`, `▶`, `×`, `«`, `»`, `⟳`, `✦`, `★`) — no SVG icon libraries.
- Animation budget: 150–200ms ease-out on state transitions only. Modals are instant.
- `FlintSelect` for dropdowns, `FlintErrorBoundary` around plugin-rendered content.
- Modals are viewport-centered with explicit `position: fixed` placement — command palette, preset form, and prompt dialog share the pattern.
- Context menu (right-click) is disabled app-wide. Per-item actions use an Obsidian-style hover-reveal pattern with inline `[YES] [NO]` confirmation for destructive operations — no modal dialogs.

### Keyboard

Fixed core keys:

- `Space` — start / pause / resume
- `Enter` — mark a question (while running or paused)
- `Escape` — stop-confirm, or close modal

App shortcuts:

- `Ctrl+P` — toggle command palette
- `Ctrl+B` — toggle sidebar
- `Ctrl+Shift+O` — toggle floating overlay
- `Ctrl+,` — open settings
- `Ctrl+T` — open tag input
- `Ctrl+Q` — quit
- `Ctrl+1..9` — switch timer mode (when idle)
- `1..4` — load pinned preset (when idle, no modifier)

[0.1.0]: https://github.com/techlogist1/flint/releases/tag/v0.1.0
