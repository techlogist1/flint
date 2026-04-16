import { useMemo } from "react";
import type { Mode, Config } from "../lib/types";
import { fallbackModeLabel } from "../lib/types";
import { formatTime, isBreakInterval, modeDescription } from "../lib/format";
import { useTickState, type MetaState } from "../hooks/use-timer";
import { useTimerModes } from "./plugin-host";
import { TagInput } from "./tag-input";
import { TagAutocomplete } from "./tag-autocomplete";
import { QuickStartBar } from "./quick-start-bar";
import type { Preset } from "../lib/presets";

interface TimerDisplayProps {
  meta: MetaState | null;
  config: Config | null;
  selectedMode: Mode;
  stagedTags: string[];
  tagInputOpen: boolean;
  stopConfirmOpen: boolean;
  hintDismissed: boolean;
  presets: Preset[];
  onTagConfirm: (tags: string[]) => void;
  onTagCancel: () => void;
  onTagsChange: (tags: string[]) => void;
  onLoadPreset: (preset: Preset) => void;
  onEditPreset: (preset: Preset) => void;
  onDeletePreset: (preset: Preset) => void;
}

export function TimerDisplay({
  meta,
  config,
  selectedMode,
  stagedTags,
  tagInputOpen,
  stopConfirmOpen,
  hintDismissed,
  presets,
  onTagConfirm,
  onTagCancel,
  onTagsChange,
  onLoadPreset,
  onEditPreset,
  onDeletePreset,
}: TimerDisplayProps) {
  const timerModes = useTimerModes();
  const labelFor = useMemo(() => {
    const map = new Map<string, string>();
    for (const m of timerModes) map.set(m.id, m.label);
    return (id: string) => map.get(id) ?? fallbackModeLabel(id);
  }, [timerModes]);

  if (!meta) {
    return (
      <div className="flex flex-1 items-center justify-center text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
        LOADING…
      </div>
    );
  }

  const isIdle = meta.status === "idle";
  const isRunning = meta.status === "running";
  const isPaused = meta.status === "paused";

  const displayMode = (isIdle ? selectedMode : (meta.mode as Mode)) || "pomodoro";

  const intervalType = meta.current_interval?.type ?? null;
  const intervalLabel = intervalType ? intervalType.toUpperCase() : null;

  const statusLabel = isIdle
    ? "IDLE"
    : isPaused
      ? "PAUSED"
      : isRunning
        ? "ACTIVE"
        : meta.status.toUpperCase();

  const hasTarget = meta.current_interval?.target_sec != null;
  const intervalTarget = meta.current_interval?.target_sec ?? null;

  const modeLabelUp = labelFor(displayMode).toUpperCase();

  const currentTags = isIdle ? stagedTags : meta.tags;

  return (
    <div className="relative flex flex-1 flex-col items-center justify-center px-8">
      <div className="flex w-full max-w-3xl flex-col items-center gap-6">
        {/* Status line: dot · mode · interval · status */}
        <div className="flex items-center gap-3 text-[11px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
          <StatusDot status={meta.status} intervalType={intervalType} />
          <span>{modeLabelUp}</span>
          <Sep />
          <span>{intervalLabel ?? (isIdle ? "READY" : "—")}</span>
          <Sep />
          <span>{statusLabel}</span>
        </div>

        {/* Hero: massive centered timer digits */}
        <TimerDigit
          isIdle={isIdle}
          hasTarget={hasTarget}
          mode={displayMode}
          config={config}
        />

        {/* Idle mode description */}
        {isIdle && (
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
            {modeDescription(
              displayMode,
              config?.pomodoro.focus_duration ?? 25,
              config?.core.countdown_default_min ?? 60,
            ).toUpperCase()}
          </div>
        )}

        {/* 2px progress bar */}
        <div className="h-[2px] w-full max-w-xl bg-[var(--border-subtle)]">
          {hasTarget && !isIdle && intervalTarget != null ? (
            <ProgressBar target={intervalTarget} />
          ) : (
            <div className="h-full w-0" />
          )}
        </div>

        {/* Question count — inline, only if > 0 */}
        {!isIdle && meta.questions_done > 0 && (
          <div className="text-[11px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            Q <span className="text-[var(--text-bright)]">{meta.questions_done}</span>
          </div>
        )}

        {/* Idle layout: quick-start bar + inline tag autocomplete. When
            running, tags are read-only pills (unless Ctrl+T opened the
            legacy mid-session TagInput). */}
        {isIdle && !tagInputOpen && (
          <QuickStartBar
            presets={presets}
            onLoad={onLoadPreset}
            onEdit={onEditPreset}
            onDelete={onDeletePreset}
          />
        )}

        {isIdle && !tagInputOpen && (
          <TagAutocomplete
            initial={stagedTags}
            onChange={onTagsChange}
            autoFocus={false}
            placeholder="add tags…"
          />
        )}

        {/* Running: read-only tag pills */}
        {!isIdle && !tagInputOpen && currentTags.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2 text-[11px]">
            {currentTags.map((t) => (
              <span
                key={t}
                className="text-[var(--accent)]"
                style={{ letterSpacing: "0.04em" }}
              >
                [{t}]
              </span>
            ))}
          </div>
        )}

        {/* Ctrl+T mid-session tag input (legacy inline text field) */}
        {tagInputOpen && (
          <TagInput
            initial={currentTags}
            onConfirm={onTagConfirm}
            onCancel={onTagCancel}
          />
        )}

        {/* Keyboard hints — muted text, switches to inline stop confirmation */}
        {!tagInputOpen && (
          <HintLine
            isIdle={isIdle}
            isRunning={isRunning}
            stopConfirmOpen={stopConfirmOpen}
            hintDismissed={hintDismissed}
          />
        )}
      </div>
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
    <div
      className="tabular-nums"
      style={{
        fontSize: "clamp(48px, 12vw, 80px)",
        fontWeight: 500,
        lineHeight: 1,
        letterSpacing: "-0.03em",
        color: isIdle ? "var(--text-primary)" : "var(--text-bright)",
      }}
    >
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
  const ratio =
    target > 0 ? Math.max(0, Math.min(1, (target - remaining) / target)) : 0;
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

function StatusDot({
  status,
  intervalType,
}: {
  status: MetaState["status"];
  intervalType: string | null;
}) {
  const color =
    status === "paused"
      ? "var(--status-paused)"
      : status === "running"
        ? isBreakInterval(intervalType)
          ? "var(--status-break)"
          : "var(--status-running)"
        : "var(--status-idle)";
  return (
    <span
      className="inline-block h-[6px] w-[6px]"
      style={{
        backgroundColor: color,
        borderRadius: 9999,
        animation:
          status === "running" ? "flint-blink 1.2s steps(2) infinite" : "none",
      }}
    />
  );
}

function Sep() {
  return <span className="text-[var(--text-muted)]">·</span>;
}

function HintLine({
  isIdle,
  isRunning,
  stopConfirmOpen,
  hintDismissed,
}: {
  isIdle: boolean;
  isRunning: boolean;
  stopConfirmOpen: boolean;
  hintDismissed: boolean;
}) {
  if (stopConfirmOpen) {
    return (
      <div className="mt-1 text-[11px] lowercase tracking-wide text-[var(--status-error)]">
        stop session? <span className="text-[var(--text-muted)]">·</span>{" "}
        <span className="text-[var(--text-primary)]">[Enter]</span> confirm{" "}
        <span className="text-[var(--text-muted)]">·</span>{" "}
        <span className="text-[var(--text-primary)]">[Esc]</span> cancel
      </div>
    );
  }

  if (isIdle) {
    if (hintDismissed) return null;
    return (
      <div className="mt-1 text-[11px] lowercase tracking-wide text-[var(--text-muted)]">
        <span className="text-[var(--text-secondary)]">[Space]</span> start{" "}
        <span>·</span>{" "}
        <span className="text-[var(--text-secondary)]">[Ctrl+P]</span> commands{" "}
        <span>·</span>{" "}
        <span className="text-[var(--text-secondary)]">[Ctrl+,]</span> settings
      </div>
    );
  }

  return (
    <div className="mt-1 text-[11px] lowercase tracking-wide text-[var(--text-muted)]">
      <span className="text-[var(--text-secondary)]">[Space]</span>{" "}
      {isRunning ? "pause" : "resume"} <span>·</span>{" "}
      <span className="text-[var(--text-secondary)]">[Enter]</span> mark{" "}
      <span>·</span>{" "}
      <span className="text-[var(--text-secondary)]">[Esc]</span> stop
    </div>
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
  if (isIdle) {
    if (mode === "pomodoro") {
      return formatTime(
        Math.max(1, Math.round((config?.pomodoro.focus_duration ?? 25) * 60)),
      );
    }
    if (mode === "countdown") {
      return formatTime((config?.core.countdown_default_min ?? 60) * 60);
    }
    return formatTime(0);
  }

  if (hasTarget && intervalRemaining != null) {
    return formatTime(intervalRemaining);
  }
  return formatTime(elapsedSec);
}
