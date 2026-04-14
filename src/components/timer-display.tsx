import { useEffect, useMemo, useState } from "react";
import type { Mode, TimerStateView, Config } from "../lib/types";
import { fallbackModeLabel } from "../lib/types";
import { formatTime, modeDescription } from "../lib/format";
import { useTimerModes } from "./plugin-host";
import { TagInput } from "./tag-input";

interface TimerDisplayProps {
  state: TimerStateView | null;
  intervalRemaining: number | null;
  config: Config | null;
  selectedMode: Mode;
  stagedTags: string[];
  tagInputOpen: boolean;
  stopConfirmOpen: boolean;
  hintDismissed: boolean;
  onTagConfirm: (tags: string[]) => void;
  onTagCancel: () => void;
}

export function TimerDisplay({
  state,
  intervalRemaining,
  config,
  selectedMode,
  stagedTags,
  tagInputOpen,
  stopConfirmOpen,
  hintDismissed,
  onTagConfirm,
  onTagCancel,
}: TimerDisplayProps) {
  const timerModes = useTimerModes();
  const labelFor = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of timerModes) map.set(m.id, m.label);
    return (id: string) => map.get(id) ?? fallbackModeLabel(id);
  }, [timerModes]);

  if (!state) {
    return (
      <div className="flex flex-1 items-center justify-center text-[var(--text-muted)]">
        loading…
      </div>
    );
  }

  const isIdle = state.status === "idle";
  const isRunning = state.status === "running";
  const isPaused = state.status === "paused";

  const displayMode = (isIdle ? selectedMode : (state.mode as Mode)) || "pomodoro";

  const displayTime = computeDisplayTime(
    state,
    intervalRemaining,
    displayMode,
    config,
  );

  const progressPct = computeProgress(state, intervalRemaining);

  const intervalLabel = state.current_interval?.type
    ? state.current_interval.type.charAt(0).toUpperCase() +
      state.current_interval.type.slice(1)
    : null;

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center px-6">
      <div className="flex flex-col items-center gap-4">
        <div className="flex items-center gap-3">
          <StatusDot status={state.status} />
          <span className="text-xs uppercase tracking-wider text-[var(--text-secondary)]">
            {isIdle
              ? labelFor(displayMode)
              : `${labelFor(displayMode)}${
                  intervalLabel ? ` · ${intervalLabel}` : ""
                }`}
            {isPaused && " · Paused"}
          </span>
        </div>

        <div className="font-mono text-[96px] leading-none tracking-tight tabular-nums text-[var(--text-primary)]">
          {displayTime}
        </div>

        {isIdle && (
          <div className="text-sm text-[var(--text-secondary)]">
            {modeDescription(
              displayMode,
              config?.pomodoro.focus_min ?? 25,
              config?.core.countdown_default_min ?? 60,
            )}
          </div>
        )}

        {progressPct != null && !isIdle && (
          <div className="h-[3px] w-72 overflow-hidden rounded-full bg-[var(--bg-elevated)]">
            <div
              className="h-full bg-[var(--accent)] transition-[width] duration-200 ease-out"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}

        {!isIdle && state.questions_done > 0 && (
          <div className="font-mono text-sm text-[var(--text-secondary)]">
            Q: {state.questions_done}
          </div>
        )}

        {/* Tags display (idle shows staged, active shows state.tags) */}
        {!tagInputOpen &&
          (isIdle ? stagedTags : state.tags).length > 0 && (
            <div className="flex flex-wrap justify-center gap-1.5">
              {(isIdle ? stagedTags : state.tags).map((t) => (
                <span
                  key={t}
                  className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

        {/* Inline tag input */}
        {tagInputOpen && (
          <TagInput
            initial={isIdle ? stagedTags : state.tags}
            onConfirm={onTagConfirm}
            onCancel={onTagCancel}
          />
        )}

        {/* Idle hint */}
        {isIdle && !tagInputOpen && !hintDismissed && (
          <div className="mt-2 text-xs text-[var(--text-muted)]">
            Press <Kbd>Space</Kbd> to start · <Kbd>Ctrl+T</Kbd> to add tags ·{" "}
            <Kbd>Ctrl+1/2/3</Kbd> to switch mode
          </div>
        )}

        {/* Running/paused hint */}
        {!isIdle && !tagInputOpen && (
          <div className="mt-2 text-xs text-[var(--text-muted)]">
            <Kbd>Space</Kbd> {isRunning ? "pause" : "resume"} ·{" "}
            <Kbd>Enter</Kbd> mark question · <Kbd>Esc</Kbd> stop
          </div>
        )}
      </div>

      <StopConfirmToast open={stopConfirmOpen} />
    </div>
  );
}

function StopConfirmToast({ open }: { open: boolean }) {
  // Keep the bar mounted for the slide-out animation after `open` flips to
  // false. `visible` drives the CSS transform; `mounted` controls presence in
  // the tree.
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Next frame so the transition fires off a translated-down starting
      // state and the bar slides in.
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    if (!mounted) return;
    setVisible(false);
    const t = window.setTimeout(() => setMounted(false), 200);
    return () => window.clearTimeout(t);
  }, [open, mounted]);

  if (!mounted) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-6 pb-3"
      style={{
        transform: visible ? "translateY(0)" : "translateY(12px)",
        opacity: visible ? 1 : 0,
        transition:
          "transform 200ms ease-out, opacity 200ms ease-out",
      }}
    >
      <div className="flex w-full items-center justify-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)]/85 px-4 py-2 text-xs text-[var(--text-secondary)] backdrop-blur-sm">
        <span>End session?</span>
        <span className="text-[var(--text-muted)]">·</span>
        <Kbd>Enter</Kbd>
        <span>confirm</span>
        <span className="text-[var(--text-muted)]">·</span>
        <Kbd>Esc</Kbd>
        <span>cancel</span>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: TimerStateView["status"] }) {
  const color =
    status === "running"
      ? "bg-[var(--success)]"
      : status === "paused"
        ? "bg-[var(--warning)]"
        : "bg-[var(--text-muted)]";
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full transition-colors duration-150 ease-out ${color}`}
    />
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
      {children}
    </kbd>
  );
}

function computeDisplayTime(
  state: TimerStateView,
  intervalRemaining: number | null,
  mode: Mode,
  config: Config | null,
): string {
  // Idle: show target duration for the selected mode (or 00:00 for stopwatch)
  if (state.status === "idle") {
    if (mode === "pomodoro") {
      return formatTime((config?.pomodoro.focus_min ?? 25) * 60);
    }
    if (mode === "countdown") {
      return formatTime((config?.core.countdown_default_min ?? 60) * 60);
    }
    return formatTime(0);
  }

  // Running/paused: pomodoro & countdown show remaining in current interval;
  // stopwatch shows total elapsed.
  if (state.current_interval?.target_sec != null && intervalRemaining != null) {
    return formatTime(intervalRemaining);
  }
  return formatTime(state.elapsed_sec);
}

function computeProgress(
  state: TimerStateView,
  intervalRemaining: number | null,
): number | null {
  const target = state.current_interval?.target_sec;
  if (!target || intervalRemaining == null) return null;
  const done = target - intervalRemaining;
  return Math.max(0, Math.min(100, (done / target) * 100));
}
