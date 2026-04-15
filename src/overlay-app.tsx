import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTimer } from "./hooks/use-timer";
import { formatTime } from "./lib/format";
import { fallbackModeLabel } from "./lib/types";

type ExpandedState = "collapsed" | "expanded";

// Inner-container dimensions. The Tauri window itself is fixed at WINDOW_W/H
// in overlay.rs and never resizes — collapsed/expanded is purely a CSS
// animation on this inner element. Native window resize on Windows was both
// jank-prone (mid-animation reflow) and a Win32 crash vector
// (Chrome_WidgetWin_0 unregister on rapid toggle).
const COLLAPSED_W = 208;
const COLLAPSED_H = 36;
const EXPANDED_W = 272;
const EXPANDED_H = 92;

const SURFACE_BG = "#1a1a1a";
const SURFACE_BORDER = "1px solid rgba(255, 255, 255, 0.08)";
// Smallest gap between consecutive expand/collapse toggles. Without this,
// rapid click-spamming the pill stacks overlapping CSS transitions and the
// container visibly stutters.
const TOGGLE_DEBOUNCE_MS = 100;

export function OverlayApp() {
  const { state, intervalRemaining } = useTimer();
  const [view, setView] = useState<ExpandedState>("collapsed");
  const isExpanded = view === "expanded";

  // Mirror `view` into a ref so async callbacks (focus-change, pointer-up)
  // see the latest value without re-binding.
  const viewRef = useRef<ExpandedState>("collapsed");
  viewRef.current = view;

  // Guard against the focus-loss → collapse reaction that fires when the OS
  // starts dragging the window. Without this, grabbing an expanded overlay
  // collapses it mid-drag and the content disappears.
  const isDraggingRef = useRef(false);
  const dragClearTimerRef = useRef<number | null>(null);

  // Toggle debounce timestamp.
  const lastToggleRef = useRef<number>(0);

  const expand = useCallback(() => {
    if (viewRef.current === "expanded") return;
    const now = Date.now();
    if (now - lastToggleRef.current < TOGGLE_DEBOUNCE_MS) return;
    lastToggleRef.current = now;
    setView("expanded");
  }, []);

  const collapse = useCallback(() => {
    if (viewRef.current === "collapsed") return;
    const now = Date.now();
    if (now - lastToggleRef.current < TOGGLE_DEBOUNCE_MS) return;
    lastToggleRef.current = now;
    setView("collapsed");
  }, []);

  useEffect(() => {
    return () => {
      if (dragClearTimerRef.current != null) {
        window.clearTimeout(dragClearTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (view === "expanded") {
          collapse();
        } else {
          invoke("overlay_hide").catch((err) =>
            console.error("overlay_hide failed", err),
          );
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, collapse]);

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
        queueSavePosition();
        // The OS fires onMoved continuously during a drag and stops once the
        // user releases. Debounce the dragging-clear so the focus-change that
        // arrives just after the drag still sees the guard set.
        if (isDraggingRef.current) {
          if (dragClearTimerRef.current != null) {
            window.clearTimeout(dragClearTimerRef.current);
          }
          dragClearTimerRef.current = window.setTimeout(() => {
            isDraggingRef.current = false;
            dragClearTimerRef.current = null;
          }, 200);
        }
      })
      .then((fn) => {
        unlistenMoved = fn;
      })
      .catch((e) => console.error("onMoved failed", e));
    window_
      .onFocusChanged(({ payload }) => {
        if (!payload && !isDraggingRef.current) {
          collapse();
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
          isDraggingRef.current = true;
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          getCurrentWindow()
            .startDragging()
            .catch((err) => {
              console.error("startDragging failed", err);
              isDraggingRef.current = false;
            });
        }
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (!dragging && Date.now() - startTime < 500) {
          if (viewRef.current === "collapsed") {
            expand();
          } else {
            collapse();
          }
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [expand, collapse],
  );

  const dotClass =
    state?.status === "running"
      ? "bg-[var(--accent)]"
      : state?.status === "paused"
        ? "bg-[var(--warning)]"
        : "bg-[var(--text-muted)]";

  const modeLabel = state && state.mode ? fallbackModeLabel(state.mode) : "Flint";
  const intervalLabel = state?.current_interval?.type
    ? state.current_interval.type.charAt(0).toUpperCase() +
      state.current_interval.type.slice(1)
    : null;

  const displayTime =
    state?.current_interval?.target_sec != null && intervalRemaining != null
      ? formatTime(intervalRemaining)
      : formatTime(state?.elapsed_sec ?? 0);

  const target = state?.current_interval?.target_sec;
  const progressPct =
    target != null && intervalRemaining != null
      ? Math.max(0, Math.min(100, ((target - intervalRemaining) / target) * 100))
      : null;

  const onTogglePlay = useCallback(async () => {
    if (!state) return;
    try {
      if (state.status === "running") {
        await invoke("pause_session");
      } else if (state.status === "paused") {
        await invoke("resume_session");
      }
    } catch (e) {
      console.error("toggle play failed", e);
    }
  }, [state]);

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

  // Container size + radius are CSS-animated. Faster ease-in on collapse so
  // the pill snaps back crisply; slower cubic-bezier on expand so the
  // expanded content has visual room to fade in (see opacity delays below).
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

  return (
    <div
      className="flex h-screen w-screen items-center justify-center"
      style={{ background: SURFACE_BG }}
      onPointerDown={onPointerDown}
    >
      <div className="relative overflow-hidden" style={containerStyle}>
        {/* Expanded layer — full content with controls. */}
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
              {progressPct != null && (
                <div
                  className="h-full bg-[var(--accent)] transition-[width] duration-200 ease-out"
                  style={{ width: `${progressPct}%` }}
                />
              )}
            </div>
            {state && state.questions_done > 0 && (
              <span className="font-mono text-[10px] text-[var(--text-secondary)]">
                Q: {state.questions_done}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5" data-no-drag>
            <OverlayButton
              disabled={!state || state.status === "idle"}
              onClick={onTogglePlay}
              title={state?.status === "running" ? "Pause" : "Resume"}
            >
              {state?.status === "running" ? <PauseIcon /> : <PlayIcon />}
            </OverlayButton>
            <OverlayButton
              disabled={!state || state.status === "idle"}
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

        {/* Collapsed layer — pill content (status dot + time + label). */}
        <div
          className="absolute inset-0 flex items-center gap-2.5 px-3"
          style={{
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
      </div>
    </div>
  );
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
