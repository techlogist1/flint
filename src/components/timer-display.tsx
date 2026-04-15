import { useEffect, useMemo, useState } from "react";
import type { Mode, Config } from "../lib/types";
import { fallbackModeLabel } from "../lib/types";
import { formatTime, modeDescription } from "../lib/format";
import { useTickState, type MetaState } from "../hooks/use-timer";
import { useTimerModes } from "./plugin-host";
import { TagInput } from "./tag-input";

interface TimerDisplayProps {
  meta: MetaState | null;
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
  meta,
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

  if (!meta) {
    return (
      <div className="flex flex-1 items-center justify-center text-[var(--text-muted)]">
        loading…
      </div>
    );
  }

  const isIdle = meta.status === "idle";
  const isRunning = meta.status === "running";
  const isPaused = meta.status === "paused";

  const displayMode = (isIdle ? selectedMode : (meta.mode as Mode)) || "pomodoro";

  const intervalLabel = meta.current_interval?.type
    ? meta.current_interval.type.charAt(0).toUpperCase() +
      meta.current_interval.type.slice(1)
    : null;

  const hasTarget = meta.current_interval?.target_sec != null;
  const intervalTarget = meta.current_interval?.target_sec ?? null;

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center px-6">
      <div className="flex flex-col items-center gap-4">
        <div className="flex items-center gap-3">
          <StatusDot status={meta.status} />
          <span className="text-xs uppercase tracking-wider text-[var(--text-secondary)]">
            {isIdle
              ? labelFor(displayMode)
              : `${labelFor(displayMode)}${
                  intervalLabel ? ` · ${intervalLabel}` : ""
                }`}
            {isPaused && " · Paused"}
          </span>
        </div>

        <TimerDigit
          isIdle={isIdle}
          hasTarget={hasTarget}
          mode={displayMode}
          config={config}
        />

        {isIdle && (
          <div className="text-sm text-[var(--text-secondary)]">
            {modeDescription(
              displayMode,
              config?.pomodoro.focus_min ?? 25,
              config?.core.countdown_default_min ?? 60,
            )}
          </div>
        )}

        {hasTarget && !isIdle && intervalTarget != null && (
          <div className="h-[3px] w-72 overflow-hidden rounded-full bg-[var(--bg-elevated)]">
            <ProgressBar target={intervalTarget} />
          </div>
        )}

        {!isIdle && <QuestionsCount initial={meta.questions_done} />}

        {/* Tags display (idle shows staged, active shows meta.tags) */}
        {!tagInputOpen &&
          (isIdle ? stagedTags : meta.tags).length > 0 && (
            <div className="flex flex-wrap justify-center gap-1.5">
              {(isIdle ? stagedTags : meta.tags).map((t) => (
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
            initial={isIdle ? stagedTags : meta.tags}
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

/**
 * P-C2: subscribe to tick state in this leaf so the rest of TimerDisplay
 * does not reconcile every second. Only this `<div>` re-renders on a tick.
 */
function TimerDigit({
  isIdle,
  hasTarget,
  mode,
  config,
}: {
  isIdle: boolean;
  hasTarget: boolean;
  mode: Mode;
  config: Config | null;
}) {
  const tick = useTickState();
  const displayTime = computeDisplayTime(
    isIdle,
    hasTarget,
    tick.interval_remaining,
    tick.elapsed_sec,
    mode,
    config,
  );
  return (
    <div className="font-mono text-[96px] leading-none tracking-tight tabular-nums text-[var(--text-primary)]">
      {displayTime}
    </div>
  );
}

/**
 * V-H4: progress bar drives a `transform: scaleX(...)` instead of
 * `width`, so the per-tick paint is GPU-composited and never triggers
 * layout. Subscribes to tick locally so only this element re-renders.
 */
function ProgressBar({ target }: { target: number }) {
  const tick = useTickState();
  const remaining = tick.interval_remaining ?? target;
  const ratio = target > 0 ? Math.max(0, Math.min(1, (target - remaining) / target)) : 0;
  return (
    <div
      className="h-full origin-left bg-[var(--accent)]"
      style={{
        width: "100%",
        transform: `scaleX(${ratio})`,
        transition: "transform 200ms ease-out",
        willChange: "transform",
      }}
    />
  );
}

/**
 * Question counter is meta-driven (only changes on Enter), but the parent
 * `meta` object would re-render the whole TimerDisplay tree on a meta
 * change. Splitting it out keeps the conditional render local. The `initial`
 * prop only changes when meta does, which is exactly when we want this to
 * update.
 */
function QuestionsCount({ initial }: { initial: number }) {
  if (initial === 0) return null;
  return (
    <div className="font-mono text-sm text-[var(--text-secondary)]">
      Q: {initial}
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
      <div className="flex w-full items-center justify-center gap-2 rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2 text-xs text-[var(--text-secondary)]">
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

function StatusDot({ status }: { status: MetaState["status"] }) {
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
  isIdle: boolean,
  hasTarget: boolean,
  intervalRemaining: number | null,
  elapsedSec: number,
  mode: Mode,
  config: Config | null,
): string {
  // Idle: show target duration for the selected mode (or 00:00 for stopwatch)
  if (isIdle) {
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
  if (hasTarget && intervalRemaining != null) {
    return formatTime(intervalRemaining);
  }
  return formatTime(elapsedSec);
}
