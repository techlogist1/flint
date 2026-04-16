# Flint

Local-first, keyboard-driven, plugin-extensible timer for focused work. Built with Tauri 2.0, React, TypeScript, and Rust.

> Strike focus.

## What is Flint

Flint is an open-source timer that ships a strong primitive layer — hooks, commands, presets, tags, render specs, plugin storage — for composing your own workflow on top. Built-in plugins (Pomodoro, Stopwatch, Countdown, Session Log, Stats Dashboard) ship today and use the same APIs that community plugins use.

The philosophy: the *Obsidian of timers*. Core stays small. Everything else is a plugin.

## Status (v0.1)

- Built-in: Pomodoro, Stopwatch, Countdown, Session Log, Stats Dashboard
- Cross-platform: Windows, macOS (Linux planned)
- Local-first: all session data lives in `~/.flint/`. No accounts, no telemetry, no network calls.
- Keyboard-first: every action is reachable from the command palette (Ctrl+P) or a direct shortcut.
- The plugin API is a *preview*. The primitive layer is real and stable. The richer rendering and prompt surfaces are documented below; some are landing across the v0.1 → v0.2 cycle.

## Install

Download the latest release from [GitHub Releases](https://github.com/techlogist1/flint/releases) and run the installer for your platform. Windows: `.msi`. macOS: `.dmg` (Intel and Apple Silicon).

First launch creates `~/.flint/`. Press Space to start your first session.

## Build from source

```
cargo tauri dev      # development build
cargo tauri build    # production build
```

Frontend-only: `npx vite`. Typecheck: `npx tsc --noEmit`. Rust check: `cargo check`.

## Plugin System

Flint plugins are JavaScript modules with a manifest. They run in a sandboxed context and receive a `flint` API object. They can:

- **Hook into the session lifecycle** — `flint.on(event, cb)` for after-events (observation), `flint.hook(event, handler)` for before-events (interception). Cancel a session-start by returning `{ cancel: true }`. Mutate the context object to rewrite tags, override config, swap notification text.
- **Register commands** — `flint.registerCommand({ id, name, callback })`. Commands appear in the Ctrl+P palette with fuzzy search.
- **Author intervals** — `flint.setFirstInterval({ type, target_sec })` and `flint.setNextInterval({ type, target_sec })` push interval directives into the engine. The Pomodoro plugin is the first consumer: it now drives its own focus/break/long-break math instead of relying on hardcoded engine logic.
- **Render UI** — `flint.registerView(slot, () => renderSpec)` returns a JSON spec the host interprets into React. Supported widgets: `container`, `text`, `stat-row`, `bar-chart`, `line-chart`, `heatmap`, `table`, `button`. Plugins describe what to render, the host renders it.
- **Show notifications** — `flint.showNotification(message, { duration? })`. Capped at 3 visible. Auto-dismiss honours the requested duration within a 1–15 second range.
- **Prompt the user** — `flint.prompt({ title, body, accept, decline, timeout? })` blocks on a centered dialog and resolves with `"accepted" | "declined" | "dismissed"`.
- **Read sessions and stats** — `flint.getSessions()` for raw session JSON, `flint.stats.today() / range(scope) / heatmap(days) / lifetime()` for fast aggregates from the SQLite cache.
- **Manage presets** — `flint.presets.list() / save(preset) / delete(id) / load(id)`. Plugins can ship preset packs.
- **Persist data** — `flint.storage.{get,set,delete}` writes per-plugin JSON files under `~/.flint/plugins/{id}/data/`. Atomic, isolated, 5 MB cap per key.

### Minimal example

`~/.flint/plugins/hello-flint/manifest.json`:

```json
{
  "id": "hello-flint",
  "name": "Hello Flint",
  "version": "1.0.0",
  "description": "A minimal plugin that registers a command and renders a sidebar view.",
  "author": "you",
  "type": "community",
  "entry": "index.js",
  "ui_slots": ["sidebar-tab"],
  "events": ["session:complete"],
  "config_schema": {}
}
```

`~/.flint/plugins/hello-flint/index.js`:

```js
let sessionsToday = 0;

flint.on("session:complete", () => {
  sessionsToday += 1;
});

flint.registerCommand({
  id: "hello-flint:reset",
  name: "Hello Flint: reset counter",
  category: "hello",
  callback: () => { sessionsToday = 0; },
});

flint.registerView("sidebar-tab", () => ({
  type: "container",
  children: [
    { type: "text", value: "HELLO FLINT", variant: "title" },
    { type: "stat-row", label: "Sessions today", value: String(sessionsToday) },
  ],
}));
```

Drop the folder into `~/.flint/plugins/`, restart Flint, and enable the plugin in Settings → Plugins.

### Caveats and honest limits

- **No custom React components.** Plugins describe UI via render specs interpreted by the host. JSX, DOM access, and arbitrary React are not available — `document`, `window`, `fetch`, and the Tauri internals are all shadowed in the sandbox. This is intentional: it preserves the security guarantee while still letting plugins render real visualizations.
- **No DOM access.** Plugins cannot attach event listeners, query elements, or read layout. Use commands and the prompt primitive for interaction.
- **Notifications auto-dismiss.** You can request a duration between 1 and 15 seconds; the host caps the rest. There are at most three notifications visible at once and a per-plugin dedup window prevents spam.
- **Hotkeys are informational.** A `hotkey` field on a command is a label only — Flint does not yet support custom keybindings (the fixed Space / Enter / Escape and Ctrl+P / Ctrl+B / Ctrl+, are non-configurable in v0.1).
- **Plugin handlers are timed out at 5 seconds.** A buggy or slow handler cannot wedge the host. After 5 s the call is abandoned and an error is logged.
- **Render specs are JSON, not HTML.** No `dangerouslySetInnerHTML`. No script execution.

For the complete API surface, hook event catalog, render spec widget reference, and authoring patterns, see [CLAUDE.md](./CLAUDE.md).

## Architecture

- Tauri 2.0 (Rust backend + React + TypeScript frontend)
- Tailwind CSS for styling, JetBrains Mono everywhere, terminal aesthetic
- SQLite read cache (rebuildable) + JSON session files (source of truth) under `~/.flint/sessions/`
- Plugin loader scans built-in resources and `~/.flint/plugins/` at startup
- Recovery file written every 10 s and on state change so a crashed session is restored on next launch

The Rust timer engine owns the tick loop; the frontend listens to Tauri events and never runs its own timer.

## License

MIT. See `LICENSE`.
