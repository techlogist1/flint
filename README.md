<p align="center">
  <img src="docs/flintcolorlogo.png" alt="Flint — Strike focus." width="420" />
</p>

<p align="center"><strong>Strike focus.</strong></p>

<p align="center">An open-source, local-first, keyboard-driven, plugin-extensible desktop timer. The Obsidian of timers.</p>

<p align="center">
  <a href="https://github.com/techlogist1/flint/actions/workflows/ci.yml"><img src="https://github.com/techlogist1/flint/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
</p>

## Why Flint

Flint is not a timer app — it is a timer engine. The core ships a small set of primitives (hooks, commands, render specs, presets, tags, plugin storage, interval authoring, prompts, stats) and plugins compose any workflow on top. Data lives in plain JSON files under `~/.flint/`; there is no cloud, no account, no telemetry, no network call. Every action is reachable from the command palette or a direct shortcut — the mouse is optional.

## Features

- **Timer modes** — Pomodoro, Stopwatch, Countdown. All three are plugins. Community timer modes ship the same way.
- **Plugin system** — Before- and after-hooks across the full session lifecycle, searchable commands, declarative render specs, per-plugin storage, preset packs, stats queries, and a prompt primitive. Plugins run in a sandbox: no DOM access, no `fetch`, no Tauri internals.
- **Command palette** — `Ctrl+P` opens a fuzzy-search palette for every action in the app. Plugin commands show up next to core ones.
- **Session presets** — One-keystroke start into saved configurations. Overrides are session-scoped and never touch `config.toml`.
- **Tags** — Per-session tags with autocomplete against every tag you have ever used. Plugin hooks can rewrite or veto tag changes.
- **Stats dashboard** — Today, last-seven-days, last-month, yearly heatmap, lifetime totals. Backed by a rebuildable SQLite cache over the session JSON.
- **System tray** — Start, switch mode, stop, quit from the tray menu without touching the main window.
- **Floating overlay pill** — A fixed 336×64 window pinned to any screen corner that shows the current interval and elapsed time.
- **Keyboard-driven** — Fixed core shortcuts (`Space`, `Enter`, `Escape`) plus app-wide `Ctrl+P`, `Ctrl+B`, `Ctrl+Shift+O`, `Ctrl+,`, `Ctrl+Q`, and number keys for mode / preset selection.
- **Local-first** — Session files are the source of truth. Everything else is a cache that can be rebuilt from disk.

## Quick Start

Download the latest release from the [Releases page](https://github.com/techlogist1/flint/releases).

- **Windows:** `.msi` installer
- **macOS (Intel):** `.dmg` for `x86_64-apple-darwin`
- **macOS (Apple Silicon):** `.dmg` for `aarch64-apple-darwin`

First launch creates `~/.flint/`. Press `Space` to start your first session.

## Keyboard Shortcuts

### Core timer keys

| Key | Action |
| --- | --- |
| `Space` | Start / pause / resume |
| `Enter` | Mark a question (while running or paused) |
| `Escape` | Confirm stop, or close a modal |

### App shortcuts

| Key | Action |
| --- | --- |
| `Ctrl+P` | Toggle command palette |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+Shift+O` | Toggle floating overlay |
| `Ctrl+,` | Open settings |
| `Ctrl+T` | Open tag input |
| `Ctrl+Q` | Quit |
| `Ctrl+1..9` | Switch timer mode (when idle) |
| `1..4` | Load pinned preset (when idle, no modifier) |

Every shortcut is also a command in the palette. Hotkeys are fixed in v0.1.

## Plugin System

A Flint plugin is a JavaScript module plus a `manifest.json`. Plugins receive a `flint` API object and run in a sandbox with `window`, `document`, `fetch`, `localStorage`, and Tauri internals shadowed to `undefined`. From inside that sandbox a plugin can:

- **Hook the session lifecycle.** Before-hooks (`flint.hook`) can veto or mutate `session:start`, `session:pause`, `session:resume`, `session:stop`, `session:cancel`, `question:mark`, `interval:next`, `preset:load`, `command:execute`, `notification:show`, `tag:add`, and `tag:remove`. After-hooks (`flint.on`) observe every event, including engine-fired `interval:start`, `interval:end`, `session:complete`, `app:ready`, and `app:quit`.
- **Register commands.** `flint.registerCommand({ id, name, callback })` makes any action searchable from `Ctrl+P`, with optional icon, category, and informational hotkey badge.
- **Author intervals.** `flint.setFirstInterval` and `flint.setNextInterval` push interval directives into the Rust engine's pending slots. The Pomodoro plugin drives its own focus / break / long-break math through these APIs; community timer modes ship the same way by declaring `"timer_mode": true` in the manifest.
- **Render UI declaratively.** `flint.registerView(slot, renderFn)` returns a JSON render spec the host interprets. Supported widgets: `container`, `text`, `stat-row`, `bar-chart`, `line-chart`, `heatmap`, `table`, `button`. Plugins describe what to render, the host renders it — no JSX, no DOM.
- **Prompt the user.** `flint.prompt({ title, body, accept, decline, timeout? })` blocks on a centered dialog and resolves with `"accepted"`, `"declined"`, or `"dismissed"`. Prompts queue; at most one is visible at a time.
- **Show notifications.** `flint.showNotification(msg, { duration })` toasts with duration clamped to 1–15 seconds. At most three are visible; a per-plugin dedup window prevents spam.
- **Read data.** `flint.getSessions()` for raw session JSON, `flint.stats.today() / range(scope) / heatmap(days) / lifetime()` for aggregates straight out of the SQLite cache.
- **Ship preset packs.** `flint.presets.list / save / load / delete` lets a plugin seed starter presets on first load.
- **Persist per-plugin data.** `flint.storage.{get,set,delete}` writes atomic JSON files under `~/.flint/plugins/{id}/data/`. 5 MB cap per key.

### Built-in plugins

- `pomodoro` — configurable focus / break / long-break cycle, drives its own intervals through `setFirstInterval` / `setNextInterval`.
- `stopwatch` — open-ended timer with lap marking via `Enter`.
- `countdown` — fixed-length countdown with configurable duration.
- `session-log` — sidebar tab listing completed sessions with detail view and delete support.
- `stats` — sidebar tab rendering the stats dashboard (today / range / heatmap / lifetime).

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
  direction: "column",
  gap: 12,
  children: [
    { type: "text", value: "HELLO FLINT", variant: "title" },
    { type: "stat-row", label: "Sessions today", value: String(sessionsToday) },
  ],
}));
```

Drop the folder into `~/.flint/plugins/`, restart Flint, and enable the plugin in Settings → Plugins.

For the complete API surface — every hook event, every render spec widget, interval authoring patterns, sandbox details, and the full plugin developer guide — see [CLAUDE.md](./CLAUDE.md).

## Configuration

Global configuration lives at `~/.flint/config.toml` and is human-editable. The file is reloaded on app start.

```toml
[core]
default_mode = "pomodoro"      # which timer mode the app opens in
auto_finalize_on_quit = true   # finalize the running session on quit rather than dropping it

[pomodoro]
focus_duration = 25.0          # minutes
break_duration = 5.0
long_break_duration = 15.0
cycles_before_long = 4
auto_start_breaks = true

[countdown]
duration = 10.0                # minutes

[overlay]
corner = "top-right"           # top-left, top-right, bottom-left, bottom-right
opacity = 0.95

[plugins]
# Plugin enable / disable lives here — managed from Settings → Plugins.
```

Plugin-specific config schemas are authored in each plugin's `manifest.json` under `config_schema` and are rendered automatically in Settings → Plugins. Preset overrides are session-scoped and never persist back to this file.

## Data & Privacy

Flint is local-first, not cloud-first. It does not make network calls, it does not collect telemetry, it does not phone home. Every byte of your data lives on your machine under `~/.flint/`:

```
~/.flint/
├── sessions/              # one JSON file per completed session — the source of truth
├── presets/               # saved session configurations, one JSON per preset
├── plugins/               # community plugins, one folder per plugin, with /data for plugin storage
├── config.toml            # global configuration
├── cache.db               # SQLite read cache — rebuildable, safe to delete
├── recovery.json          # active-session auto-save, deleted on clean end
└── state.json             # app-level UI state (first-close toast shown, etc.)
```

Session files are plain JSON: open them in any editor, grep them with any tool, back them up by copying the folder. The SQLite cache is an index for stats queries and can be rebuilt at any time via the command palette (`core:rebuild-cache`).

No account. No login. No sync. Period.

## Building from Source

Prerequisites:

- **Rust** (stable, 1.77+)
- **Node.js 20+**
- **npm** (bundled with Node)
- Platform-specific Tauri prerequisites — see the [Tauri setup guide](https://tauri.app/start/prerequisites/)

Clone and install:

```bash
git clone https://github.com/techlogist1/flint.git
cd flint
npm install
```

Run the development build:

```bash
cargo tauri dev
```

Produce release binaries:

```bash
cargo tauri build
```

Frontend-only dev server: `npx vite`. Typecheck: `npx tsc --noEmit`. Rust check: `cargo check`. Rust tests: `cargo test`. Format Rust: `cargo fmt`.

## Tech Stack

- **Tauri 2.0** — Rust backend and native webview, ~5–8 MB binary
- **React 18** + **TypeScript** (strict, no `any`) for the frontend
- **Tailwind CSS** + **JetBrains Mono** (bundled locally) for the terminal aesthetic
- **Rust** for the timer engine, session storage, plugin loader, and SQLite cache
- **SQLite** (via `rusqlite`, bundled) as the rebuildable read cache
- **Recharts** for plugin-authored charts in render specs
- **Vite** for frontend bundling and dev server

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, code style, and the PR process.

## License

[MIT](./LICENSE).

## Credits

Built by Lokavya.
