import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  useMetaState,
  useTickState,
  refreshTimerState,
  type MetaState,
  type TickState,
} from "./hooks/use-timer";
import { formatTime } from "./lib/format";
import { fallbackModeLabel, type Config } from "./lib/types";

interface OverlayConfigPayload {
  enabled: boolean;
  position: string;
  opacity: number;
  x?: number | null;
  y?: number | null;
  always_visible: boolean;
}

type View = "collapsed" | "expanded";

// Inner-container dimensions. The Tauri window itself is fixed at WINDOW_W/H
// in overlay.rs and never resizes. The inner container is ALWAYS at the
// expanded size — collapsed/expanded morphs via clip-path so the GPU
// composites the transition with zero layout passes (O-C2).
const COLLAPSED_W = 208;
const COLLAPSED_H = 36;
const EXPANDED_W = 272;
const EXPANDED_H = 92;

// Insets to clip-path the expanded box down to the pill silhouette. Half
// the width/height delta on each side so the pill is centered inside the
// expanded rectangle.
const COLLAPSED_INSET_X = (EXPANDED_W - COLLAPSED_W) / 2;
const COLLAPSED_INSET_Y = (EXPANDED_H - COLLAPSED_H) / 2;
const COLLAPSED_CLIP = `inset(${COLLAPSED_INSET_Y}px ${COLLAPSED_INSET_X}px round 9999px)`;
const EXPANDED_CLIP = "inset(0px 0px round 12px)";

const EXPAND_TRANSITION = "clip-path 300ms cubic-bezier(0.4, 0, 0.2, 1)";
const COLLAPSE_TRANSITION = "clip-path 200ms ease-in";

const SURFACE_BG = "#1a1a1a";
const SURFACE_BORDER = "1px solid rgba(255, 255, 255, 0.08)";

// Smallest gap between consecutive expand/collapse toggles. Without this,
// rapid click-spamming the pill stacks overlapping CSS transitions and the
// clip-path visibly stutters.
const TOGGLE_DEBOUNCE_MS = 100;

export function OverlayApp() {
  const meta = useMetaState();
  // P-H4: gate the session:tick subscription on overlay visibility so a
  // hidden overlay does not pay React reconciliation cost for ticks it
  // cannot display.
  const [visible, setVisible] = useState(true);
  const tick = useTickState(visible);

  // O-H3: surface opacity comes from config.overlay.opacity — read from
  // the backend on mount and live-updated via the `overlay:config` event
  // emitted by `update_config`. Starts at 1.0 so a miss-fire just leaves
  // the overlay fully opaque instead of invisible.
  const [surfaceOpacity, setSurfaceOpacity] = useState(1);
  useEffect(() => {
    let cancelled = false;
    invoke<Config>("get_config")
      .then((cfg) => {
        if (!cancelled) setSurfaceOpacity(cfg.overlay.opacity);
      })
      .catch(() => {});
    let unlisten: UnlistenFn | null = null;
    listen<OverlayConfigPayload>("overlay:config", (evt) => {
      setSurfaceOpacity(evt.payload.opacity);
    })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    listen<boolean>("overlay:visibility", (evt) => {
      const next = evt.payload === true;
      setVisible(next);
      if (next) {
        // Pull a fresh snapshot — meta events fire reliably but a session
        // boundary that crossed a hidden window can leave local state stale.
        refreshTimerState().catch(() => {});
      }
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((e) => console.error("listen overlay:visibility failed", e));
    // Seed from current OS state so the first render has the right answer
    // even if the visibility event fires before listen() resolves.
    getCurrentWindow()
      .isVisible()
      .then((v) => setVisible(v))
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // O-C3: ref is the single source of truth for the view state. The
  // forceRender reducer triggers a re-render after each ref mutation; no
  // async setState race between event handlers and the toggle debounce.
  const viewRef = useRef<View>("collapsed");
  const [, forceRender] = useReducer((x: number) => x + 1, 0);
  const lastToggleRef = useRef(0);

  const isExpanded = viewRef.current === "expanded";

  const toggle = useCallback(() => {
    const now = Date.now();
    if (now - lastToggleRef.current < TOGGLE_DEBOUNCE_MS) return;
    lastToggleRef.current = now;
    viewRef.current =
      viewRef.current === "collapsed" ? "expanded" : "collapsed";
    forceRender();
  }, []);

  const collapseOnly = useCallback(() => {
    if (viewRef.current === "collapsed") return;
    viewRef.current = "collapsed";
    forceRender();
  }, []);

  // O-H1: drag tracking is tied to real pointer input events, not a wall-
  // clock timer. The flag flips true the moment `startDragging()` is
  // called and flips false when the browser delivers `pointerup` (or any
  // of the fallback end-of-gesture events). No setTimeout heuristic, no
  // race against `onFocusChanged` — the guard clears exactly when the
  // user lets go, regardless of how long the drag lasted.
  const isDraggingRef = useRef(false);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const beginDragTracking = useCallback(() => {
    if (isDraggingRef.current) return;
    isDraggingRef.current = true;
    const onEnd = () => {
      isDraggingRef.current = false;
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("mouseup", onEnd);
      window.removeEventListener("blur", onEnd);
      dragCleanupRef.current = null;
    };
    dragCleanupRef.current = onEnd;
    // Multiple safety nets: `pointerup` is the primary signal, but on
    // Windows the OS captures the mouse for the duration of
    // `startDragging()` and Chromium may not always surface it. `blur`
    // catches the case where focus lands on the main window after a
    // successful drop; `pointercancel` catches touch/pen cancellation.
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("mouseup", onEnd);
    window.addEventListener("blur", onEnd);
  }, []);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (viewRef.current === "expanded") {
          collapseOnly();
        } else {
          invoke("overlay_hide").catch((err) =>
            console.error("overlay_hide failed", err),
          );
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapseOnly]);

  const saveTimerRef = useRef<number | null>(null);
  const queueSavePosition = useCallback(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      invoke("overlay_save_position").catch((e) =>
        console.error("overlay_save_position failed", e),
      );
      saveTimerRef.current = null;
    }, 400);
  }, []);

  useEffect(() => {
    let unlistenMoved: (() => void) | null = null;
    let unlistenFocus: (() => void) | null = null;
    const window_ = getCurrentWindow();
    window_
      .onMoved(() => {
        // Position autosave only — drag-flag lifecycle is owned by
        // beginDragTracking + the pointerup listener (O-H1).
        queueSavePosition();
      })
      .then((fn) => {
        unlistenMoved = fn;
      })
      .catch((e) => console.error("onMoved failed", e));
    window_
      .onFocusChanged(({ payload }) => {
        if (!payload && !isDraggingRef.current) {
          // O-C3: focus loss can only collapse the overlay, never expand it.
          // Going through `collapseOnly` keeps the state machine
          // unidirectional from this code path.
          collapseOnly();
        }
      })
      .then((fn) => {
        unlistenFocus = fn;
      })
      .catch((e) => console.error("onFocusChanged failed", e));
    return () => {
      unlistenMoved?.();
      unlistenFocus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("[data-no-drag]")) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const startTime = Date.now();
      let dragging = false;

      const onMove = (me: PointerEvent) => {
        if (dragging) return;
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          dragging = true;
          // O-H1: arm the pointerup-based drag guard BEFORE calling
          // startDragging(). Once the OS takes control, our local
          // pointermove/pointerup listeners stop firing — the global
          // listeners installed by beginDragTracking are what actually
          // clear the flag on release.
          beginDragTracking();
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          getCurrentWindow()
            .startDragging()
            .catch((err) => {
              console.error("startDragging failed", err);
              // Clean up the pointerup listener immediately if the OS
              // drag never actually started so we do not leave a stale
              // guard flag.
              dragCleanupRef.current?.();
            });
        }
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (!dragging && Date.now() - startTime < 500) {
          toggle();
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [toggle, beginDragTracking],
  );

  // O-C2: container is always at the expanded size. clip-path animates the
  // visible region between the pill silhouette (collapsed) and the full
  // rectangle (expanded). clip-path is GPU-composited in Chromium — zero
  // layout passes per frame.
  // O-H3: `opacity` reflects `config.overlay.opacity`, updated live via
  // the `overlay:config` event.
  // O-H4: the expanded/collapsed inner layers (below) are mutually
  // exclusive in pointer-events — exactly one has `auto` at any given
  // frame, and both flip at the same React render. The old 150ms delay-
  // induced dead zone where neither layer caught clicks is gone: the
  // collapsed layer keeps `pointer-events: auto` while it fades in, and
  // the expanded layer keeps `pointer-events: auto` for the whole
  // duration of its fade-in. The clip-path rewrite (O-C2) collapsed the
  // layout-resize window that made the old cross-fade visible, so the
  // delay on the opacity transition no longer masks any interactive
  // surface.
  const containerStyle: CSSProperties = {
    width: EXPANDED_W,
    height: EXPANDED_H,
    background: SURFACE_BG,
    border: SURFACE_BORDER,
    clipPath: isExpanded ? EXPANDED_CLIP : COLLAPSED_CLIP,
    transition: isExpanded ? EXPAND_TRANSITION : COLLAPSE_TRANSITION,
    willChange: "clip-path, opacity",
    pointerEvents: "auto",
    opacity: surfaceOpacity,
  };

  return (
    // O-C1 + O-H5: outer wrapper is transparent and pointer-events: none.
    // Only the inner box (the visible pill/card) accepts clicks and drag.
    <div
      className="flex h-screen w-screen items-center justify-center"
      style={{ background: "transparent", pointerEvents: "none" }}
    >
      <div
        className="relative overflow-hidden"
        style={containerStyle}
        onPointerDown={onPointerDown}
      >
        <ExpandedLayer
          meta={meta}
          tick={tick}
          isExpanded={isExpanded}
        />
        <CollapsedLayer
          meta={meta}
          tick={tick}
          isExpanded={isExpanded}
        />
      </div>
    </div>
  );
}

interface LayerProps {
  meta: MetaState | null;
  tick: TickState;
  isExpanded: boolean;
}

/**
 * Expanded card layer — full content with controls. Cross-fades against the
 * collapsed pill layer via opacity. Sits at inset-0 so it fills the entire
 * (always EXPANDED-sized) container; the parent's clip-path crops the
 * visible region down to the pill when collapsed.
 */
function ExpandedLayer({ meta, tick, isExpanded }: LayerProps) {
  const dotClass = statusDotClass(meta?.status);
  const modeLabel = meta && meta.mode ? fallbackModeLabel(meta.mode) : "Flint";
  const intervalLabel = meta?.current_interval?.type
    ? meta.current_interval.type.charAt(0).toUpperCase() +
      meta.current_interval.type.slice(1)
    : null;

  const target = meta?.current_interval?.target_sec;
  const displayTime =
    target != null && tick.interval_remaining != null
      ? formatTime(tick.interval_remaining)
      : formatTime(tick.elapsed_sec);

  const onTogglePlay = useCallback(async () => {
    if (!meta) return;
    try {
      if (meta.status === "running") {
        await invoke("pause_session");
      } else if (meta.status === "paused") {
        await invoke("resume_session");
      }
    } catch (e) {
      console.error("toggle play failed", e);
    }
  }, [meta]);

  const onStop = useCallback(async () => {
    try {
      await invoke("stop_session");
    } catch (e) {
      console.error("stop_session failed", e);
    }
  }, []);

  const onOpenMain = useCallback(async () => {
    try {
      await invoke("show_main_window");
    } catch (e) {
      console.error("show_main_window failed", e);
    }
  }, []);

  return (
    <div
      className="absolute inset-0 flex flex-col gap-1.5 px-3 py-2"
      style={{
        opacity: isExpanded ? 1 : 0,
        transition: isExpanded
          ? "opacity 200ms ease-out 100ms"
          : "opacity 100ms ease-out",
        pointerEvents: isExpanded ? "auto" : "none",
      }}
    >
      <div className="flex items-center gap-2.5">
        <span
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass}`}
        />
        <span className="font-mono text-[18px] tabular-nums text-[var(--accent)]">
          {displayTime}
        </span>
        <span className="ml-auto text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">
          {modeLabel}
          {intervalLabel ? ` · ${intervalLabel}` : ""}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-[2px] flex-1 overflow-hidden rounded-full bg-[var(--bg-elevated)]">
          {target != null && tick.interval_remaining != null && (
            // V-H3: progress bar uses transform: scaleX so the per-tick
            // animation is GPU-composited rather than a layout reflow.
            <div
              className="h-full origin-left bg-[var(--accent)]"
              style={{
                width: "100%",
                transform: `scaleX(${Math.max(
                  0,
                  Math.min(1, (target - tick.interval_remaining) / target),
                )})`,
                transition: "transform 200ms ease-out",
                willChange: "transform",
              }}
            />
          )}
        </div>
        {meta && meta.questions_done > 0 && (
          <span className="font-mono text-[10px] text-[var(--text-secondary)]">
            Q: {meta.questions_done}
          </span>
        )}
      </div>
      <div className="mt-1 flex items-center gap-1.5" data-no-drag>
        <OverlayButton
          disabled={!meta || meta.status === "idle"}
          onClick={onTogglePlay}
          title={meta?.status === "running" ? "Pause" : "Resume"}
        >
          {meta?.status === "running" ? <PauseIcon /> : <PlayIcon />}
        </OverlayButton>
        <OverlayButton
          disabled={!meta || meta.status === "idle"}
          onClick={onStop}
          title="Stop session"
          variant="danger"
        >
          <StopIcon />
        </OverlayButton>
        <button
          data-no-drag
          onClick={onOpenMain}
          className="ml-auto rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[10px] uppercase tracking-wider text-[var(--text-secondary)] transition-colors duration-150 ease-out hover:border-[var(--accent)] hover:text-[var(--text-primary)]"
        >
          Open Flint
        </button>
      </div>
    </div>
  );
}

/**
 * Collapsed pill layer — status dot + time + label. Positioned inside the
 * pill silhouette so it lines up with the visible (clip-pathed) region of
 * the parent container.
 */
function CollapsedLayer({ meta, tick, isExpanded }: LayerProps) {
  const dotClass = statusDotClass(meta?.status);
  const target = meta?.current_interval?.target_sec;
  const displayTime =
    target != null && tick.interval_remaining != null
      ? formatTime(tick.interval_remaining)
      : formatTime(tick.elapsed_sec);

  return (
    <div
      className="absolute flex items-center gap-2.5 px-3"
      style={{
        left: COLLAPSED_INSET_X,
        top: COLLAPSED_INSET_Y,
        width: COLLAPSED_W,
        height: COLLAPSED_H,
        opacity: isExpanded ? 0 : 1,
        transition: isExpanded
          ? "opacity 80ms ease-out"
          : "opacity 150ms ease-out 150ms",
        pointerEvents: isExpanded ? "none" : "auto",
      }}
    >
      <span
        className={`inline-block h-2 w-2 shrink-0 rounded-full transition-colors duration-150 ease-out ${dotClass}`}
      />
      <span className="font-mono text-[15px] tabular-nums text-[var(--accent)]">
        {displayTime}
      </span>
      <span className="ml-auto text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
        Flint
      </span>
    </div>
  );
}

function statusDotClass(status: MetaState["status"] | undefined): string {
  if (status === "running") return "bg-[var(--accent)]";
  if (status === "paused") return "bg-[var(--warning)]";
  return "bg-[var(--text-muted)]";
}

interface OverlayButtonProps {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  variant?: "default" | "danger";
  children: React.ReactNode;
}

function OverlayButton({
  onClick,
  title,
  disabled,
  variant = "default",
  children,
}: OverlayButtonProps) {
  const colorClass =
    variant === "danger"
      ? "hover:border-[var(--danger)] hover:text-[var(--danger)]"
      : "hover:border-[var(--accent)] hover:text-[var(--text-primary)]";
  return (
    <button
      data-no-drag
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`flex h-6 w-6 items-center justify-center rounded border border-[var(--border)] bg-[var(--bg-elevated)] text-[var(--text-secondary)] transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-40 ${colorClass}`}
    >
      {children}
    </button>
  );
}

function PlayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
      <path d="M2 1.5 L8 5 L2 8.5 Z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
      <rect x="2" y="1.5" width="2" height="7" />
      <rect x="6" y="1.5" width="2" height="7" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 9 9" fill="currentColor">
      <rect x="1" y="1" width="7" height="7" />
    </svg>
  );
}
