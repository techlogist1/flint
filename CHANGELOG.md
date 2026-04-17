# Changelog

All notable changes to Flint will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] — 2026-04-18 — Release hardening

Two bugs that only manifested in installed binaries, invisible during `cargo tauri dev`.

### Fixes

- **fix(csp): plugins now activate correctly in release builds.** The Tauri CSP did not grant `'unsafe-eval'` to `script-src`, so every plugin's `new Function` activation in the sandbox threw `EvalError` the moment the app loaded over `tauri://localhost`. Pomodoro, Stopwatch, Countdown, Session Log and Stats all failed silently — Pomodoro's symptom was the timer freezing at `00:00` with no break transition. `cargo tauri dev` loads over HTTP with no CSP, so the regression had been latent since `f10110b` (pre-v0.1.1). CSP now allows `'unsafe-eval'`, aligning with the sandbox's existing `npm install`-level trust model.
- **ci(release): stable asset filenames across versions.** `.github/workflows/release.yml` strips the `_<version>_` segment from each bundled artifact's basename before uploading, so `/releases/latest/download/Flint_x64_en-US.msi` (and siblings) resolve for every future release. README download links switched to the versionless form.

### Docs

- CLAUDE.md plugin-sandbox section now documents the CSP `'unsafe-eval'` requirement and the release-vs-dev CSP enforcement difference.
- New invariant: release asset filenames do not contain version numbers.

## [0.1.2] — 2026-04-17 — Sandbox Stability

The last Lock-In-specific assumption is carved out of core. Question semantics no longer live in the Rust engine, the session schema, the SQLite cache, the frontend types, or the UI. What replaces them is the generic hook foundation every v0.2.0 behavior plugin will inherit.

### Breaking changes

- **`question:mark` → `signal:mark`.** The hook name has been renamed to a neutral signal namespace. Plugins that called `flint.hook("question:mark", …)` or `flint.on("question:mark", …)` must subscribe to `"signal:mark"` instead. The payload shape is unchanged in spirit (source-tagged, session-scoped) but switches to `{ session_id, elapsed_sec, source }`.
- **`flint.markQuestion()` removed.** No direct replacement — plugins emit their own signal via `flint.signal("mark", payload?)` or `flint.emit("signal:mark", payload?)`, which runs the full before → after pipeline without any core side effect.
- **`questions_done` removed from engine state, recovery file, session JSON, SQLite cache, and all frontend types.** The Rust `EngineState.questions_done`, `TimerStateRecovery.questions_done`, session-file `questions_done`, `sessions.questions_done` column, and every TS mirror field are gone.
- **`mark_question` Tauri command removed.** Callers get an "unknown command" error — this is intentional; the surface is a core-routing primitive, not a user-callable command.
- **`question:marked` Tauri event removed.** No more core-fired event for marks. The `signal:mark` JS-side emit is the only route.
- **UI deletions.** The `Q` indicator in the status bar, `qN` badge in the timer display, `QUESTIONS` stat rows in the stats dashboard and session detail, and `q{n}` row hint in the session log are gone from core. Pure sandbox default — the future `@flint/plugin-lockin` plugin re-adds them via `flint.registerView`.

### Migrations (automatic)

- **Session JSON.** Pre-v0.1.2 files carry a top-level `questions_done`. On any read path (cache rebuild, live upsert, export), a shim moves a non-zero value into `custom_metadata["lockin.questions_done"]` before any downstream consumer sees it. Zero counts are dropped (no signal). Files themselves are not rewritten; the shim runs on each read, which is idempotent.
- **SQLite cache.** The old cache carries a `questions_done` column. On first boot after upgrade, a schema-version check detects the stale column, drops the `sessions` table, recreates it with the current schema, and auto-rebuilds from session JSON. No action required; the message `[flint] rebuilding cache (schema v2 upgrade)` appears once in console.

### Additions

- **`custom_metadata: Record<string, JSONValue>` on session JSON.** Plugins mutate `ctx.custom_metadata` inside a `before:session:stop` hook; the finalizer merges the map into the session file. Key convention: `"<plugin-id>.<field>"`.
- **`flint.signal(name, payload?)` API.** Sugar over `flint.emit` with the standard `signal:*` namespace and defaulted `source: "plugin"`. Runs before → after pipeline; cancellation semantics identical to every other Flint hook.
- **Keybinding invariant.** Core keyboard shortcuts (`Space`, `Escape`, `Enter`, `Ctrl+P`) are reserved routes; their physical keys and emitted signals are fixed. Plugins subscribe to the signals via `flint.on(…)` rather than binding keys directly. Non-reserved keys remain available for `registerCommand({ hotkey })` use.
- **New invariant: "Enter emits `signal:mark`. Core does not handle the signal. Plugins do."** Core holds no counter, writes no state, renders no UI for marks. Historical `questions_done` surfaces in `custom_metadata["lockin.questions_done"]` on read.

### Why

This carve-out is the foundation for the v0.2.0 plugin-SDK work. Every future behavior plugin (Lock-In, Exam Mode, Flowtime) binds to the same `signal:*` + `custom_metadata` primitives these changes establish. Without it, the "Obsidian of timers" pitch had a hardcoded question counter baked into the engine — a Lock-In-shaped bleed-through that would have forced every future plugin to either live with the name or negotiate a core-schema change. Direction 1 of the plan's bidirectional validation — "no plugins installed → Enter is inert" — now holds true in code.

### Built-in plugins

- **Stopwatch `mark-lap`** no longer calls the removed `markQuestion`. Lap counts live entirely in plugin storage (`flint.storage.get/set`), reset on `session:start` / `session:complete` / `session:cancel`. The lap primitive becomes internal to the Stopwatch plugin — no new signal name carried forward.
- **Pomodoro** unchanged. The v0.1.0 audit already confirmed zero question-assumption residue; this release doesn't touch the plugin.

## [0.1.1] — 2026-04-17 — Branding fix

- Replaced placeholder Tauri icons with Flint branding across Windows (`.ico`), macOS (`.icns`), and installer assets.

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
