import {
  useCallback,
  useEffect,
  useRef,
  useState,
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

const PILL_W = 320;
const PILL_H = 52;

export function OverlayApp() {
  const meta = useMetaState();
  // P-H4: gate the session:tick subscription on overlay visibility so a
  // hidden overlay does not pay React reconciliation cost for ticks it
  // cannot display.
  const [visible, setVisible] = useState(true);
  const tick = useTickState(visible);

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
    getCurrentWindow()
      .isVisible()
      .then((v) => setVisible(v))
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // O-H1: drag guard is armed only when startDragging() actually fires.
  // The global pointerup/blur listeners clear it on release.
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
    const window_ = getCurrentWindow();
    window_
      .onMoved(() => {
        queueSavePosition();
      })
      .then((fn) => {
        unlistenMoved = fn;
      })
      .catch((e) => console.error("onMoved failed", e));
    return () => {
      unlistenMoved?.();
    };
  }, [queueSavePosition]);

  // Drag handler — the entire pill is draggable. Any click on an element
  // marked data-no-drag (the buttons) bypasses startDragging.
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (target.closest("[data-no-drag]")) return;
      beginDragTracking();
      getCurrentWindow()
        .startDragging()
        .catch((err) => {
          console.error("startDragging failed", err);
          dragCleanupRef.current?.();
        });
    },
    [beginDragTracking],
  );

  return (
    // Outer wrapper is transparent and pointer-events: none so only the
    // pill itself accepts clicks.
    <div
      className="flex h-screen w-screen items-center justify-center"
      style={{ background: "transparent", pointerEvents: "none" }}
    >
      <Pill
        meta={meta}
        tick={tick}
        surfaceOpacity={surfaceOpacity}
        onPointerDown={onPointerDown}
      />
    </div>
  );
}

function Pill({
  meta,
  tick,
  surfaceOpacity,
  onPointerDown,
}: {
  meta: MetaState | null;
  tick: TickState;
  surfaceOpacity: number;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const status = meta?.status ?? "idle";
  const isActive = status === "running" || status === "paused";

  const intervalType = meta?.current_interval?.type ?? null;
  const dotColor = statusDotColor(status, intervalType);

  const modeLabel = meta && meta.mode ? fallbackModeLabel(meta.mode) : null;
  const intervalLabel = intervalLabelFor(intervalType, status, modeLabel);

  const target = meta?.current_interval?.target_sec;
  const displayTime =
    isActive && target != null && tick.interval_remaining != null
      ? formatTime(tick.interval_remaining)
      : isActive
        ? formatTime(tick.elapsed_sec)
        : "00:00";

  const progressRatio =
    isActive && target != null && tick.interval_remaining != null
      ? Math.max(0, Math.min(1, (target - tick.interval_remaining) / target))
      : 0;

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
      onPointerDown={onPointerDown}
      className="relative flex items-center overflow-hidden"
      style={{
        width: PILL_W,
        height: PILL_H,
        background: "var(--bg-overlay)",
        border: "1px solid var(--border-focus)",
        borderRadius: 9999,
        opacity: surfaceOpacity,
        pointerEvents: "auto",
        cursor: "default",
        fontFamily:
          "'JetBrains Mono', 'Fira Code', 'SF Mono', 'Cascadia Code', 'Consolas', monospace",
      }}
    >
      <div className="flex w-full items-center gap-2.5 px-4">
        <span
          aria-hidden
          className="inline-block h-[6px] w-[6px] shrink-0"
          style={{
            backgroundColor: dotColor,
            borderRadius: 9999,
            animation:
              status === "running" ? "flint-blink 1.2s steps(2) infinite" : "none",
          }}
        />

        <span
          className="tabular-nums"
          style={{
            color: isActive ? "var(--text-bright)" : "var(--text-secondary)",
            fontSize: 16,
            fontWeight: 500,
            letterSpacing: "-0.02em",
          }}
        >
          {displayTime}
        </span>

        <span
          className="uppercase"
          style={{
            color: "var(--text-secondary)",
            fontSize: 9,
            fontWeight: 500,
            letterSpacing: "0.12em",
          }}
        >
          {intervalLabel}
        </span>

        {isActive && (
          <div className="ml-auto flex items-center gap-1" data-no-drag>
            <PillButton
              onClick={onTogglePlay}
              title={status === "running" ? "Pause" : "Resume"}
              label={status === "running" ? "‖" : "▶"}
            />
            <PillButton onClick={onStop} title="Stop session" label="■" danger />
          </div>
        )}

        <button
          data-no-drag
          onClick={onOpenMain}
          title="Open Flint"
          className={`${isActive ? "" : "ml-auto"} uppercase tracking-[0.18em]`}
          style={{
            color: "var(--text-secondary)",
            fontSize: 9,
            fontWeight: 600,
            background: "transparent",
            border: "none",
            padding: "4px 2px",
            cursor: "pointer",
            transition: "color 100ms ease-out",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color =
              "var(--accent)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.color =
              "var(--text-secondary)";
          }}
        >
          FLINT
        </button>
      </div>

      <ProgressBar ratio={progressRatio} color={dotColor} />
    </div>
  );
}

function PillButton({
  onClick,
  title,
  label,
  danger,
}: {
  onClick: () => void;
  title: string;
  label: string;
  danger?: boolean;
}) {
  const hoverColor = danger ? "var(--status-error)" : "var(--accent)";
  return (
    <button
      data-no-drag
      type="button"
      onClick={onClick}
      title={title}
      className="flex h-6 w-6 items-center justify-center"
      style={{
        color: "var(--text-secondary)",
        background: "transparent",
        border: "none",
        fontSize: 13,
        lineHeight: 1,
        cursor: "pointer",
        transition: "color 100ms ease-out",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.color = hoverColor;
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.color =
          "var(--text-secondary)";
      }}
    >
      {label}
    </button>
  );
}

function ProgressBar({ ratio, color }: { ratio: number; color: string }) {
  return (
    <div
      className="absolute bottom-0 left-0 right-0"
      style={{
        height: 2,
        background: "var(--border-subtle)",
      }}
    >
      <div
        className="h-full origin-left"
        style={{
          width: "100%",
          transform: `scaleX(${ratio})`,
          transition: "transform 200ms ease-out",
          willChange: "transform",
          background: color,
        }}
      />
    </div>
  );
}

function statusDotColor(
  status: MetaState["status"],
  intervalType: string | null,
): string {
  if (status === "paused") return "var(--status-paused)";
  if (status === "running") {
    if (intervalType === "break") return "var(--status-break)";
    return "var(--status-running)";
  }
  return "var(--status-idle)";
}

function intervalLabelFor(
  intervalType: string | null,
  status: MetaState["status"],
  modeLabel: string | null,
): string {
  if (status === "idle") return "IDLE";
  if (intervalType === "focus") return "FOCUS";
  if (intervalType === "break") return "BREAK";
  if (intervalType) return intervalType.toUpperCase();
  if (modeLabel) return modeLabel.toUpperCase();
  return "FOCUS";
}
