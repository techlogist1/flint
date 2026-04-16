import type { Mode } from "../lib/types";
import { fallbackModeLabel } from "../lib/types";
import { formatTime, isBreakInterval } from "../lib/format";
import { useTickState, type MetaState } from "../hooks/use-timer";
import { usePlugins, useTimerModes } from "./plugin-host";

interface StatusBarProps {
  meta: MetaState | null;
  selectedMode: Mode;
}

export function StatusBar({ meta, selectedMode }: StatusBarProps) {
  const timerModes = useTimerModes();
  const { slots } = usePlugins();
  const pluginEntries = slots["status-bar"] ?? [];

  if (!meta) return null;
  const mode = meta.status === "idle" ? selectedMode : meta.mode;
  const label =
    timerModes.find((m) => m.id === mode)?.label ?? fallbackModeLabel(mode);

  const intervalType = meta.current_interval?.type ?? null;
  const dotColor =
    meta.status === "paused"
      ? "var(--status-paused)"
      : meta.status === "running"
        ? isBreakInterval(intervalType)
          ? "var(--status-break)"
          : "var(--status-running)"
        : "var(--status-idle)";

  return (
    <div
      className="flex items-center justify-between border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 text-[10px] uppercase tracking-[0.14em] text-[var(--text-secondary)]"
      style={{ height: 24 }}
    >
      <div className="flex items-center gap-3">
        <span
          className="inline-block h-[6px] w-[6px]"
          style={{
            background: dotColor,
            borderRadius: 9999,
            animation:
              meta.status === "running"
                ? "flint-blink 1.2s steps(2) infinite"
                : "none",
          }}
        />
        <span className="text-[var(--text-primary)]">{label.toUpperCase()}</span>
        <span className="text-[var(--text-muted)]">·</span>
        <span>{meta.status.toUpperCase()}</span>
        {pluginEntries.length > 0 && (
          <>
            <span className="text-[var(--text-muted)]">·</span>
            <div className="flex items-center gap-3">
              {pluginEntries.map((entry) => (
                <span
                  key={entry.pluginId}
                  className="normal-case tracking-normal text-[var(--text-secondary)]"
                  style={{ letterSpacing: "0.04em" }}
                  title={entry.pluginId}
                >
                  {entry.text}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-4 tabular-nums">
        <span>
          <span className="text-[var(--text-muted)]">Q</span>{" "}
          <span className="text-[var(--text-primary)]">
            {meta.questions_done}
          </span>
        </span>
        <ElapsedText />
      </div>
    </div>
  );
}

function ElapsedText() {
  const tick = useTickState();
  return (
    <span className="text-[var(--text-primary)]">
      {formatTime(tick.elapsed_sec)}
    </span>
  );
}
