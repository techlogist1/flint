# Flint — Product Requirements Document v1

> The Obsidian of timers. A local-first, keyboard-driven, plugin-extensible open-source timer for focused work.

---

## 1. Identity

- **Name:** Flint
- **Tagline:** Strike focus.
- **Philosophy:** Simple yet functional. A Toyota engine — bulletproof, interchangeable, beautiful in its engineering. No decoration, no theater. Every pixel earns its place through utility.
- **License:** MIT
- **Repository:** github.com/techlogist1/flint
- **Website:** withlockin.com (repurposed as Flint landing page + plugin docs)
- **Branding:** Flint is an independent open-source project. No agency branding, no "Powered by" footer.

---

## 2. Design References

- **Primary:** Obsidian (dark, minimal, sidebar + main area, keyboard-first, plugin-extensible)
- **Overlay:** Wispr Flow pill (minimal floating indicator → expands on click → dynamic island behavior)
- **Spirit:** Neovim, Alacritty, nanoGPT — tools built by engineers who care about the primitive

---

## 3. Tech Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| App shell | Tauri 2.0 | ~5-8MB binary, native performance, cross-platform, Rust backend |
| Backend | Rust | Timer engine, file I/O, SQLite, plugin loader, system tray, overlay window |
| Frontend | React 18 + TypeScript + Tailwind CSS | Developer-familiar, wide contributor pool, reusable skills |
| Data (source of truth) | JSON files in `~/.flint/sessions/` | Portable, human-readable, greppable, no lock-in |
| Data (read cache) | SQLite via Tauri SQL plugin | Fast aggregation queries for stats, rebuilt from JSON |
| Config | TOML (`~/.flint/config.toml`) | Human-editable, standard for Rust ecosystem |
| Plugins | JavaScript/TypeScript | Widest contributor pool, lowest barrier to entry |

---

## 4. Data Architecture

### 4.1 Directory Structure

```
~/.flint/
├── sessions/              # JSON files, one per completed session (source of truth)
│   ├── 2026-04-14_physics_45m_a1b2c3.json
│   ├── 2026-04-14_math_25m_d4e5f6.json
│   └── ...
├── plugins/               # Community plugins (each in its own folder)
│   └── ai-coach/
│       ├── manifest.json
│       └── index.js
├── config.toml            # Global configuration
├── cache.db               # SQLite read cache (rebuildable, deletable)
├── recovery.json          # Active session auto-save (deleted on clean session end)
└── state.json             # App state: window position, sidebar width, last-used mode, etc.
```

### 4.2 Session File Schema

Each completed session writes one JSON file to `~/.flint/sessions/`. Filename format: `{YYYY-MM-DD}_{primary-tag}_{duration}_{short-id}.json`

```json
{
  "id": "a1b2c3d4",
  "version": 1,
  "started_at": "2026-04-14T14:30:00.000Z",
  "ended_at": "2026-04-14T15:15:22.000Z",
  "duration_sec": 2722,
  "mode": "pomodoro",
  "tags": ["physics", "bitsat"],
  "questions_done": 18,
  "completed": true,
  "intervals": [
    { "type": "focus", "start_sec": 0, "end_sec": 1500 },
    { "type": "break", "start_sec": 1500, "end_sec": 1800 },
    { "type": "focus", "start_sec": 1800, "end_sec": 2722 }
  ],
  "plugin_data": {}
}
```

Field notes:
- `id`: 8-char hex, generated at session start
- `version`: schema version for future migrations
- `mode`: one of `pomodoro`, `stopwatch`, `countdown` (set by active plugin)
- `tags`: array of free-form strings, entered by user before or during session
- `questions_done`: incremented by Enter key during session
- `completed`: true if session ended normally, false if cancelled
- `intervals`: array tracking focus/break periods (Pomodoro uses this; Stopwatch has one interval)
- `plugin_data`: object where plugins can store per-session metadata keyed by plugin ID

### 4.3 Recovery File Schema

Written continuously (every 10 seconds + on every state change) to `~/.flint/recovery.json`. Deleted on clean session end. If present at app launch, Flint auto-recovers the session.

```json
{
  "session_id": "a1b2c3d4",
  "started_at": "2026-04-14T14:30:00.000Z",
  "elapsed_sec": 1823,
  "mode": "pomodoro",
  "status": "running",
  "tags": ["physics"],
  "questions_done": 12,
  "intervals": [...],
  "current_interval": { "type": "focus", "start_sec": 1500, "elapsed_sec": 323 },
  "plugin_data": {}
}
```

On launch: if `recovery.json` exists → parse → restore timer state → resume session from where it left off. Show a subtle toast: "Session recovered." No user action required.

### 4.4 Config Schema (`config.toml`)

```toml
[core]
default_mode = "pomodoro"          # pomodoro | stopwatch | countdown
countdown_default_min = 60         # default minutes for countdown mode

[appearance]
sidebar_visible = true
sidebar_width = 220                # pixels

[overlay]
enabled = true
position = "top-right"             # top-left | top-right | bottom-left | bottom-right
opacity = 0.95

[keybindings]
# Core (fixed, not configurable): Space=start/pause, Enter=question, Escape=stop
toggle_sidebar = "CommandOrControl+B"
toggle_overlay = "CommandOrControl+Shift+O"
quick_tag = "CommandOrControl+T"    # opens tag input during session

[pomodoro]
focus_duration = 25
break_duration = 5
long_break_duration = 15
cycles_before_long = 4
auto_start_breaks = true
auto_start_focus = false

[tray]
close_to_tray = true
show_timer_in_tray = true
```

### 4.5 SQLite Cache

The cache database (`~/.flint/cache.db`) is rebuilt from JSON session files. It can be deleted at any time — Flint rebuilds it on next launch by scanning `~/.flint/sessions/`.

Tables:
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_sec INTEGER NOT NULL,
  mode TEXT NOT NULL,
  tags TEXT NOT NULL,          -- JSON array stored as string
  questions_done INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT 1
);

CREATE INDEX idx_sessions_started ON sessions(started_at);
CREATE INDEX idx_sessions_tags ON sessions(tags);
```

Cache rebuild: on launch, compare file count in `sessions/` with row count in `cache.db`. If mismatch → drop table → rescan all JSON files → reinsert. Simple, not incremental — session files are small and total count stays manageable for years.

---

## 5. Timer Engine (Rust Core)

The engine is the Toyota 2JZ of Flint — everything bolts onto it. It runs in Rust, exposes state and events to the React frontend via Tauri's IPC (invoke commands + event system).

### 5.1 State

```rust
pub enum TimerStatus {
    Idle,
    Running,
    Paused,
}

pub struct TimerState {
    pub status: TimerStatus,
    pub elapsed_sec: u64,
    pub questions_done: u32,
    pub current_interval: Option<Interval>,
    pub session_id: Option<String>,
    pub mode: String,
    pub tags: Vec<String>,
}

pub struct Interval {
    pub interval_type: String,   // "focus" or "break"
    pub start_sec: u64,
    pub elapsed_sec: u64,
    pub target_sec: Option<u64>, // Some for timed intervals, None for untimed
}
```

### 5.2 Commands (Frontend → Rust)

These are Tauri invoke commands. The frontend calls them; Rust executes them.

| Command | Args | Behavior |
|---------|------|----------|
| `start_session` | `{ mode, tags }` | Creates session ID, starts timer, begins first interval, writes initial recovery.json |
| `pause_session` | — | Pauses timer, emits `session:pause` event |
| `resume_session` | — | Resumes timer, emits `session:resume` event |
| `stop_session` | — | Stops timer, writes final session JSON, deletes recovery.json, emits `session:complete` |
| `cancel_session` | — | Stops timer, writes session JSON with `completed: false`, deletes recovery.json, emits `session:cancel` |
| `mark_question` | — | Increments `questions_done`, emits `question:marked` event |
| `get_timer_state` | — | Returns current `TimerState` |
| `next_interval` | — | Ends current interval, starts next (used by Pomodoro for focus→break transitions) |
| `set_tags` | `{ tags }` | Updates tags on active session |

### 5.3 Events (Rust → Frontend)

Emitted via Tauri's event system. Plugins listen to these.

| Event | Payload | When |
|-------|---------|------|
| `session:start` | `{ session_id, mode, tags }` | Session begins |
| `session:pause` | `{ elapsed_sec }` | User pauses |
| `session:resume` | `{ elapsed_sec }` | User resumes |
| `session:tick` | `{ elapsed_sec, interval_elapsed, interval_remaining }` | Every second while running |
| `session:complete` | `{ session_id, duration_sec, questions_done }` | Session ends normally |
| `session:cancel` | `{ session_id, duration_sec }` | Session cancelled |
| `interval:start` | `{ type, target_sec }` | New interval begins (focus/break) |
| `interval:end` | `{ type, duration_sec }` | Interval ends |
| `question:marked` | `{ total_questions }` | Enter key pressed |
| `recovery:restored` | `{ session_id, elapsed_sec }` | Session recovered from crash |

### 5.4 Timer Tick Implementation

The Rust backend runs a tick loop (using `tokio::time::interval` or Tauri's async runtime). Every second:
1. Increment `elapsed_sec` and `current_interval.elapsed_sec`
2. Emit `session:tick` event
3. Check if interval has reached target (for timed modes) → emit `interval:end` if so
4. Every 10 seconds: write `recovery.json`

The frontend does NOT run its own timer. It listens to `session:tick` events and renders. This ensures timer accuracy regardless of frontend rendering performance.

---

## 6. Plugin System

### 6.1 Plugin Manifest (`manifest.json`)

Every plugin has a `manifest.json` in its directory:

```json
{
  "id": "pomodoro",
  "name": "Pomodoro Timer",
  "version": "1.0.0",
  "description": "Focus/break interval cycling with configurable durations.",
  "author": "Flint",
  "type": "default",
  "entry": "index.js",
  "ui_slots": ["settings"],
  "events": ["session:start", "interval:end", "session:complete"],
  "config_schema": {
    "focus_duration": { "type": "number", "default": 25, "label": "Focus duration (min)" },
    "break_duration": { "type": "number", "default": 5, "label": "Break duration (min)" },
    "long_break_duration": { "type": "number", "default": 15, "label": "Long break (min)" },
    "cycles_before_long": { "type": "number", "default": 4, "label": "Cycles before long break" },
    "auto_start_breaks": { "type": "boolean", "default": true, "label": "Auto-start breaks" },
    "auto_start_focus": { "type": "boolean", "default": false, "label": "Auto-start focus after break" }
  }
}
```

Field notes:
- `type`: `"default"` (ships with Flint, lives in app bundle) or `"community"` (in `~/.flint/plugins/`)
- `ui_slots`: array of slots this plugin can render into. Options: `"sidebar-tab"`, `"settings"`, `"post-session"`, `"status-bar"`
- `events`: which timer events the plugin subscribes to
- `config_schema`: auto-generates a settings UI for the plugin. Users configure via the Settings panel without touching files.

### 6.2 Plugin API

Plugins are JS/TS files executed in a sandboxed context. They receive a `flint` API object:

```typescript
interface FlintPluginAPI {
  // Timer interaction
  on(event: string, callback: (payload: any) => void): void;
  getTimerState(): Promise<TimerState>;
  nextInterval(): Promise<void>;

  // Session data
  getSessions(options?: { limit?: number; tags?: string[]; since?: string }): Promise<Session[]>;
  getCurrentSession(): Promise<ActiveSession | null>;

  // Plugin config
  getConfig(): Promise<Record<string, any>>;
  setConfig(key: string, value: any): Promise<void>;

  // UI
  renderSlot(slot: string, text: string): void; // text-only, never HTML (S-C2)
  showNotification(message: string, options?: { duration?: number }): void;

  // Storage (plugin-local, persisted in ~/.flint/plugins/{id}/data/)
  storage: {
    get(key: string): Promise<any>;
    set(key: string, value: any): Promise<void>;
    delete(key: string): Promise<void>;
  };
}
```

### 6.3 Plugin Loader Flow

1. On app launch, Rust scans two directories:
   - Built-in plugins (bundled in app resources)
   - `~/.flint/plugins/` (community plugins)
2. For each directory with a valid `manifest.json`, register the plugin
3. Check `config.toml` for `[plugins.{id}]` enabled/disabled state (default: enabled for built-in, disabled for community until user enables)
4. For enabled plugins: load `entry` JS file, provide `flint` API, call plugin's `activate()` function
5. Subscribe plugin to its declared events

### 6.4 Default Plugins Specification

#### Pomodoro (`pomodoro`)
- Manages focus/break interval cycling
- On `session:start`: begins first focus interval with configured duration
- On `interval:end`: if focus → start break (or long break after N cycles). If break → start next focus (if auto-start enabled) or wait
- UI slot: `settings` (focus/break/long break durations, cycle count, auto-start toggles)
- Writes interval data to `session.intervals[]`

#### Stopwatch (`stopwatch`)
- Simple count-up timer with no intervals
- On `session:start`: creates one continuous "focus" interval
- No interval management, no break logic
- The simplest mode — just counts up until user stops

#### Countdown (`countdown`)
- Set a target duration, count down to zero
- On `session:start`: begins countdown from configured/user-specified minutes
- On reaching zero: emit `session:complete`, play system notification
- UI slot: `settings` (default countdown duration)

#### Session Log (`session-log`)
- Browses session history from `~/.flint/sessions/`
- UI slot: `sidebar-tab` (shows scrollable list of past sessions: date, tags, duration, questions)
- Click a session → shows detail panel in main area with interval breakdown
- Search/filter by tag, date range

#### Stats Dashboard (`stats`)
- Aggregates session data for analytics
- UI slot: `sidebar-tab` (shows charts and metrics)
- Views:
  - **Today:** total focus time, session count, questions done
  - **Week/Month:** daily focus time bar chart, tag distribution, streak counter
  - **Heatmap:** GitHub-style contribution heatmap showing study intensity per day
- Reads from SQLite cache for fast queries
- Charts: use Recharts (React charting library, already well-supported in the ecosystem)

---

## 7. UI Architecture

### 7.1 Layout

```
┌─────────────────────────────────────────────────────┐
│  Flint                                    [─] [□] [×] │
├──────────┬──────────────────────────────────────────┤
│          │                                          │
│ SIDEBAR  │              MAIN AREA                   │
│ (220px)  │                                          │
│          │         ┌─────────────┐                  │
│ [Tabs]   │         │   00:00:00  │                  │
│          │         │             │                  │
│ Recent   │         │  Pomodoro   │                  │
│ Sessions │         │  25m focus  │                  │
│          │         └─────────────┘                  │
│ ...      │                                          │
│          │      Press Space to start                │
│          │                                          │
│          │                                          │
│          │                                          │
│          ├──────────────────────────────────────────┤
│          │  [status-bar slot]          Q: 0 │ 00:00 │
│ [⚙]     │                                          │
└──────────┴──────────────────────────────────────────┘
```

**Sidebar (left, 220px default, collapsible with Cmd/Ctrl+B):**
- Top: tab icons for plugin sidebar tabs (Session Log, Stats, and any community plugin tabs)
- Middle: content area rendered by the active sidebar tab plugin
- Bottom: settings gear icon → opens Settings panel in main area

**Main Area (right, fills remaining space):**
- Default view: Timer display (large monospace digits, mode label, progress indicator)
- Settings view: when gear is clicked, replaces timer with settings panels
- Post-session view: briefly shows session summary after completion, plugin post-session slots render here

**Status Bar (bottom of main area):**
- Minimal info line: question count, elapsed time, active mode
- Plugin `status-bar` slot renders here

### 7.2 Timer Display (Main Area — Idle State)

```
          00:00:00

       Pomodoro · 25m focus
    
     Press Space to start
```

- Timer digits: large, monospace font (system monospace: `ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', monospace`)
- Mode label: clean sans-serif, muted color
- Hint text: very subtle, disappears after first-ever session (tracked in `state.json`)
- Below hint: tag input area (subtle, inline, type tags separated by comma, press Enter to confirm)

### 7.3 Timer Display (Running State)

```
          25:42

       Pomodoro · Focus
       ████████░░░░░░░░  
    
       Q: 12
```

- Timer digits: counting down (Pomodoro/Countdown) or up (Stopwatch)
- Progress bar: thin, minimal, shows interval progress (not total session)
- Question count: only visible if `questions_done > 0`
- No hint text during active session
- Background subtle pulse or slight brightness shift to indicate "active" — no animation beyond that

### 7.4 Overlay (Always-on-Top Pill)

The overlay is a separate native window (Tauri supports multi-window). It is always-on-top, frameless, transparent background, draggable.

**Collapsed state (default during session):**
```
┌──────────────────┐
│  ● 25:42         │
└──────────────────┘
```
- Small rounded pill (~200x36px)
- Green dot = running, yellow dot = paused, no dot = idle
- Timer digits only
- Click anywhere → expand
- Drag from any point → reposition

**Expanded state (on click):**
```
┌──────────────────────────┐
│  ● 25:42     Focus       │
│  ████████░░░  Q: 12      │
│  [⏸] [⏹]  [Open Flint]  │
└──────────────────────────┘
```
- Smooth expand animation (~200ms ease-out)
- Shows: timer, mode label, progress, question count
- Controls: Pause/Resume button, Stop button, "Open Flint" button (focuses main window)
- Click outside or press Escape → collapse back to pill
- Size: ~280x100px expanded

**Technical implementation:**
- Tauri `WebviewWindow::new()` with `always_on_top: true`, `decorations: false`, `transparent: true`
- Communicates with main window via Tauri event system (same `session:tick` events)
- Position saved in `config.toml` → `[overlay] position`
- Toggle with `Cmd/Ctrl+Shift+O`

### 7.5 System Tray

- **Icon:** Flint logo (static when idle, active indicator dot when timer running)
- **Left-click:** Toggle main window visibility (show/hide)
- **Right-click menu:**
  - `Start Pomodoro` / `Start Stopwatch` / `Start Countdown` (quick-start with last tags)
  - `Show Overlay` / `Hide Overlay` (toggle)
  - Separator
  - `Open Flint` (focus main window)
  - `Quit Flint` (actually exits the app)
- **Close button (×) behavior:** Minimizes to tray, does NOT quit. If timer is running, session continues. Toast on first close: "Flint minimized to tray. Right-click tray icon → Quit to exit." (shown once, tracked in `state.json`)

### 7.6 Settings Panel

Opens in main area when gear icon is clicked. Organized in sections:

- **General:** Default mode, countdown default duration
- **Appearance:** Sidebar width (slider)
- **Overlay:** Enable/disable, position, opacity
- **Keybindings:** Configurable shortcuts (shows current binding, click to rebind)
- **Plugins:** List of all plugins (default + community), enable/disable toggle for each, per-plugin config (rendered from `config_schema` in manifest)
- **Data:** Path to data directory (read-only display), "Open data folder" button, "Rebuild cache" button, "Export all sessions" button (exports as ZIP of JSON files)

### 7.7 Design Tokens

Dark theme only. Obsidian-adjacent palette.

```css
/* These are guidelines, not exact — Claude Code should use its design judgment */
--bg-primary: #1e1e1e;         /* Main background */
--bg-secondary: #252525;       /* Sidebar, panels */
--bg-elevated: #2d2d2d;        /* Cards, hover states */
--border: #333333;             /* Subtle borders, 1px */
--text-primary: #e0e0e0;       /* Main text */
--text-secondary: #888888;     /* Labels, hints */
--text-muted: #555555;         /* Disabled, placeholder */
--accent: #4a9eff;             /* Active states, links, progress bars */
--accent-subtle: #4a9eff22;    /* Accent backgrounds */
--success: #4ade80;            /* Running indicator, completed */
--warning: #fbbf24;            /* Paused indicator */
--danger: #ef4444;             /* Stop, cancel, destructive */
```

Typography:
- Timer digits: `ui-monospace, 'SF Mono', 'Cascadia Code', 'Consolas', monospace`
- UI text: system sans-serif stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`)
- No custom fonts (no web font loading, no Google Fonts — keep the binary clean)

Principles:
- No gradients
- No shadows (except overlay, which needs a subtle shadow to float visually)
- Borders: 1px solid `--border`, used sparingly
- Border radius: 6px for containers, 4px for buttons, 50% for pills/dots
- Spacing: 8px base grid
- Micro-animations: only for state transitions (expand/collapse, view switches). Duration: 150-200ms. Easing: ease-out. No decorative animations.

---

## 8. Keyboard Interaction

### 8.1 Core Keys (Fixed, Not Configurable)

| Key | Context | Action |
|-----|---------|--------|
| `Space` | Idle | Start session with last-used mode and tags |
| `Space` | Running | Pause session |
| `Space` | Paused | Resume session |
| `Enter` | Running/Paused | Mark question done (+1) |
| `Escape` | Running/Paused | Stop session (prompts: "End session? Enter to confirm, Escape to cancel") |
| `Escape` | Any modal/panel | Close panel, return to timer |

### 8.2 Configurable Keys (Defaults, remappable in config.toml)

| Default Key | Action |
|-------------|--------|
| `Cmd/Ctrl+B` | Toggle sidebar |
| `Cmd/Ctrl+Shift+O` | Toggle overlay |
| `Cmd/Ctrl+T` | Open tag input (during session) |
| `Cmd/Ctrl+,` | Open settings |
| `Cmd/Ctrl+1` | Switch to Pomodoro mode (while idle) |
| `Cmd/Ctrl+2` | Switch to Stopwatch mode (while idle) |
| `Cmd/Ctrl+3` | Switch to Countdown mode (while idle) |

### 8.3 Focus Management

- App opens with focus on main timer area
- Tab cycles between: sidebar ↔ main area
- Within sidebar: arrow keys navigate session list
- No focus traps — Escape always returns to timer view
- All interactive elements are keyboard-accessible

---

## 9. Distribution

### 9.1 Build Pipeline

Tauri's built-in bundler handles cross-platform builds:

- **Windows:** `.msi` installer via `tauri build --target x86_64-pc-windows-msvc`
- **Mac (Intel):** `.dmg` via `tauri build --target x86_64-apple-darwin`
- **Mac (Apple Silicon):** `.dmg` via `tauri build --target aarch64-apple-darwin`

GitHub Actions workflow: on tag push (`v*`), build all three targets, create GitHub Release with all binaries attached.

### 9.2 Signing

- **v1:** Unsigned. Windows SmartScreen warning ("More info → Run anyway"). Mac Gatekeeper warning (right-click → Open → confirm). Standard for open-source tools.
- **Future:** Apple Developer ID ($99/year) and Windows code signing when/if adoption justifies it.

### 9.3 Auto-Update

Tauri has a built-in updater. Configure to check GitHub Releases for new versions. Show a subtle notification in-app: "Flint v1.1.0 available. Update?" — never force.

---

## 10. Landing Page (withlockin.com)

Repurpose the existing domain. The page is static — no app functionality on the web.

### 10.1 Structure

1. **Hero:** App name, tagline ("Strike focus."), one-line description, screenshot of the app, "Download for Mac" + "Download for Windows" buttons (link to GitHub Releases)
2. **What is Flint:** 3-4 short paragraphs explaining the philosophy: local-first, keyboard-driven, plugin-extensible, open-source
3. **Features grid:** 6 cards — Timer Engine, Plugin System, Keyboard-First, Overlay, Local Data, Open Source
4. **Getting Started:** Quick install instructions (download, run, press Space)
5. **Plugins:** Brief explanation of plugin system + link to plugin docs (can be a separate `/docs` page or GitHub wiki)
6. **Footer:** GitHub repo link, MIT license, "Built by Lokavya"

### 10.2 Tech

- Plain HTML + Tailwind CSS (via CDN) or a simple Next.js static export
- Deployed on Vercel (already configured for withlockin.com)
- Dark theme matching the app aesthetic
- No analytics, no tracking, no cookies — practice what you preach

---

## 11. Build Phases

Each phase is a **separate Claude Code session** with fresh context. Start each session with:

```
Read CLAUDE.md and PRD.md. Execute Phase X: [name].
Scope: [what to build]
Verify: [how to confirm it works]
Do not modify anything outside this scope.
```

### Phase 1 — Scaffold + Project Structure (Session 1)

**Scope:** Initialize Tauri 2.0 project with React + TypeScript + Tailwind frontend. Create the full directory structure. Write CLAUDE.md for the project. Configure Tailwind with design tokens. Set up basic window with title bar.

**Deliverables:**
- Working Tauri dev build (`cargo tauri dev` launches a window)
- React app renders "Flint" in the window
- Tailwind configured with CSS variables from Section 7.7
- `~/.flint/` directory creation on first launch
- CLAUDE.md in repo root
- `.gitignore` configured (node_modules, target, dist, .env)
- `package.json` with all frontend dependencies

**Verify:** `cargo tauri dev` opens a dark window with "Flint" text. `~/.flint/` directory exists.

### Phase 2 — Timer Engine (Session 2)

**Scope:** Implement the full Rust timer engine from Section 5. All commands, all events, tick loop, recovery file writing, session file writing. No frontend interaction yet — test via Tauri invoke commands from a basic debug UI.

**Deliverables:**
- All 8 Tauri commands from Section 5.2
- All 10 events from Section 5.3
- Tick loop running in async Rust
- `recovery.json` written every 10s + on state change
- Session JSON file written to `~/.flint/sessions/` on session complete/cancel
- Recovery detection and restoration on launch
- `config.toml` parsing (create default if missing)

**Verify:** Start a session via invoke → tick events fire → mark questions → stop → JSON file appears in `~/.flint/sessions/`. Kill process mid-session → relaunch → session recovers.

### Phase 3 — Frontend Shell (Session 3)

**Scope:** Build the complete React UI structure from Section 7. Sidebar, main area, timer display, settings panel, status bar. Connect to timer engine events. Keyboard interactions from Section 8.

**Deliverables:**
- Collapsible sidebar with tab system
- Timer display (idle + running + paused states)
- Keyboard handling (Space, Enter, Escape, all configurable keys)
- Settings panel UI (reads/writes config.toml via Tauri commands)
- Tag input flow (Cmd/Ctrl+T during idle or session)
- Mode switching (Cmd/Ctrl+1/2/3 while idle)
- Status bar with question count and elapsed time
- Session stop confirmation (Escape → "End session?" prompt)

**Verify:** Full keyboard-driven flow: launch → press Space → timer counts → Enter marks questions → Escape → confirm → session saved. Cmd/Ctrl+B toggles sidebar. Settings panel opens and closes.

### Phase 4 — Plugin System + Pomodoro (Session 4)

**Scope:** Implement the plugin loader from Section 6. Build the Pomodoro plugin as the first default plugin to validate the architecture. Plugin manifest parsing, API injection, event routing, UI slot rendering.

**Deliverables:**
- Plugin loader (scans built-in + `~/.flint/plugins/`)
- Plugin API object (Section 6.2)
- Plugin manifest parsing and validation
- UI slot rendering system (sidebar-tab, settings, post-session, status-bar)
- Pomodoro plugin: full interval cycling, configurable durations, auto-start logic
- Plugin enable/disable in settings
- Plugin config UI auto-generated from `config_schema`

**Verify:** Start session → Pomodoro mode activates → focus interval counts down → auto-transitions to break → cycles correctly → long break after N cycles. Plugin settings appear in Settings panel and changes take effect.

### Phase 5 — Remaining Default Plugins (Session 5)

**Scope:** Build Stopwatch, Countdown, Session Log, and Stats Dashboard plugins.

**Deliverables:**
- Stopwatch plugin: simple count-up, single interval
- Countdown plugin: count-down from configurable duration, completion notification
- Session Log plugin: sidebar tab, scrollable session list, search/filter by tag and date, session detail view
- Stats Dashboard plugin: sidebar tab, today/week/month views, daily bar chart, tag distribution, streak counter, heatmap
- SQLite cache: creation, rebuild from JSON, query functions for stats

**Verify:** All three timer modes work end-to-end. Session Log shows past sessions and filters correctly. Stats Dashboard shows accurate data from session history.

### Phase 6 — Overlay + System Tray (Session 6)

**Scope:** Implement the always-on-top overlay window (Section 7.4) and system tray (Section 7.5).

**Deliverables:**
- Overlay: separate Tauri WebviewWindow, always-on-top, frameless, transparent
- Overlay collapsed state: pill with timer digits and status dot
- Overlay expanded state: timer + controls + "Open Flint" button
- Click-to-expand / click-outside-to-collapse animation
- Draggable repositioning, position saved to config
- System tray: icon, left-click toggle, right-click menu
- Close-to-tray behavior with first-time toast notification
- Cmd/Ctrl+Shift+O toggles overlay

**Verify:** Start session → overlay pill appears → shows timer → click expands with controls → pause/stop work from overlay → collapse back to pill. Close window → app in tray → right-click → menu works → Quit actually exits.

### Phase 7 — Build Pipeline + GitHub Release (Session 7)

**Scope:** Set up GitHub Actions for cross-platform builds and automated releases.

**Deliverables:**
- GitHub Actions workflow: build on tag push for Windows (.msi), Mac Intel (.dmg), Mac ARM (.dmg)
- Tauri updater configuration (check GitHub Releases)
- README.md: hero section, description, features, screenshots placeholder, installation instructions, "Getting Started", tech stack, contributing guidelines, license
- CONTRIBUTING.md: how to set up dev environment, how to write a plugin, PR guidelines
- LICENSE file (MIT)
- `.env.example` if any env vars needed

**Verify:** Push a `v0.1.0` tag → GitHub Action builds all three targets → Release appears with downloadable binaries. README renders correctly on GitHub.

### Phase 8 — Landing Page (Session 8)

**Scope:** Update withlockin.com to be the Flint landing page (Section 10).

**Deliverables:**
- New landing page at withlockin.com matching Section 10.1 structure
- Dark theme matching app aesthetic
- Download buttons linking to GitHub Releases
- Mobile-responsive
- Deployed on Vercel

**Verify:** withlockin.com loads, looks clean, download buttons point to correct GitHub Release URLs.

---

## 12. CLAUDE.md Template

This goes in the Flint repo root. ~100 lines, every line earns its place.

```markdown
# Flint

Open-source, local-first, keyboard-driven, plugin-extensible timer for focused work.

## Stack
- Tauri 2.0 (Rust backend + React frontend)
- React 18 + TypeScript + Tailwind CSS
- SQLite (read cache) + JSON session files (source of truth)
- Plugin system: JS/TS plugins with manifest.json

## Architecture
- Timer engine runs in Rust. Frontend listens to Tauri events. Frontend NEVER runs its own timer.
- Data lives in ~/.flint/ (sessions/, plugins/, config.toml, cache.db)
- Session files are JSON, one per session, in ~/.flint/sessions/
- SQLite cache is rebuildable from session files — treat it as disposable
- Plugins are JS/TS in ~/.flint/plugins/{id}/ with manifest.json

## Code Style
- TypeScript strict mode, no `any`
- Functional React components with hooks
- Tailwind for all styling — no CSS modules, no styled-components
- CSS variables for design tokens (defined in index.css)
- File naming: kebab-case for files, PascalCase for components
- Rust: standard cargo fmt conventions

## Key Constraints
- KEYBOARD-FIRST: every interaction must be keyboard-accessible. Space=start/pause, Enter=question, Escape=stop. These are fixed and non-configurable.
- LOCAL-FIRST: no network calls, no cloud, no accounts, no analytics. All data stays on disk.
- DARK ONLY: one theme, no light mode in v1.
- NO DECORATIVE ANIMATIONS: micro-animations for state transitions only (150-200ms ease-out). No particles, no glows, no gradients.
- RECOVERY: write recovery.json every 10s and on state change. If recovery.json exists on launch, auto-restore session.
- PLUGIN ISOLATION: plugins receive a sandboxed API object. They cannot access filesystem directly or modify core state outside the API.

## Commands
- Dev: `cargo tauri dev`
- Build: `cargo tauri build`
- Frontend only: `npm run dev` (in src-tauri's frontend directory)
- Lint: `npm run lint`
- Format Rust: `cargo fmt`

## PRD
Read PRD.md for complete architecture, data schemas, plugin API, and UI specifications.
```

---

## 13. Non-Goals (Explicitly Out of Scope for v1)

- Cloud sync / accounts / login
- Mobile app (iOS/Android)
- Browser extension
- Light theme
- AI features (community plugin, not built-in)
- Plugin marketplace UI (plugins installed by dropping into `~/.flint/plugins/`)
- Spaced repetition / flashcards
- Music / ambient sounds (community plugin territory)
- Social features / leaderboards
- Data export to third-party services
- Multi-language / i18n

---

## 14. Future Considerations (Post-v1, Documented for Context)

- Plugin marketplace (browse + install from within the app)
- Theme system (community themes)
- Sync via git (version-control your `~/.flint/` directory)
- CLI interface (`flint start pomodoro --tags physics` from terminal)
- Linux builds
- Plugin SDK with TypeScript types package
- AI Coach plugin (Ollama integration for session pattern analysis)
- Website blocker plugin
- Spotify/music integration plugin
- Todoist/Notion/Obsidian sync plugins
- Import from other timer apps

---

*End of PRD. This document is the exoskeleton. Claude Code sessions execute phases against this spec.*
