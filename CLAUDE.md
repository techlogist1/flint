# Flint

Open-source, local-first, keyboard-driven, plugin-extensible timer for focused work. Tauri 2.0 + React + TypeScript + Tailwind + Rust + SQLite.

## Philosophy

The Obsidian of timers. Flint provides primitives (hooks, commands, presets, tags, render specs, prompts, storage) and users compose on top. New capability = `manifest.json` + `index.js`, not core code. Plugins never touch the DOM: they describe render via JSON specs, ask via the prompt primitive, and run intervals via engine directives.

## Stack

Tauri 2.0 (Rust + React, ~5–8 MB binary). React 18 + TypeScript (strict, no `any`) + Tailwind CSS. SQLite read cache + JSON session files (source of truth). JS plugins (`manifest.json`) loaded from built-in resources and `~/.flint/plugins/`.

## File locations

```
~/.flint/
├── sessions/       # one JSON per completed session (source of truth)
├── plugins/{id}/   # manifest.json, index.js, data/ (plugin storage)
├── presets/        # one JSON per saved preset
├── config.toml     # global configuration
├── cache.db        # SQLite read cache (rebuildable)
├── recovery.json   # active-session auto-save; deleted on clean end
└── state.json      # app state (first-close toast shown, etc.)
```

## Architecture

- **Timer engine runs in Rust.** Frontend listens to Tauri events — never runs its own timer.
- **Engine is plugin-driven with hardcoded fallbacks.** Consumes `pending_first_interval` / `pending_next_interval` slots from `flint.setFirstInterval` / `flint.setNextInterval`. Empty slot → hardcoded pomodoro / countdown branch.
- **Session files are source of truth.** SQLite cache is rebuildable.
- **Before-hook coverage is complete** — every timer action routes through `runBeforeHooks` in a JS wrapper; keyboard, palette, tray converge on those wrappers, no back door.
- **Tick loop uses `MissedTickBehavior::Skip`** so a stalled tick body doesn't burst catch-up ticks.

See `## Invariants` below for hard NEVER-break rules.

## Hook system (`flint.hook` / `flint.on` / `flint.emit`)

- `hook(event, handler)` — **before-hook**. Sequential, mutable ctx. `{ cancel: true }` aborts. Returns unsubscribe fn.
- `on(event, handler)` — **after-hook**. Cannot cancel.
- `emit(event, ctx)` — before → optional core action → after, plus legacy `window.CustomEvent("flint:plugin:${event}")`.

Handlers tracked per plugin id, auto-cleared on reload. `registerCoreHook` handlers survive reloads.

**Before-hookable** (mutable ctx in parens): `session:start` `(plugin_id, mode, config, tags, preset_id)`, `session:{pause,resume}` `(elapsed_sec)`, `session:stop` `(session_id, elapsed_sec, source)`, `interval:next` `(from_type, to_type?, target_sec?, source)`, `signal:mark` `(session_id, elapsed_sec, source)`, `notification:show` `(title, body, plugin_id, duration)`, `preset:load` `(preset, config_overrides)`, `tag:{add,remove}` `(tag, current_tags)`, `command:execute` `(command_id, source)`.

**After-only** (Rust-fired, no sync JS callback during a tick): `session:{complete,cancel}`, `interval:{start,end}`, `app:{ready,quit}`. Use `interval:next` to intercept transitions.

## Command system (`flint.registerCommand`)

```ts
registerCommand({ id: "plugin_id:action" | "core:action",
  name, callback, icon?, hotkey?, category? }): () => void;  // auto-cleaned on unload
```

Duplicate ids lose to the last registration. Core commands cover session control, plugin switching, UI toggles, settings, preset CRUD, export, rebuild-cache, quit. Built-ins register `pomodoro:{skip-interval,reset-cycle}`, `stopwatch:mark-lap`, `countdown:abort`, `session-log:refresh`, `stats:refresh`.

**Palette** (Ctrl+P): fuzzy search (`command-registry.ts`), arrow / Enter / Escape. Empty-query order is MRU (non-persisted). Every execution fires `before:command:execute` → callback → `after:command:execute`.

## Preset system (`~/.flint/presets/*.json`)

One JSON file per preset; filesystem is source of truth. Fields: `id`, `name`, `plugin_id`, `config_overrides`, `tags[]`, `pinned`, `sort_order`, `created_at`, `last_used_at`. Tauri commands (`presets.rs`): `list_presets`, `save_preset` (upsert by id; preserves timestamps), `delete_preset`, `load_preset`, `touch_preset`.

**Preset form** (`preset-form.tsx`): shared create/edit. Config section is dynamic — reads plugin's `manifest.config_schema`, baseline from `get_plugin_config`, existing overrides on top; on submit, filtered to keys in the active schema.

**Config overrides are session-scoped.** `SessionOverridesState(Mutex<Option<ActiveOverride>>)` NEVER touches `config.toml`. `start_session` stores; `merged_config` / `next_interval` / `get_plugin_config` read; `finalize_session` clears.

## Tag system

Tag index is `Mutex<HashSet<String>>` (`tags.rs`), not persisted. Startup scan runs **asynchronously** — index empty until complete. `start_session` / `finalize_session` call `tags::insert_many` for immediate visibility.

## Quick-start bar

Up to 4 pinned presets (`quick-start-bar.tsx`). Keys `1..4` load these when timer is idle and no overlay is open — bare keys, no modifier.

## Interval authoring (`setFirstInterval` / `setNextInterval`)

```ts
setFirstInterval({ type, target_sec?, metadata? }): Promise<void>
setNextInterval({ type, target_sec?, metadata? }): Promise<void>
```

Push into a per-session pending slot in `EngineState`. Engine consumes then clears — push a fresh directive every transition. `setFirstInterval` is called from `before:session:start`; `setNextInterval` from `after:interval:end` or `before:interval:next`. Try/catch wrapped in built-ins; no-ops on older hosts. See `src-tauri/plugins/pomodoro/index.js` for the production pattern (500 ms transition-deferral guard, `transitioning` flag).

**Custom timer modes:** manifest `"timer_mode": true` auto-registers in tray, `Ctrl+1..9`, default-mode dropdown, quick-start bar. No interval pushed → legacy untimed-focus (stopwatch-like).

## Render spec system (`flint.registerView`)

```ts
registerView(slot, renderFn: () => RenderSpec): () => void
```

Host calls `renderFn` on repaint. Force repaint via `flint.emit("view:dirty", { slot })`.

**Slots:** `sidebar-tab`, `settings`, `post-session`, `status-bar`.

**Widget types** (unknown → muted placeholder): `container` (`direction?`, `gap?`, `padding?`, `children[]`), `text` (`value`, `variant?: "title"|"body"|"muted"|"code"`), `stat-row` (`label`, `value`, `accent?`), `bar-chart` / `line-chart` (`data`, `height?`, `unit?`), `heatmap` (`cells:{date,value}[]`, `weeks?`), `table` (`columns`, `rows`, `maxRows?`), `button` (`label`, `command`, `icon?`). Every plugin-authored render is wrapped in `FlintErrorBoundary`.

## Prompt primitive (`flint.prompt`)

```ts
prompt({ title, body?, accept, decline, timeout? /* ms, cap 60000 */ })
  : Promise<"accepted" | "declined" | "dismissed">
```

Centered dialog. Enter accepts, Escape dismisses, Tab toggles. One at a time — concurrent calls queue FIFO. Missing/zero timeout = sticky. Plugin reload resolves pending prompts `"dismissed"`.

## Plugin API

```ts
interface FlintPluginAPI {
  on(event, cb); hook(event, handler); emit(topic, payload?);
  registerCommand(cmd);
  // engine (wrap in before-hooks for cancellation)
  getTimerState(); getCurrentSession();
  nextInterval(); stopSession(); pauseSession(); resumeSession();
  signal(name, payload?);               // sugar over emit for signal:* namespace
  setFirstInterval(spec); setNextInterval(spec);
  // UI
  registerView(slot, renderFn); prompt(opts);
  renderSlot(slot, text);              // text-only, never HTML
  showNotification(message, options?);
  // data
  stats: { today, range, heatmap, lifetime };           // SQLite cache, O(rows in scope)
  presets: { list, save, delete, load };                // atomic writes
  getSessions(opts?); getConfig(); setConfig(key, value);
  storage: { get(key), set(key, value), delete(key) };  // atomic JSON per key
}
```

Return shapes: `stats.today → {sessions, focus_sec, questions}`, `stats.range → {buckets:{date,focus_sec}[], total_sec}`, `stats.heatmap → {cells:{date,value}[]}`, `stats.lifetime → {sessions, focus_sec, questions, longest_streak_days}`. `presets.save(draft)` upserts by id and preserves `created_at`.

## Plugin sandbox

**Shadowed to `undefined`:** `window`, `document`, `globalThis`, `self`, `parent`, `top`, `frames`, `__TAURI__`, `__TAURI_INTERNALS__`, `__TAURI_INVOKE__`, `__TAURI_METADATA__`, `localStorage`, `sessionStorage`, `indexedDB`, `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator`, `location`, `history`, `Worker`, `SharedWorker`.

**NOT shadowed (built-ins depend on these):** `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `Promise`, `Math`, `JSON`, `Date`, `Number`, `String`, `Array`, `Object`, `Map`, `Set`, `Error`, `URL`, `URLSearchParams`, `TextEncoder`, `TextDecoder`, `structuredClone`, `btoa`, `atob`.

**`new Function` caveat.** Plugins run via `new Function("flint", source)`. A determined plugin can reach `Function` through `(function(){return Function})()` and escape shadowing. Sandbox is defense-in-depth against accidental DOM access, not malicious code — trust model is `npm install`. Future hardening: Web Worker realm.

**`safeCallPlugin` / `safeCallHook`:** every plugin-authored function runs inside a 5-second `Promise.race`; exceeded calls are abandoned and logged.

**Notifications:** 1–15 s duration clamp (`clampDuration` in `plugin-host.tsx`), 3 visible cap, per-plugin `(plugin_id, body)` 10 s dedup window.

## Deletion flows

Sessions and presets are deletable from the UI via inline `[YES] [NO]` confirmation — no modal dialogs.

**Sessions** (`delete_session(id)`): locates file by JSON `.id`, `fs::remove_file`, drops row via `cache::delete_by_id`. **Path-traversal guard** (`validate_session_id`) rejects empty, `/`, `\`, `..`, non-`[A-Za-z0-9_-]`; candidate + `sessions_dir` are canonicalised and the match must stay under `sessions_dir`. UI: hover `×` on row, `[DELETE]` in detail header, `core:delete-selected-session`.

**Presets** (`delete_preset(id)`): hover `×` / `✎` on quick-start tile; `[DELETE]` in preset form edit mode. Per-preset commands cleaned up via `App.tsx` `useEffect` on `presets` change.

Per-session tag edits via `TagAutocomplete` (`×` pill / Backspace). Bulk tag deletion intentionally not implemented.

## Context-aware hover actions

Right-click menus are disabled app-wide. Item actions use Obsidian-style hover-reveal: row/tile is a `group` with action icons `opacity-0` → `group-hover:opacity-100`, muted (`var(--text-muted)`) until hover then accent or `--status-error`. Destructive click swaps row content with inline `[YES] [NO]` (Escape / outside cancels). Action buttons use `tabIndex={-1}` so keyboard focus stays on the primary row button.

## Keyboard map

**Keybinding invariant:** Core keyboard shortcuts (Space, Escape, Enter, Ctrl+P) are reserved routes. Their physical keys and their emitted signals are fixed and non-configurable. Plugins subscribe to signals via flint.on(…) — they do not bind keys directly. Non-reserved keys remain available for plugin registerCommand({ hotkey }) use.

- `Space` — start / pause / resume
- `Enter` — emits `signal:mark` during a running session; inert in core (plugins subscribe)
- `Escape` — stop-confirm, or close modal

App shortcuts (also commands):
- `Ctrl+P` / `Ctrl+B` / `Ctrl+Shift+O` / `Ctrl+,` — palette / sidebar / overlay / settings
- `Ctrl+T` — tag input (legacy); `Ctrl+Q` — quit
- `Ctrl+1..9` — switch timer mode (when idle)
- `1..4` — load pinned preset (when idle, no modifier)

## Design system

- **Terminal / brutalist-minimal.** JetBrains Mono everywhere, **bundled locally (no Google Fonts)**. Near-black void (`#050505` / `#0a0a0a`). Phosphor green accent (`#16a34a`). 2px max border-radius. Zero shadows, gradients, glows, decorative animations.
- **Tokens in `src/index.css`** (CSS variables: `--bg-void`, `--text-bright`, `--accent`, `--status-paused`, …). Prefer `var(--...)` over raw hex.
- **Unicode icons only** — `●`, `‖`, `■`, `▶`, `×`, `«`, `»`, `⟳`, `✦`, `★`. No SVG icon libraries.
- **Animation:** 150–200 ms ease-out, state transitions only. Palette and preset form are instant.
- **Components:** `FlintSelect` (not native `<select>`); wrap plugin-authored/triggered UI in `FlintErrorBoundary`.
- **Modals are viewport-centered:** `position: fixed; top: 14–20vh; left: 50%; transform: translateX(-50%)`. Backdrop `position: fixed; inset: 0` z-60; dialog z-61. Don't use `flex items-start justify-center`.
- **Overlay is off-limits for sandbox features.** Pill is fixed at 336×64. Sandbox features live in the main window.

## Invariants that must NOT be broken

- **Existing `flint.on()` calls in built-in plugins are sacred.** Hook migration is additive — `on()` maps to after-hooks, zero changes to Stopwatch / Countdown / Session Log / Stats. Pomodoro's `on()` calls are unchanged; only *add* new `registerCommand` / `hook` calls to built-ins.
- **Plugin-driven intervals are the primary path.** Do NOT bypass `pending_first_interval` / `pending_next_interval` consumption order. Engine consumes pending slot first, then falls back — reordering silently breaks plugin-authored modes.
- **Render spec must NEVER use `dangerouslySetInnerHTML`.** Plugin-authored content reaches React as structured children only. HTML strings in a render path = sandbox escape.
- **Recovery writes are off the engine mutex.** Snapshot under lock, ship to the background `RecoveryWriter` tokio task (`storage.rs`). Never `write_recovery` inline.
- **Atomic writes only.** Use `storage::write_atomic` for any new file destination. Never raw `fs::write` for durable state.
- **Plugin callbacks go through `safeCallPlugin` / `safeCallHook`** — 5-second timeout.
- **Notifications honor the duration cap.** Use `clampDuration(min=1000, max=15000)` in `plugin-host.tsx`. Don't add notification APIs that bypass it.
- **Interval rate limiter (2 s).** Don't remove `INTERVAL_TRANSITION_COOLDOWN` in `next_interval` — last line of defense against plugin-driven rapid-fire transitions.
- **Plugins are sandboxed.** DOM + network globals shadowed to `undefined` (`plugin-sandbox.ts`). Don't unshadow without audit.
- **Context menu stays disabled.** No right-click menus.
- **Config overrides are session-scoped.** Never persist preset overrides to `config.toml`. `SessionOverridesState` exists to keep experimentation safe.
- **Before-hook coverage stays complete.** Wrap any new timer action in a JS-side wrapper that calls `runBeforeHooks(...)` first. Keyboard, palette, overlay, tray all converge on these wrappers — don't add a fourth path straight to `invoke`.
- **Enter emits `signal:mark`. Core does not handle the signal. Plugins do.** The keyboard route fires `runEmitPipeline("signal:mark", …)`; core holds no counter, writes no state, renders no UI for marks. Plugins subscribe via `flint.on("signal:mark", …)` or cancel via `flint.hook("signal:mark", …)`. Historical `questions_done` migrates to `custom_metadata["lockin.questions_done"]` on read.

## Plugin developer guide

See `src-tauri/plugins/{pomodoro,stopwatch,countdown,session-log,stats}/` for production patterns. Pomodoro is canonical for plugin-driven timer modes.

## Knowledge graph

Graphify graph at `graphify-out/` — auto-updates on git commit. Before architecture questions, read `graphify-out/GRAPH_REPORT.md`; if `graphify-out/wiki/index.md` exists, navigate that. Manual refresh: `/graphify . --update`.

## Commands

- Dev / build: `cargo tauri dev` · `cargo tauri build`
- Frontend: `npx vite` · `npx vite build` · `npx tsc --noEmit`
- Rust: `cargo test` · `cargo check` · `cargo fmt`
