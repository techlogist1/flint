import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTimer } from "./hooks/use-timer";
import { formatTime } from "./lib/format";
import { MODE_LABELS, type Mode } from "./lib/types";

type ExpandedState = "collapsed" | "expanded";

export function OverlayApp() {
  const { state, intervalRemaining } = useTimer();
  const [view, setView] = useState<ExpandedState>("collapsed");

  useEffect(() => {
    invoke("overlay_set_expanded", { expanded: view === "expanded" }).catch(
      (e) => console.error("overlay_set_expanded failed", e),
    );
  }, [view]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (view === "expanded") {
          setView("collapsed");
        } else {
          invoke("overlay_hide").catch((err) =>
            console.error("overlay_hide failed", err),
          );
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view]);

  useEffect(() => {
    let unlistenMoved: (() => void) | null = null;
    let unlistenFocus: (() => void) | null = null;
    const window_ = getCurrentWindow();
    window_
      .onMoved(() => {
        queueSavePosition();
      })
      .then((fn) => {
        unlistenMoved = fn;
      })
      .catch((e) => console.error("onMoved failed", e));
    window_
      .onFocusChanged(({ payload }) => {
        if (!payload) {
          setView("collapsed");
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
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          getCurrentWindow()
            .startDragging()
            .catch((err) => console.error("startDragging failed", err));
        }
      };

      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (!dragging && Date.now() - startTime < 500) {
          setView((v) => (v === "collapsed" ? "expanded" : "collapsed"));
        }
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [],
  );

  const dotClass =
    state?.status === "running"
      ? "bg-[var(--success)]"
      : state?.status === "paused"
        ? "bg-[var(--warning)]"
        : "bg-[var(--text-muted)]";

  const mode = (state?.mode as Mode) || "pomodoro";
  const modeLabel = state ? MODE_LABELS[mode] ?? mode : "Flint";
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

  return (
    <div
      className="flex h-screen w-screen items-stretch justify-stretch p-1"
      onPointerDown={onPointerDown}
    >
      <div
        className={`flex w-full flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]/95 shadow-2xl backdrop-blur-md ${
          view === "expanded" ? "animate-[flint-overlay-expand_180ms_ease-out]" : ""
        }`}
        style={{
          boxShadow:
            "0 10px 30px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.3)",
        }}
      >
        {view === "collapsed" ? (
          <div className="flex h-full items-center gap-2.5 px-3">
            <span
              className={`inline-block h-2 w-2 shrink-0 rounded-full transition-colors duration-150 ease-out ${dotClass}`}
            />
            <span className="font-mono text-[15px] tabular-nums text-[var(--text-primary)]">
              {displayTime}
            </span>
            <span className="ml-auto text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              Flint
            </span>
          </div>
        ) : (
          <div className="flex h-full flex-col gap-1.5 px-3 py-2">
            <div className="flex items-center gap-2.5">
              <span
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass}`}
              />
              <span className="font-mono text-[18px] tabular-nums text-[var(--text-primary)]">
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
        )}
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
