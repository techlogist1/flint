# Changelog

All notable changes to Flint will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] — 2026-06-05 — Hardening + macOS Install

A focused hardening pass: 24 safe, one-concern-per-commit fixes across storage durability, the Rust engine and cache, the plugin host, the frontend, and the built-in plugins — plus a real macOS install experience. No plugin-API behavior changes and no v0.2.0 SDK surface. Every gate stayed green: `tsc`, `vite build`, `cargo clippy -D warnings`, and 43/43 tests.

### Reliability & storage

- **Durable atomic writes.** `write_atomic` now fsyncs the temp file and its parent directory around the rename and uses a unique per-write temp name, so a crash or a concurrent write can't leave durable state truncated; the recovery flush logs on timeout instead of failing silently.
- **Safe config-write ordering.** Plugin enable/disable and config changes persist to disk *before* the in-memory config is mutated, and `load_or_create` no longer clobbers a broken `config.toml` when the `.broken` rename fails.
- **Cache robustness.** Finalize/delete cache failures are now logged rather than swallowed (in every mode); a redundant streak pass and an unusable index were removed, `heatmap` guards non-positive ranges, and cache rebuild reuses the single INSERT path.
- **Engine recovery.** Recovery arithmetic uses saturating math so clock skew can't underflow it; a misleading "wall-clock-driven" tick-loop comment was corrected.

### Plugin host & frontend

- **Plugin callbacks honor the 5-second budget.** Plugin-registered command callbacks now run under the same 5 s timeout as every other plugin-authored function (core commands stay unbounded); notification dedup is recorded only after the visible-stack cap check.
- **Frontend NaN / race / leak guards.** `formatTime`, the heatmap, and the overlay progress bar reject non-finite values (no more `scaleX(NaN)`); the stats dashboard cancels stale and post-unmount loads; the debounced sidebar-save timer is cleared on unmount; `Ctrl`+digit always `preventDefault`s.
- **Accessibility & forms.** `FlintSelect` exposes `aria-activedescendant` and scrolls the active option into view; the plugin config form tracks pending saves per key; `signal()` guards non-object payloads like `emit()`.

### Built-in plugins

- **Countdown** finalizes the session before firing its cosmetic completion notification and wraps `getTimerState`; **Pomodoro**'s `safeInvoke` now logs via its label; each manifest's `events` array matches the plugin's actual subscriptions.

### macOS install

- **Ad-hoc signing by default.** The bundle is signed with `signingIdentity: "-"`, which clears the "Flint.app is damaged" Gatekeeper prompt on a downloaded build — you get the standard "unidentified developer → Open Anyway" flow instead, until full notarization is enabled.
- **Notarization pipeline, inert.** A full Developer-ID signing + notarization + stapling pipeline is wired into `release.yml` but stays inert until the Apple repo secrets exist, so today's build is exactly the ad-hoc, un-notarized one with no further code changes needed to flip it on.
- **Install docs.** New `docs/INSTALL_MACOS.md` with quarantine-clear steps and a maintainer setup guide; the README macOS instructions were corrected to match.

### Docs

- **Doc-honesty corrections.** Removed the phantom `session:stop` / `interval:next` events from the README and CLAUDE.md, fixed the `config.toml` example and the minimal-plugin render-widget list, and corrected the prompt timeout / no-sticky-mode claims so the docs describe what the code actually does.

## [0.1.3] — 2026-04-18 — Bugfix + Stability

v0.1.3 is the first release where plugin activation works end-to-end in installed binaries. The headline bug — CSP blocking every plugin's sandbox — had been latent since before v0.1.1 but only surfaced in release builds (dev mode loads over HTTP with no CSP). If you tried Flint before and noticed plugins were broken, this release fixes it.

### Fixes

- **fix(csp): plugins activate correctly in release builds.** The Tauri CSP did not grant `'unsafe-eval'` to `script-src`, so every plugin's `new Function` sandbox activation threw `EvalError` as soon as the app loaded over `tauri://localhost`. Pomodoro, Stopwatch, Countdown, Session Log and Stats all failed silently — Pomodoro's symptom was the timer freezing at `00:00` with no break transition. `cargo tauri dev` loads over HTTP with no CSP, so the regression had been latent since `f10110b` (pre-v0.1.1). CSP now allows `'unsafe-eval'`, aligning with the sandbox's existing `npm install`-level trust model.
- **fix(plugin-host): StrictMode double-activation guard.** A `reloadGenRef` counter short-circuits stale reloads so React 18 StrictMode's dev-mode double-mount no longer registers plugin handlers twice. Production builds (no StrictMode) were unaffected; this cleans up console warnings and subtle double-fire in dev.
- **fix(ui): removed stale `[enter] mark` keyboard hint.** The timer screen no longer advertises Enter as a "mark" action — Enter has been inert in core since v0.1.2 and the hint was lying about what the key does. Plugins that hook `signal:mark` are unchanged; only the core UI string is gone.
- **fix(storage): atomic write for `config.toml`.** `config::save` now routes through `storage::write_atomic` like every other durable store, so a crash mid-write can never leave a truncated `config.toml` that the next launch treats as "broken" and reverts. Honors the existing "Atomic writes only" invariant.
- **ci(release): stable asset filenames across versions.** `.github/workflows/release.yml` strips the `_<version>_` segment from each bundled artifact's basename before uploading, so `/releases/latest/download/Flint_x64_en-US.msi` (and siblings) resolve for every future release. README download links switched to the versionless form.

### Docs

- **Corrected premature API claims in CLAUDE.md.** v0.1.2 documented a `before:session:stop` hook and a plugin-writable `custom_metadata` field; neither is implemented. The actual pre-finalize event is `before:session:cancel` (dispatched from `wrappedStop`); `custom_metadata` is a reserved schema field, read-path migration only, with `finalize_session` writing `{}`. A real `flint.session.setMetadata(key, value)` API plus a `before:session:finalize` pipeline are scheduled for v0.2.0. Until then, plugins persist per-plugin data through `flint.storage`.
- **Corrected stats return shapes** in the Plugin API section. Previous doc claimed `stats.today → {sessions, focus_sec, questions}` and `stats.lifetime → {sessions, focus_sec, questions, longest_streak_days}`; real shapes (per `src-tauri/src/cache.rs`) are `{focus_sec, session_count}` and `{longest_session_sec, best_day_date, best_day_focus_sec, all_time_focus_sec}` respectively. `stats.range` and `stats.heatmap` shapes were also corrected.
- **Corrected render-spec widget list.** Added the `stat`, `list`, `progress`, `divider`, `spacer` widgets that plugin-view-renderer.tsx already supports but docs omitted. Fixed `button.commandId` field name (was `command`) and `text.style` values (`heading|label|muted|accent|mono|body`, not `title|body|muted|code`).
- **Annotated slot consumers.** `sidebar-tab` (RenderSpec) and `status-bar` (text-only) are the only two slots rendered today; `settings` and `post-session` are reserved names with no host consumer yet.
- CLAUDE.md plugin-sandbox section documents the CSP `'unsafe-eval'` requirement and the release-vs-dev CSP enforcement difference.
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

[0.1.3]: https://github.com/techlogist1/flint/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/techlogist1/flint/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/techlogist1/flint/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/techlogist1/flint/releases/tag/v0.1.0
