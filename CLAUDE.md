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

## Knowledge Graph
- A Graphify knowledge graph exists at graphify-out/
- Before answering architecture questions, read graphify-out/GRAPH_REPORT.md
- The graph auto-updates on every git commit via hooks
- To manually refresh: /graphify . --update

## Commands
- Dev: `cargo tauri dev`
- Build: `cargo tauri build`
- Frontend only: `npm run dev` (in src-tauri's frontend directory)
- Lint: `npm run lint`
- Format Rust: `cargo fmt`

## PRD
Read PRD.md for complete architecture, data schemas, plugin API, and UI specifications.
