import type { Mode, TimerStateView } from "../lib/types";
import { fallbackModeLabel } from "../lib/types";
import { formatTime } from "../lib/format";
import { usePlugins, useTimerModes } from "./plugin-host";

interface StatusBarProps {
  state: TimerStateView | null;
  selectedMode: Mode;
}

export function StatusBar({ state, selectedMode }: StatusBarProps) {
  const timerModes = useTimerModes();
  const { slots } = usePlugins();
  const pluginEntries = slots["status-bar"] ?? [];

  if (!state) return null;
  const mode = state.status === "idle" ? selectedMode : state.mode;
  const label =
    timerModes.find((m) => m.id === mode)?.label ?? fallbackModeLabel(mode);

  return (
    <div className="flex items-center justify-between border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-1.5 text-[11px] text-[var(--text-secondary)]">
      <div className="flex items-center gap-3">
        <span className="uppercase tracking-wider">{label}</span>
        <span className="text-[var(--text-muted)]">·</span>
        <span className="capitalize">{state.status}</span>
        {pluginEntries.length > 0 && (
          <>
            <span className="text-[var(--text-muted)]">·</span>
            <div className="flex items-center gap-3">
              {pluginEntries.map((entry) => (
                // Plugins render into the status-bar slot by pushing HTML
                // through flint.renderSlot(). The plugin is already
                // user-installed and its JS runs in the sandbox — rendering
                // its HTML here is the declared contract.
                <span
                  key={entry.pluginId}
                  className="text-[var(--text-secondary)]"
                  title={entry.pluginId}
                  dangerouslySetInnerHTML={{ __html: entry.html }}
                />
              ))}
            </div>
          </>
        )}
      </div>
      <div className="flex items-center gap-4 font-mono tabular-nums">
        <span>Q: {state.questions_done}</span>
        <span>{formatTime(state.elapsed_sec)}</span>
      </div>
    </div>
  );
}
