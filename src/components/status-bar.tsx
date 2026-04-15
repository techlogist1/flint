import type { Mode } from "../lib/types";
import { fallbackModeLabel } from "../lib/types";
import { formatTime } from "../lib/format";
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

  return (
    <div className="flex items-center justify-between border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-1.5 text-[11px] text-[var(--text-secondary)]">
      <div className="flex items-center gap-3">
        <span className="uppercase tracking-wider">{label}</span>
        <span className="text-[var(--text-muted)]">·</span>
        <span className="capitalize">{meta.status}</span>
        {pluginEntries.length > 0 && (
          <>
            <span className="text-[var(--text-muted)]">·</span>
            <div className="flex items-center gap-3">
              {pluginEntries.map((entry) => (
                // S-C2: text-only render — React escapes the value, so a
                // plugin can no longer inject HTML/script into the host.
                <span
                  key={entry.pluginId}
                  className="text-[var(--text-secondary)]"
                  title={entry.pluginId}
                >
                  {entry.text}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-4 font-mono tabular-nums">
        <span>Q: {meta.questions_done}</span>
        <ElapsedText />
      </div>
    </div>
  );
}

/**
 * P-C2: split out the elapsed text so only this leaf re-renders on a tick.
 * The rest of StatusBar (mode/status/questions/plugin slots) only updates
 * on lifecycle events.
 */
function ElapsedText() {
  const tick = useTickState();
  return <span>{formatTime(tick.elapsed_sec)}</span>;
}
