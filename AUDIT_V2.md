# Flint — Audit Report V2

> Second-pass audit after commit `62dc4c8`. Scope weighted toward the four active complaints:
> (1) overlay renders a visible black rectangle on the desktop, (2) the app freezes / stops
> responding during Pomodoro cycling and Alt-Tab, (3) general visual glitches and lag,
> (4) overlay expand/collapse animation is still not smooth.
> All findings classified **CRITICAL / HIGH / MEDIUM / LOW**. No fixes applied.

**Audit date:** 2026-04-15
**Scope:** `src-tauri/` (10 Rust files), `src/` (23 TS/TSX files), 5 built-in plugins, `tauri.conf.json`, `overlay.html`, `index.css`. Cross-checked against `AUDIT_REPORT.md` — findings that carried over or regressed are marked with the original ID.

---

## 1. OVERLAY ARCHITECTURE — the black rectangle, frame-by-frame

### CRITICAL

**O-C1. The overlay Tauri window is opaque. This is the visible black rectangle.**
`src-tauri/src/overlay.rs:39` calls `.transparent(false)` on `WebviewWindowBuilder`. The window is then created at a fixed `288 × 108` (`WINDOW_W`/`WINDOW_H`, lines 15-16) with `decorations(false)` and `shadow(false)`. Because the native surface is opaque, every pixel of the `288×108` frame is painted with *something* — and `src/overlay-app.tsx:268` tells React to paint the root `<div className="flex h-screen w-screen …" style={{ background: SURFACE_BG }}>` with `#1a1a1a`. `src/index.css:51-58` doubles down:
```css
body.flint-overlay-body                { background-color: #1a1a1a; }
body.flint-overlay-body,
body.flint-overlay-body #root           { background-color: #1a1a1a; }
```
Result on the desktop: a `288×108` solid `#1a1a1a` rectangle sits behind the pill. The collapsed pill is `208×36` and the expanded card is `272×92` (`overlay-app.tsx:22-25`) — both smaller than the window, so a 40px horizontal margin and a ~16px+56px vertical margin of the opaque background leaks out.

**Fix:** three coordinated changes, all required:
1. `overlay.rs:39` → `.transparent(true)`.
2. `index.css:51-58` → delete the `body.flint-overlay-body` background rules (or set `background: transparent !important`). Keep `color-scheme: dark` only.
3. `overlay-app.tsx:267-269` → drop `style={{ background: SURFACE_BG }}` from the outer full-screen div. The inner pill/card at `line 271` is already responsible for its own surface, and transparency must propagate through the flex centering container.

Also audit `overlay.html:8` — `class="flint-overlay-body"` becomes a no-op once (2) lands but can stay for targeting future overlay-only CSS rules.

**O-C2. The expand/collapse animation transitions *layout properties*, not composited ones.**
`src/overlay-app.tsx:251-263`:
```ts
const containerTransition = isExpanded
  ? "width 300ms cubic-bezier(0.4, 0, 0.2, 1), height 300ms cubic-bezier(0.4, 0, 0.2, 1), border-radius 300ms cubic-bezier(0.4, 0, 0.2, 1)"
  : "width 200ms ease-in, height 200ms ease-in, border-radius 200ms ease-in";

const containerStyle: CSSProperties = {
  background: SURFACE_BG,
  border: SURFACE_BORDER,
  width: isExpanded ? EXPANDED_W : COLLAPSED_W,
  height: isExpanded ? EXPANDED_H : COLLAPSED_H,
  borderRadius: isExpanded ? 12 : 9999,
  transition: containerTransition,
  willChange: "width, height, border-radius",
};
```
Every animated property (`width`, `height`, `border-radius`) forces the browser to re-run layout and paint **every frame**. `willChange` at line 262 only hints a compositor layer for properties that can be promoted — layout properties cannot be. The two absolute-positioned inner layers (`inset-0`, lines 273-334 and 337-356) resize to match the parent on every frame, triggering secondary reflows. On a 60 Hz monitor, 300 ms × 60 = **18 full layout/paint passes per animation**. That is exactly the "not smooth" feel the user is reporting. The frame-by-frame sequence during an expand:

| Frame | Container `width` | Inner expanded layer reflow | Inner collapsed layer reflow | Paint |
|---|---|---|---|---|
| 0 | 208 | resize + reflow text | resize + reflow text | full repaint of `288×108` |
| 1–17 | interp 208→272 | same | same | same |
| 18 | 272 | final | final | final |

Add `border-radius: 9999 → 12` and the rasterizer has to re-calculate rounded-corner masks too.

**Fix:** keep the container at a **single fixed size** and animate composited properties:
- Sticky approach: set the container to `EXPANDED_W × EXPANDED_H` always, use `clip-path: inset(TRBL round <r>)` to reveal only the pill shape when collapsed, and animate `clip-path` (compositor-friendly in modern Chromium).
- Simpler approach: use two *separate* siblings for collapsed/expanded, each at its natural size, and cross-fade with `opacity + transform: translateY()`. The parent doesn't resize at all.
- Simplest approach: animate `transform: scale(…)` + `opacity`, accept that the pill's visual hit-area is the full window, and move pointer logic to `data-no-drag` regions inside the scaled container. `scale` is GPU-accelerated.

In all three, `width`/`height`/`border-radius` must leave the `transition` list entirely.

**O-C3. `setView` inside the debounce is a state-race trap.**
`src/overlay-app.tsx:53-67`:
```ts
const expand = useCallback(() => {
  if (viewRef.current === "expanded") return;
  const now = Date.now();
  if (now - lastToggleRef.current < TOGGLE_DEBOUNCE_MS) return;
  lastToggleRef.current = now;
  setView("expanded");
}, []);
```
`viewRef.current` is updated synchronously on render (line 42), but `expand`/`collapse` read the ref *before* the render produced by the previous `setView` has flushed. Rapid pointer-up → focus-change → onMoved in quick succession can bypass the guard because `viewRef.current` is still stale relative to the most recent `setView` call. The 100 ms debounce masks but does not close the race. Visible symptom: after dragging an expanded overlay, it sometimes collapses, expands again on release, then flips state one more time as the onFocusChanged handler fires with `payload = false`.

**Fix:** make the state machine fully ref-driven (use `useReducer` or a single imperative ref + forceRender) or key the debounce to `setView`'s functional updater — `setView(prev => prev === 'expanded' ? 'expanded' : 'expanded')` with the debounce inside the functional form.

### HIGH

**O-H1. Drag-guard clear timer can trigger `collapse()` mid-drag if the OS re-focuses fast.**
`src/overlay-app.tsx:115-125`. During a drag, `onMoved` runs continuously and resets a 200 ms `setTimeout` that flips `isDraggingRef.current = false`. The `onFocusChanged` handler at `line 132-136` only collapses if `!isDraggingRef.current`. If the OS fires `onFocusChanged(false)` just after the final `onMoved` (drop), the 200 ms window elapses before focus is restored → collapse fires with the pointer still logically "on" the window. Race is narrower than before but still reachable by fast pointer-ups.
**Fix:** tie `isDraggingRef` to explicit `pointerup` + `startDragging` promise resolution, not to a wall-clock timer.

**O-H2. Two separate overlay-position save paths race each other.**
`src/overlay-app.tsx:95-105` debounces a `setTimeout` that invokes `overlay_save_position`. But `onMoved` itself also calls `queueSavePosition` on every drag tick. If the user drags, releases, then immediately drags again before the 400 ms debounce fires, the first save may still be in flight when the second drag starts. `src-tauri/src/overlay.rs:125-143` takes the config mutex and rewrites the full TOML file — two concurrent writers on the same file across the Tauri runtime thread. Harmless today because Tauri commands serialize on the state mutex, but the mental model says "400 ms debounce" and the reality says "at most one save per drag, but queued saves can race the next drag". Noted for clarity.

**O-H3. Overlay opacity and position from config.toml are *completely unused*.**
`src-tauri/src/overlay.rs` — grep returns zero hits for `opacity` or `position`. The settings panel shows a working opacity slider (`settings-panel.tsx:165-184`) and a position dropdown (`settings-panel.tsx:148-163`) that write to config.toml, but `overlay.rs` never reads either field when building the window. The slider/dropdown are dead UI. PRD 7.4 lists both as required (`position`, `opacity`).
**Fix:** apply `Overlay.opacity` via `WebviewWindowBuilder::effects()` or `window.set_opacity()` where supported; honor `Overlay.position` as the snap target when `x`/`y` are unset.

**O-H4. Collapsed-layer `pointer-events: none` hides drag clicks for part of its fade.**
`src/overlay-app.tsx:337-356`. During an expand→collapse, the collapsed layer fades in over 150 ms starting at 150 ms (`opacity 150ms ease-out 150ms`). Meanwhile the expanded layer has `pointer-events: none` as soon as `isExpanded` flips false. There is a 150 ms window (the delay on the collapsed layer's opacity transition) where *neither* layer accepts pointer events. Clicks in that window are silently dropped.

**O-H5. Draggable hit-area is the whole window. The black rectangle (O-C1) is also the drag surface.**
`src/overlay-app.tsx:266-270`. `onPointerDown` is attached to the outer full-screen div. Once O-C1 is fixed and the window becomes transparent, pointer events on the transparent region will still be captured by the webview (browsers don't pass clicks through transparent pixels). The user will grab "empty space" around the pill and drag it. Either shrink the event target to the inner container, or add `pointer-events: none` to the full-screen root and `pointer-events: auto` to the inner pill.

### MEDIUM

**O-M1. Fixed `288×108` wastes ~78% of the pill's collapsed footprint.**
`overlay.rs:15-16`. Chosen to give the expanded state enough headroom without resizing the native window (historical Win32 crash). With O-C1 fixed, the wasted area becomes invisible but the drag hit-area (O-H5) still covers it. Once O-H5 lands, the unused area is harmless. Keep as-is.

**O-M2. `viewRef.current = view;` runs on every render.**
`src/overlay-app.tsx:42`. Mutating a ref during render is unusual but legal. Combined with the 1 Hz tick driving re-renders (via `useTimer`), this means the ref mutation fires every second while the overlay is mounted. Not a bug, just noise during profiling.

**O-M3. Overlay window is built once and stays in memory forever.**
`overlay.rs:18-21`. `build_overlay` short-circuits if the window exists. On hide, the window is only `.hide()`-ed, not closed. GPU memory for the webview stays allocated even when the overlay is invisible. Acceptable, but means there is no way to recover if the overlay webview crashes internally — `overlay_show` would silently succeed on a zombie handle.

### LOW

**O-L1. `dragClearTimerRef` can leak one pending timer on unmount if `window.clearTimeout` is shadowed by a broken plugin.**
`src/overlay-app.tsx:71-74`. Cleanup uses `window.clearTimeout`, which is correct in the overlay webview (not sandboxed). Noted only because an inspection of cleanup paths didn't find other leaks.

**O-L2. The overlay webview imports `index.css` wholesale.**
`src/overlay-main.tsx:4`. It loads the full app stylesheet (tab styles, settings panel rules, etc.) for a pill that uses maybe 2 kB of CSS. Not a perf issue (cached after first load) but is noisy under DevTools.

---

## 2. FREEZING & PERFORMANCE — why the app hangs during Pomodoro cycling and Alt-Tab

### CRITICAL

**P-C1. `write_recovery` is synchronous file I/O on the Tokio tick thread, on *every* state change AND every 10 ticks.**
`src-tauri/src/storage.rs:74-99`. `write_recovery` serializes the full `RecoveryFile`, calls `fs::write`, and returns. Call sites:
- `lib.rs:72` — every 10th tick (inside the lock on `EngineState`)
- `commands.rs:70` — `start_session`
- `commands.rs:96` — `pause_session`
- `commands.rs:115` — `resume_session`
- `commands.rs:209` — `mark_question` (Enter key)
- `commands.rs:309` — `next_interval` (Pomodoro transitions)
- `commands.rs:330` — `set_tags`

Each write is a synchronous Windows `CreateFile` + `WriteFile` + `CloseHandle` + fsync. On a slow disk (NVMe under load, or antivirus on access) that's 5–40 ms blocking. Because `write_recovery` runs while the `EngineState` mutex is held (all the command sites above acquire the mutex first), any blocked write blocks:
- the next tick (`lib.rs:18-21` acquires the same mutex)
- `get_timer_state` polled by the frontend
- `tray::update_tooltip` called by the tick loop
- the overlay's `useTimer` event round-trip

Alt-Tab behavior: Windows often suspends background webviews' animation/raf. When the overlay comes back to foreground, React flushes all queued state updates. If a tick happened during the suspension and `write_recovery` was mid-fsync, the mutex is held and the whole queue stalls until the write returns. Symptom: UI freezes for hundreds of milliseconds every few seconds.

Pomodoro cycling: `next_interval` writes recovery *while holding the mutex* and *immediately* before emitting `interval:start`. The Pomodoro plugin's `interval:end` handler is an async chain that `await flint.nextInterval()` → invokes `next_interval` → blocks on recovery write → pauseSession → **another** recovery write. Two serial fsyncs per transition on a hot path.

**Fix:** move recovery writes off the engine mutex and off the tick thread entirely. Two options:
1. Debounced writer task: enqueue a snapshot, let a dedicated Tokio task serialize + fs::write outside the lock. Lose at most one snapshot on crash — acceptable because the previous audit already verified recovery uses `last_saved_at` (B-C1 is closed).
2. Use `tokio::fs::write` from inside a `tauri::async_runtime::spawn` so the tick thread is never blocked.

Either way, release the mutex **before** touching the disk.

**P-C2. Main-window `useTimer` re-renders the *entire* `AppShell` tree every second.**
`src/hooks/use-timer.ts:57-73`. `session:tick` calls `setState((prev) => ({ ...prev, elapsed_sec, current_interval: { ... } }))` which replaces the `state` object every second. Every consumer of `state` re-renders:
- `AppShell` (`App.tsx:18` `const { state, intervalRemaining } = useTimer();`) — the keyboard effect is now ref-stabilized, but the JSX under `<TimerDisplay state={state} intervalRemaining={intervalRemaining} … />` reconciles every tick.
- `TimerDisplay` (`timer-display.tsx:21`) — renders the full digit string, progress bar, kbd hints.
- `StatusBar` (`status-bar.tsx:11`) — renders mode/status/questions/elapsed.

The overlay has its **own** `useTimer` in `overlay-app.tsx:35` that also re-renders every second. Both windows reconcile. Combined with `dispatchEvent` from Tauri's event bridge, the single-second tick does a round-trip through:
1. Rust `app.emit("session:tick", ...)` (`lib.rs:50-58`)
2. IPC JSON-serializes the payload and delivers it to each webview
3. Each webview's `useTimer.setState` fires
4. React batches and reconciles

P-H2 from the first audit called out this exact pattern; it is still unfixed. For the current complaints (freezing / lag), this is a contributing factor: whenever `write_recovery` blocks the tick thread, the emit is delayed, the next tick stacks behind it, the webview sees two ticks in quick succession, and React reconciles twice back-to-back.

**Fix:** split the tick values into a dedicated atom (or a `useSyncExternalStore`) so only the `00:00` text and the progress bar width update on a tick. Metadata like `mode`, `tags`, `questions_done` should live in a separate state container that only updates on lifecycle events.

### HIGH

**P-H1. `tray::update_tooltip` re-locks `EngineState` and `ConfigState` every tick.**
`src-tauri/src/lib.rs:78` calls `tray::update_tooltip(app)` after dropping the engine lock. `tray.rs:176-208` then re-acquires **both** `EngineState` and `ConfigState`. That's 2 extra locks per second. Under contention with a blocked `write_recovery` (P-C1), the tray update is one more caller queued behind the disk I/O — each second contributes 3 serial mutex acquisitions on `EngineState`. This is P-M3 from the first audit; the underlying pattern has not been restructured.

**P-H2. Notifications state isn't cleared when `PluginHost.tearDown()` runs.**
`src/components/plugin-host.tsx:233-248`. `tearDown` clears `notifyTimersRef` and `notifyDedupRef`, but it does **not** call `setNotifications([])`. If a notification is on screen when plugins reload (e.g. user toggles a plugin mid-Pomodoro break), the pending auto-dismiss `setTimeout` is cancelled at line 244 — but the notification remains in React state forever because the `setNotifications((prev) => prev.filter(...))` closure at line 218 never fires. Orphan toasts accumulate and cover the UI. No error, no obvious symptom during normal use, but very hard to dismiss after the first few.
**Fix:** add `setNotifications([])` to `tearDown`.

**P-H3. `PluginConfigForm` `save()` fires on every keystroke in a number input.**
`src/components/plugin-settings.tsx:189-204`. `onChange` on the `<input type="number">` calls `onChange(raw)` → `save(key, value)` → `invoke("set_plugin_config", …)` → backend writes the full `config.toml`. Typing `25` produces: `set_plugin_config` with `2` (toml write), then `set_plugin_config` with `25` (toml write). Typing `250` produces 3 invocations and 3 full-file writes. Each write also triggers `onConfigPersisted → resyncFromBackend → setDraft(fresh)` in the parent `SettingsPanel` — **and** rebuilds the tray menu in `commands.rs:398` (via `set_plugin_enabled` path? no — via `set_plugin_config` path, which does not rebuild tray; good). But the full round-trip still blocks the UI thread for the duration of each write.

Pomodoro interaction: while the user is adjusting `focus_min` from `25` to `50`, five serial toml writes go out, each takes the config mutex, each blocks any concurrent `get_config` poll. The rapidly changing `initial` prop also cascades into the B-M6 race (see Q-H3 below).

**Fix:** debounce `save` per-field (300–500 ms idle), or commit on blur / explicit "Save" button.

**P-H4. `session:tick` event handlers in `useTimer` live on *every* window.**
`src/hooks/use-timer.ts:58-73` and `src/overlay-app.tsx:35`. Two independent `listen('session:tick', …)` subscriptions — one per webview. Each tick round-trips Rust → main webview → React, and Rust → overlay webview → React. When the overlay is hidden (`window.hide()`), Tauri still delivers the event to the webview and React still reconciles, because `hide()` does not detach listeners. Wasted work ~30% of the time the overlay is bundled with main.

**Fix:** when the overlay is hidden, `unlisten` the `session:tick` subscription via a visibility-gated effect, and re-subscribe on show.

**P-H5. Stats Dashboard reloads 5 backend queries on every sidebar tab switch.**
`src/components/stats-dashboard.tsx:36-58`. `<StatsDashboard />` at `src/components/sidebar.tsx:139` is conditionally mounted — clicking Stats → Session Log → Stats triggers a full unmount/remount, and `useEffect(() => { load(); }, [load])` fires five parallel `invoke(...)` calls each time. `stats_range` and `stats_lifetime` each read every completed session (`cache.rs:488-571`, `cache.rs:588-604` + lifetime_totals). At 1k sessions this is cheap; at 10k it begins to feel like tab lag.

**Fix:** hoist stats state above the sidebar conditional mount so re-selecting the tab does not re-query; or cache the `load` result in a module-level ref with a 30 s TTL.

### MEDIUM

**P-M1. `finalize_session` has a non-atomic write + disposable cache upsert.**
`src-tauri/src/commands.rs:124-177`. `write_session_file` (`storage.rs:205-207`) uses `fs::write` directly — no `.tmp` + atomic rename. If the process is killed mid-write (power loss, force-quit), a partial JSON lands in `~/.flint/sessions/` and the next cache rebuild sees broken JSON. On the cache side (line 146), `cache::upsert_from_file` failure is logged via `eprintln!` and swallowed — the session exists on disk but not in the cache. This is B-H3 from the previous audit; still unfixed.

**P-M2. `cache.rs:528` parses tags from a SQLite TEXT column per row with `serde_json::from_str(&tags_raw).unwrap_or_default()`.**
For each session in a range scan, the tags JSON is deserialized into a `Vec<String>`. Hot path for `stats_range` under both "week" and "month" views. At 10k rows this is observable latency on the stats tab. Not a freeze, but it compounds with P-H5.

**P-M3. `list_sessions` (plugin API `flint.getSessions`) issues one extra query per session.**
`src-tauri/src/commands.rs:558-574`. Top-level `list_sessions` → `cache::list_sessions` → `N+1` `get_session_detail` calls to assemble full payloads. For a plugin calling `flint.getSessions({ limit: 100 })`, that's 101 SQL queries. The plugin API filter (`plugin-api.ts:66-87`) then runs the limit client-side *after* fetching everything — so the backend always pays for the full history.

**P-M4. `tearDown` clears subscribers and timers, but the React `notifications` state is still re-rendered on the next `setNotifications` call.**
See P-H2. Side note: React will warn "Can't perform a state update on an unmounted component" if the plugin-host is mid-reload when a late event fires its callback. The `useCallback(dispatchEvent, [])` at `plugin-host.tsx:92-112` does not track mount status.

**P-M5. Recharts is still in the bundle.**
`package.json:18` still has `recharts`. Cold-load of `<StatsDashboard />` imports and initializes Recharts on first click. ~250 kB of JS parse + init on the main thread. Noticeable pause on slow machines. P-M1 from the original audit.

**P-M6. Stats / session-log plugins broadcast refresh via `window.dispatchEvent` but the sandbox kills `window`.**
See S-C3 below — this is both a security finding and a perf finding: the refresh never arrives, so the dashboard only updates when you re-open the tab (P-H5 makes that reload expensive). Two independent defects compounding.

### LOW

**P-L1. Sidebar resize uses CSS `width` transition (`sidebar.tsx:111-112`).**
Transitioning `width: 200ms ease-out` reflows the entire main area for 200 ms on every show/hide. Transform-based slide (`translateX(-100%)` on the sidebar, fixed main-area `padding-left`) would be smoother. Low priority — sidebar toggle is an occasional action.

**P-L2. `update_tooltip` does `format!` string allocation per tick.**
`src-tauri/src/tray.rs:192-206`. 1 Hz, small strings — negligible, noted for completeness.

**P-L3. `StatsHeatmap.build` rebuilds `byDate: Map` + column layout on every render.**
`src/components/stats-heatmap.tsx:17` uses `useMemo([cells])`, which is correct — only rebuilds when `cells` changes. But `cells` reference changes on every `load()` call in `StatsDashboard`. Together with P-H5, this is a second cold path on tab switch.

---

## 3. VISUAL GLITCHES — hardcoded colors, z-index, layout thrash

### HIGH

**V-H1. Hardcoded hex colors in Recharts and Heatmap.**
- `src/components/stats-dashboard.tsx:24-25` — `const ACCENT = "#16a34a"; const MUTED = "#555555";`
- `src/components/stats-dashboard.tsx:312-344` — `stroke="#333333"`, `stroke="#555555"`, `cursor={{ fill: "#2d2d2d" }}`, `background: "#1e1e1e"`, etc. eight hardcoded hexes in a single Tooltip block.
- `src/components/stats-heatmap.tsx:44` — `fill="#555555"`.
- `src/components/stats-heatmap.tsx:139-145` — `"#2d2d2d"`, `"#16a34a40"`, `"#16a34a70"`, `"#16a34aa0"`, `"#16a34a"`.
- `src/components/stats-heatmap.tsx:148` — `levels` array duplicates the same hex literals.

D-M1/D-M2 from the original audit, unfixed. `--accent` was changed from `#4a9eff` to `#16a34a` globally in `index.css:13`, but Recharts / heatmap literals were not updated — so they incidentally match *today*. Any future `--accent` change silently drifts. Also: the "subtle ramp" values (`16a34a40 / 70 / a0`) are alpha-suffixed hex strings, which Recharts accepts but CSS vars don't support. Use `color-mix(in srgb, var(--accent) 25%, transparent)` or an explicit `--accent-*` ramp.

**V-H2. `status-bar.tsx` renders plugin HTML via `dangerouslySetInnerHTML` — both an XSS sink AND a layout-glitch vector.**
`src/components/status-bar.tsx:40`. The plugin's `flint.renderSlot(slot, html)` body is injected raw. Security implications in §6. Visual implication: a plugin that renders unclosed tags or unexpected display types can break the flex row's alignment on the status bar. There is no style sandboxing.

**V-H3. The overlay progress bar animates `width` every tick.**
`src/overlay-app.tsx:296-302`. `transition-[width] duration-200 ease-out` on an element whose width is updated once per second by the 1 Hz tick. Every interval tick runs a 200 ms layout-thrash transition on a bar inside the animated container. Combined with O-C2, the main container animation and the inner bar animation overlap during expand/collapse. Under CPU load, this is what the user reports as "visual glitch". D-L8 from the first audit.

**V-H4. Timer-display progress bar uses the same `transition-[width]` pattern.**
`src/components/timer-display.tsx:99-103`. Same issue, main window. Reflows the `w-72` track every second.

### MEDIUM

**V-M1. `index.css` ::selection color uses `--accent-subtle` which is an alpha hex.**
`src/index.css:60-63` → `background-color: var(--accent-subtle)`. `--accent-subtle` is `#16a34a22`. Firefox renders selection backgrounds with a blend mode, so on dark text the selection is barely visible. Cosmetic.

**V-M2. Sidebar width animation introduces a 200 ms reflow whenever visibility toggles.**
`src/components/sidebar.tsx:104-113`. Transitioning `width` AND `border-right-width` AND the sidebar contents resize together. Visible stutter when `aria-hidden` flips and the timer display re-measures itself.

**V-M3. `tabular-nums` is set on the timer digits but parent flex centering re-measures every second.**
`src/components/timer-display.tsx:83`. `font-mono text-[96px] leading-none tracking-tight tabular-nums` — tabular-nums is correct to prevent digit jitter, but the parent flex `items-center justify-center` still recalculates baseline/centering every time the string changes (which is every second). No obvious symptom until paired with O-C2.

**V-M4. Notification plugin label shown for built-in plugins.**
`src/components/notifications.tsx:15-17`. D-M6 from the first audit. "POMODORO" label above "Focus done. Break time." looks shouty.

**V-M5. `Stats` heatmap legend literal hex list is *out-of-sync* with `cellColor`.**
`src/components/stats-heatmap.tsx:148`. `const levels = ["#2d2d2d", "#16a34a40", …]`. The `cellColor` function at line 139 returns the same values. If the ramp ever changes, both must be edited in lockstep. Extract a constant.

### LOW

**V-L1. Tag input still commits on blur.**
`src/components/tag-input.tsx:49`. `onBlur={commit}`. B-M2 unfixed. Clicking the gear icon while the tag input is open silently applies whatever draft tags the user had. A button press outside the input (e.g. sidebar tab) also commits.

**V-L2. Stop confirm bar has a subtle `/85` alpha + `backdrop-blur-sm`.**
`src/components/timer-display.tsx:193`. Decorative backdrop blur inside the main window, which violates PRD 7.7 ("No shadows (except overlay …)"; backdrop-blur is in the same spirit). Remove or reduce.

**V-L3. `TopBar` toggle button still uses unlabeled glyphs `⟨` / `⟩`.**
`src/App.tsx:466`. D-L1 from first audit, unfixed.

**V-L4. Toggle switches are duplicated.**
`src/components/settings-panel.tsx:305-335` (`Toggle`) and `src/components/plugin-settings.tsx:243-268` (`ToggleSwitch`). Q-M4 from first audit, unfixed.

**V-L5. Tag pills still have no `×` affordance.**
`src/components/timer-display.tsx:116-123`. D-L3 from first audit, unfixed.

---

## 4. PLUGIN SYSTEM STABILITY — the big one

### CRITICAL

**S-C1. `window.dispatchEvent` in built-in plugins throws silently — stats dashboard and session log never auto-refresh.**
`src-tauri/plugins/session-log/index.js:6,12` and `src-tauri/plugins/stats/index.js:6` both do:
```js
window.dispatchEvent(new CustomEvent("flint:stats:refresh", { detail: payload }));
```
`src/lib/plugin-sandbox.ts:13-37` shadows **`window`** to `undefined` by passing it as a parameter with an `undefined` argument. Inside the sandbox function, the bare identifier `window` resolves to the shadow, so `window.dispatchEvent(...)` → `TypeError: Cannot read properties of undefined (reading 'dispatchEvent')`. The error is caught by `plugin-host.tsx:107-109` and `console.error`'d — no user-visible indication.

Resulting behavior: when a Pomodoro interval finishes and writes a session file, the stats plugin's `session:complete` handler *runs* but *fails* on line 6. No `flint:stats:refresh` event reaches `StatsDashboard`. The dashboard only updates the next time the user switches to the Stats tab (which remounts the component and triggers `load()` via `useEffect`). Same for Session Log. The built-in plugins that *shipped* with the sandbox fix are now **broken by it**.

**Fix path:** extend the sandbox API surface so plugins can signal the UI without reaching `window`. Two options:
1. Expose `flint.emit(topic: string, payload?: unknown)` in `plugin-api.ts`. Route it through `subscribersRef` using a synthetic `plugin:${topic}` event, and have `StatsDashboard` / `SessionLog` subscribe via a `useFlintEvent('plugin:stats:refresh', handler)` hook. No DOM events involved.
2. Allow a whitelisted `flintWindow` proxy that forwards `dispatchEvent`/`addEventListener` to the real `window` but blocks everything else. This preserves the existing plugin code verbatim.

Option 1 is cleaner and is the only one consistent with the "plugins have no DOM access" constraint.

**S-C2. A plugin can XSS the main webview via `flint.renderSlot`.**
`src/components/status-bar.tsx:40`:
```tsx
<span
  key={entry.pluginId}
  className="text-[var(--text-secondary)]"
  title={entry.pluginId}
  dangerouslySetInnerHTML={{ __html: entry.html }}
/>
```
A plugin that calls `flint.renderSlot("status-bar", '<img src=x onerror="[...]">')` injects an `<img>` whose `onerror` handler runs in the **main webview's** global context (not the sandbox). The payload has unrestricted access to `window`, `__TAURI_INTERNALS__`, `invoke(...)`, etc. — all the things S-C1 from the original audit was intended to block. The sandbox only covers the plugin's top-level execution, not the HTML it hands to the host.

This is a sandbox escape. Any community plugin is now effectively a remote-code-execution primitive on the user's machine.

**Fix:** parse the plugin HTML through `DOMPurify` (or equivalent) before injection; or render slot content as plain text; or accept only a structured descriptor (`{kind: 'icon' | 'text', value: string}`) and let Flint render primitives.

Search for other `dangerouslySetInnerHTML` sites — there are none in the repo today, but if any other plugin slot (`sidebar-tab`, `settings`, `post-session`) eventually renders via the same pattern, inherit the same bug.

**S-C3. `quit_app` (Ctrl+Q) exits without finalizing a running session.**
`src-tauri/src/commands.rs:711-719`:
```rust
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    crate::overlay::close_overlay_if_open(&app);
    app.exit(0);
}
```
B-H2 was fixed for `tray::quit_from_tray` (`tray.rs:221-246` now calls `finalize_session`) but the matching `quit_app` command — bound to Ctrl+Q in `App.tsx:262-268` — still skips it. Press Ctrl+Q during a focus block → session is not written to `~/.flint/sessions/`, `recovery.json` remains, and next launch resumes with a *possibly* correct (B-C1 is fixed) but *unintended* state.
**Fix:** `quit_app` must do the same `finalize_session(..., completed=false)` dance that `quit_from_tray` does.

### HIGH

**S-H1. `plugin_storage_key_path` accepts Windows-reserved characters.**
`src-tauri/src/commands.rs:518-526`. Still only rejects `/`, `\`, `..`, and empty strings. A plugin calling `flint.storage.set("CON", …)`, `.set("a:b", …)`, or `.set("file*", …)` passes validation, then `fs::write` fails with a Windows-specific error. B-M8/S-H2 from the first audit, unfixed.
**Fix:** reject anything not matching `^[A-Za-z0-9_.-]+$`, and reject the reserved DOS device names (`CON`, `PRN`, `AUX`, `NUL`, `COM0–9`, `LPT0–9`) case-insensitive.

**S-H2. `plugin_storage_get` reads files with no size cap.**
`src-tauri/src/commands.rs:528-536`. A plugin that has previously stored a multi-GB value can OOM the Tauri backend on the next `flint.storage.get(key)`. Even without malicious intent, a runaway accumulator plugin can reach there. S-M3 from first audit, unfixed.

**S-H3. Plugin manifest `config_schema: HashMap` has non-deterministic render order.**
`src-tauri/src/plugins.rs:38`. `HashMap<String, ConfigSchemaField>` → settings UI renders `focus_min` / `break_min` / `long_break_min` in hash order, which varies per run. Q-L10 from first audit, unfixed.
**Fix:** use `indexmap::IndexMap` (preserves insertion order from the manifest JSON).

**S-H4. Plugin subscribe callbacks never get detached on plugin disable without a full reload.**
`src/components/plugin-host.tsx:283-289`. `setPluginEnabled` calls `reload()`, which `tearDown()`s all subscribers and rebuilds from scratch. For a 5-plugin runtime that's acceptable; at 20+ plugins it becomes a visible pause. P-L3 from first audit.

**S-H5. `finalize_session` session-file write is non-atomic — partial JSON files can land on disk.**
See P-M1. The cache rebuild path then sees a broken file, logs `eprintln!`, and moves on; the session is forever invisible in the Session Log. B-H3 from first audit, unfixed.

### MEDIUM

**S-M1. Sandbox self-test runs at module load with a partially-constructed DOM.**
`src/lib/plugin-sandbox.ts:54-80`. `selfTest()` executes at module import time (`src/overlay-main.tsx:4` imports `index.css`, which imports nothing; but `src/main.tsx` imports `./App` which imports `./components/plugin-host` which imports `./lib/plugin-sandbox` at ES-module evaluation time). The self-test runs even in the overlay webview, where plugins never load — benign but unnecessary. More importantly, a dev who disables the sandbox temporarily and forgets to re-enable it gets only `console.error`, no UI surfacing.

**S-M2. `tearDown` vs. notification state leak.**
See P-H2 — duplicated here because the root cause is plugin-host lifecycle.

**S-M3. `PluginHost.reload` has no lock against re-entry.**
`src/components/plugin-host.tsx:250-281`. A rapid `setPluginEnabled(a) → setPluginEnabled(b)` while reload is mid-flight can interleave `tearDown` and the next `runInSandbox` call. Currently hidden by React batching, but fragile.

**S-M4. `plugin_storage_get` doesn't size-cap the returned JSON either.**
`commands.rs:534` passes the whole file through `serde_json::from_str`. A crafted 500 MB JSON payload OOMs the backend even if the raw file size cap (S-H2) is added.

**S-M5. `rebuild_menu` is called from `set_plugin_enabled` (`commands.rs:398`) without retry on failure.**
If the tray menu rebuild fails (e.g. during shutdown), `eprintln!` → the plugin's enabled state is persisted, but the tray's "Start X / Start Y" entries drift out of sync. No visible UI error.

### LOW

**S-L1. Countdown plugin hardcodes `console.error`.**
`src-tauri/plugins/countdown/index.js:15`. `console` isn't in `SHADOWED_GLOBALS`, so this resolves to the real console — works, but makes the sandbox boundary hazy.

**S-L2. Pomodoro plugin calls `flint.pauseSession()` after `flint.nextInterval()`, causing a visible 1–2 tick flicker.**
`src-tauri/plugins/pomodoro/index.js:13-16`. Same B-L2 race. Cosmetic.

**S-L3. `plugin_storage_dir` validates the plugin ID with a weaker regex than `plugin_storage_key_path`.**
`src-tauri/src/commands.rs:502-516`. Allows `id = "some.name"` but blocks `../`. A plugin with a `.` in its ID creates a directory with that name, which breaks glob assumptions elsewhere.

---

## 5. CRASH VECTORS — unwrap, panic, shutdown ordering

### HIGH

**C-H1. `quit_app` has no `finalize_session`, so the recovery file lingers across a keyboard quit.**
See S-C3. Crash-like symptom for the user: "my session just vanished".

**C-H2. `close_overlay_if_open` is called from 3 code paths; only 2 are race-safe.**
- `tray.rs:244` — called before `app.exit(0)` in `quit_from_tray`. Safe.
- `commands.rs:717` — called before `app.exit(0)` in `quit_app`. Safe.
- `lib.rs:289` — called on `CloseRequested` event when `close_to_tray = false`. Safe.

However, none of them handle the case where the overlay is being *built* when close is requested. `build_overlay` (`overlay.rs:18`) is not awaited in a way that the Close handler can cancel. If the user toggles overlay on then hits Ctrl+Q within ~50 ms, the overlay build is still in flight when `close_overlay_if_open` runs. `get_webview_window(OVERLAY_LABEL)` returns `None`, the build completes a moment later, `app.exit(0)` then races with the newborn window — exactly the `Chrome_WidgetWin_0 unregister` crash the comments claim to prevent.

**C-H3. `fs::canonicalize` on `path.join(&manifest.entry)` in `plugins.rs:154-177` rejects non-existent paths.**
If a community plugin has a manifest but the `entry` file is deleted by the user after installation, `fs::canonicalize` errors out, the plugin is silently dropped, and the user's "enabled" state in config.toml drifts. No way to re-enable through the UI.

### MEDIUM

**C-M1. `unwrap()` on `state.session_id.clone().unwrap()` in `storage.rs:79`.**
`write_recovery` is called from the tick loop at `lib.rs:72` inside the mutex. The guard at `storage.rs:75` (`if state.status == TimerStatus::Idle || state.session_id.is_none() { return Ok(()); }`) prevents the unwrap from firing in practice, but the implicit coupling is not enforced at the type level. Document the invariant or use `let session_id = state.session_id.clone().ok_or(...)?;`.

**C-M2. Many `NaiveDate::from_ymd_opt(...).unwrap()` and `.and_hms_opt(0,0,0).unwrap()` in `cache.rs`.**
`cache.rs:419-423, 610, 613, 692-710`. All are statically safe (hardcoded `0,0,0` times and valid date math), but `.expect("start of day exists")` would document the invariant. Q-M1 from first audit.

**C-M3. `.unwrap_or_default()` on `serde_json::from_str(&tags_raw)` in `cache.rs:528`.**
A corrupted tags column returns an empty `Vec<String>` silently. Tags data loss is invisible to the user. Log a warning at minimum.

**C-M4. `fs::write` in `storage.rs:97` is non-atomic.**
Killing the process mid-recovery-write corrupts `recovery.json`. The next launch hits `load_recovery` → `rename_broken` → user loses the session. Protection exists at read time but not write time. Use tmp + rename.

**C-M5. `eprintln!` everywhere.**
`lib.rs:73,214,246,263,267`, `storage.rs:118,138,146`, `plugins.rs:99,112,133,140,157,169,178,189,208`, `cache.rs`, `commands.rs:137,146,147,399`, `overlay.rs`. Errors go to a console the packaged app never shows. No log file in `~/.flint/`. B-L1 from first audit.

### LOW

**C-L1. `PluginHost` tearDown can be called on unmount while `reload` is in flight.**
`src/components/plugin-host.tsx:291-297`. The effect's cleanup calls `tearDown()`, which clears `subscribersRef`. If the in-flight `ensureListener` promise resolves after unmount, the `realUnlisten` returned by `listen(...)` is stored in `unlistenersRef.current`, which is now orphaned (subscribersRef is empty but the listener is still live). Dev-only because production never unmounts the root host.

**C-L2. No guard on `config.toml` round-trip when the user hand-edits bad values.**
`config.rs` (Q-M6 from first audit) — `pomodoro.focus_min = 0` still valid after parse, interval ends instantly, Pomodoro plugin cycles forever. Not a crash, but a livelock.

**C-L3. Shared mutable state in `lib.rs:320-325` tick loop has no shutdown signal.**
The infinite `loop { ticker.tick().await; tick_once(&handle); }` never exits. On `app.exit(0)`, the Tokio runtime is torn down mid-tick. Any tick that was already past the mutex lock completes, but any Rust panic in `tick_once` triggers an abort. Not observable today because the tick body is panic-safe, but there is no clean shutdown path.

---

## 6. PRD COMPLIANCE — deviations and regressions since commit 62dc4c8

### HIGH

**PR-H1. PRD 7.4 requires overlay `transparent: true`.**
> "Tauri `WebviewWindow::new()` with `always_on_top: true`, `decorations: false`, `transparent: true`"

`src-tauri/src/overlay.rs:39` sets `.transparent(false)`. This is **directly contradicting the PRD** and is the root cause of the user's "visible black rectangle" complaint. See O-C1.

**PR-H2. PRD 7.6 "Keybindings — configurable" still unimplemented.**
`src/components/settings-panel.tsx:209-229` renders a read-only table with the comment "Rebinding UI for the rest lands in a later phase — edit config.toml directly for now." Original audit's Q-M4-style deferral; not resolved.

**PR-H3. PRD 7.6 "Data" section missing "Open data folder" and "Export all sessions".**
`src/components/settings-panel.tsx:233-236`. Only `ReadOnlyRow` for the directory and `RebuildCacheRow` are present.

**PR-H4. PRD 8.3 "Tab cycles between sidebar ↔ main area" not implemented.**
`src/App.tsx:237-371`. No Tab-key handling at all.

**PR-H5. PRD 8.3 "arrow keys navigate session list" not implemented.**
`src/components/session-log.tsx`. Session list is rendered as a flat `<ul>` of `<button>` elements with no roving-tabindex / keyboard nav. Focus order is DOM order only, which does the right thing for tab but not for arrow-keys.

### MEDIUM

**PR-M1. Overlay opacity and position config fields are dead.**
See O-H3. PRD 7.4 mentions "Position saved in config.toml → [overlay] position" — the field is saved but never read. The opacity slider in Settings is similarly disconnected.

**PR-M2. Plugin `activate()` lifecycle still not invoked.**
`src/components/plugin-host.tsx:272`. PRD 6.3 step 4: "call plugin's `activate()` function". Current implementation runs the plugin source as a raw function body with top-level side effects. Q-L5 from first audit. Built-in plugins happen to fit this pattern; community plugins that export `activate()` will silently do nothing.

**PR-M3. Plugin `events` field in manifest is not consulted.**
`src-tauri/src/plugins.rs:34`. Manifest declares `events: []` but plugins subscribe dynamically via `flint.on(...)` regardless. Harmless, but the declared events list could at least warn on unknown subscriptions.

**PR-M4. `status-bar` plugin slot technically works but renders via `dangerouslySetInnerHTML`.**
See S-C2. PRD 7.1 lists `status-bar` as a required slot. The slot exists, but the rendering mechanism is unsafe.

**PR-M5. PRD 7.5 `Start Pomodoro / Start Stopwatch / Start Countdown (quick-start with last tags)` — tray sends mode only, not tags.**
`src-tauri/src/tray.rs:147-150`. Payload is `{ mode }`. `src/App.tsx:129-141` then starts with `stagedTags` (whatever is currently staged in the frontend), not the *last-used* tags from the most recent completed session. PRD phrasing is ambiguous; flagging.

**PR-M6. PRD "NO DECORATIVE ANIMATIONS" — backdrop-blur on the stop-confirm toast.**
`src/components/timer-display.tsx:193`. `backdrop-blur-sm` is a decorative effect inside the main window (not the overlay). PRD 7.7 confines the "subtle shadow" exception to the overlay. V-L2.

### LOW

**PR-L1. PRD 4.4 config.toml uses `default_mode`; code uses `default_mode` too. ✓**
Just confirming.

**PR-L2. PRD 5.4 tick loop writes `recovery.json` "every 10 seconds"; code writes every 10 ticks.**
`src-tauri/src/lib.rs:71` — `if state.elapsed_sec % 10 == 0`. If the timer runs continuously, this equals wall-clock 10 s. If the user pauses/resumes across a 10-tick boundary, `elapsed_sec` only advances while running, so the 10 s cadence is *session-time* not wall-clock. Matches the intent, but documentation mismatch.

**PR-L3. PRD 11 mentions `npm run lint`; `package.json` has no lint script.**
Q-M5 from first audit.

---

## 7. Quick triage summary — against the four active complaints

### Complaint 1: "visible black rectangle around the pill"
**Root cause:** PR-H1 / O-C1 — `.transparent(false)` + body/root background fill + outer div background fill. Three coordinated edits, zero behavioral risk.
**Supporting:** O-H5 will become visible immediately after O-C1 lands (the now-invisible drag area catches clicks on empty desktop).

### Complaint 2: "app freezing / not responding during Pomodoro cycling and Alt-Tab"
**Root cause #1:** P-C1 — synchronous `write_recovery` under the engine mutex, amplified during Pomodoro transitions (two writes per transition) and when Windows re-schedules the suspended overlay webview on Alt-Tab.
**Root cause #2:** P-C2 — every tick reconciles the full `AppShell` tree in both webviews via a replaced `state` object. Stacks behind disk I/O stalls.
**Supporting:** P-H1 (tray lock per tick), P-H3 (plugin settings write on every keystroke), P-H4 (tick listener never detached when overlay hidden), P-H5 (stats dashboard remount-reload on tab switch).

### Complaint 3: "general visual glitches and lag"
**Root cause:** V-H1 (Recharts hardcoded hexes), V-H3/V-H4 (progress-bar `transition-[width]` running every tick), V-M2 (sidebar `width` transition on toggle), P-C2 (full tree reconcile).

### Complaint 4: "overlay expand/collapse animation still not smooth"
**Root cause:** O-C2 — transitioning `width`, `height`, `border-radius` instead of `transform`/`opacity`. 18 full layout/paint passes per animation. Fix requires rewriting the animation strategy (clip-path or sibling cross-fade or scale transform) and removing the layout properties from the `transition` list.
**Supporting:** O-C3 (state-race + debounce), O-H1 (drag-guard timer race), O-H4 (150 ms dead zone during cross-fade).

---

### Must-fix before shipping another iteration
- **O-C1 + PR-H1** (overlay transparency — 3-line fix)
- **O-C2** (animation rewrite)
- **P-C1** (move `write_recovery` off the mutex & tick thread)
- **P-C2** (split timer tick state from timer metadata state)
- **S-C1** (built-in plugins broken by sandbox — plugins do not auto-refresh stats/session log)
- **S-C2** (XSS via `dangerouslySetInnerHTML` in status-bar slot)
- **S-C3** (Ctrl+Q quit_app leaks session)

### Should-fix this phase
- **O-H3** (wire up `overlay.opacity` / `overlay.position`)
- **O-H5** (drag hit area)
- **P-H2** (notifications leaked across reload)
- **P-H3** (plugin number input debounce)
- **P-H4** (unlisten overlay tick when hidden)
- **V-H1** (Recharts/heatmap CSS var migration)
- **S-H1 / S-H2** (plugin storage validation + size cap)
- **S-H3** (IndexMap for `config_schema`)
- **C-H1** (dedup with S-C3)
- **PR-H2/3/4/5** (keybinding UI, Open data folder, Export sessions, Tab/arrow nav)

### Nice-to-have
- All remaining MEDIUM/LOW findings.

### New tests worth writing before the next audit
- `tick_once` while `write_recovery` is mocked to block for 50 ms — confirm the tick doesn't stack.
- Plugin sandbox test: a plugin that calls `window.dispatchEvent(...)` is detected as broken rather than silently swallowed.
- `quit_app` with a running session — session file should exist in `~/.flint/sessions/` after exit.
- `finalize_session` with `fs::write` returning `ErrorKind::PermissionDenied` — recovery file must still exist.
- `overlay-app` with O-C1 lands: snapshot test that the outer container has `background: transparent`.

---

*End of AUDIT_V2.md — no code modifications performed. Findings indexed so individual fixes can be proposed as separate PRs.*
