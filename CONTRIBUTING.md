# Contributing to Flint

Thanks for your interest in Flint. This document covers the dev loop, the standards contributions need to meet, and how to get a change merged.

## Dev setup

Prerequisites:

- **Rust** (stable, 1.77+) — `rustup install stable`
- **Node.js 20+**
- **npm** (bundled with Node)
- Platform-specific Tauri prerequisites — follow the [Tauri setup guide](https://tauri.app/start/prerequisites/)

Clone and install:

```bash
git clone https://github.com/techlogist1/flint.git
cd flint
npm install
```

Run the development build (Rust backend + Vite dev server + hot-reloaded webview):

```bash
cargo tauri dev
```

Frontend-only dev server (useful for pure UI work):

```bash
npx vite
```

## Tests and checks

Run all of these before opening a PR. CI runs the same set.

```bash
npx tsc --noEmit                                # type-check the frontend
cd src-tauri && cargo clippy --all-targets -- -D warnings
cd src-tauri && cargo test                      # Rust test suite
```

There are currently no frontend tests. Rust tests cover the timer engine, storage, presets, tag index, commands, and the plugin loader.

## Code style

- **TypeScript** — strict mode, no `any`. Prefer explicit types on public surfaces; let inference handle locals. Use functional components and hooks, no class components. Use `FlintSelect` instead of native `<select>`. Wrap plugin-rendered content in `FlintErrorBoundary`.
- **Rust** — `cargo fmt` before every commit and `cargo clippy -D warnings` clean. Use `thiserror` / `anyhow` patterns already in the codebase. All file writes go through `storage::write_atomic`. Never `fs::write` a durable file directly.
- **Design** — Flint is terminal / brutalist-minimal. JetBrains Mono everywhere, near-black void backgrounds, phosphor green accent, 2px max border-radius, zero shadows or gradients, unicode icons only (`●`, `‖`, `■`, `▶`, `×`). Animations are 150–200ms ease-out on state transitions only. Prefer CSS variables (`var(--bg-void)`, `var(--accent)`, etc.) over raw hex. Never add an SVG icon library and never add right-click menus.
- **Architecture** — Read `CLAUDE.md` before touching anything non-trivial. It documents the architecture invariants that must not be broken: the timer engine runs in Rust and the frontend never ticks itself; render specs are JSON only and never HTML; recovery writes stay off the engine mutex; plugin handlers run inside `safeCallPlugin` / `safeCallHook` with a 5-second timeout. If a change needs to break one of these, open an issue first.

## PR process

1. Fork the repo.
2. Create a feature branch off `master`: `git checkout -b feat/your-change`.
3. Make your change. Keep commits focused — one logical change per commit.
4. Run the three checks above and make sure they pass.
5. Push and open a PR against `master` with a clear description of the change, why it is needed, and how to verify it.
6. CI runs the same type-check / clippy / test trio. A PR cannot merge with a red CI.
7. Address review comments as new commits (do not force-push over review history unless asked).

## Reporting bugs

Open an issue with:

- Flint version (`Settings → About` or the release tag you installed)
- OS and version
- Exact steps to reproduce
- What you expected to happen vs. what actually happened
- Anything relevant from `~/.flint/recovery.json` or the most recent file under `~/.flint/sessions/` (redact tags if they are sensitive)

## Proposing a new feature

Open an issue first to discuss. Flint has a strong primitive-layer philosophy — we prefer to ship a new plugin API that enables a class of features rather than hardcoding one specific feature in core. If the thing you want to build can be a plugin, that is the preferred path; if it cannot, the issue is where we figure out what primitive to add.

## License

Contributions are accepted under the repo's MIT license. By submitting a PR, you agree that your contribution is licensed under the same terms as the project.
