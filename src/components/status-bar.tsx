import type { TimerStateView } from "../lib/types";
import { MODE_LABELS, type Mode } from "../lib/types";
import { formatTime } from "../lib/format";

interface StatusBarProps {
  state: TimerStateView | null;
  selectedMode: Mode;
}

export function StatusBar({ state, selectedMode }: StatusBarProps) {
  if (!state) return null;
  const mode = (state.status === "idle" ? selectedMode : state.mode) as Mode;
  const label = MODE_LABELS[mode] ?? mode;

  return (
    <div className="flex items-center justify-between border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-1.5 font-mono text-[11px] text-[var(--text-secondary)]">
      <div className="flex items-center gap-3">
        <span className="uppercase tracking-wider">{label}</span>
        <span className="text-[var(--text-muted)]">·</span>
        <span className="capitalize">{state.status}</span>
      </div>
      <div className="flex items-center gap-4">
        <span>Q: {state.questions_done}</span>
        <span>{formatTime(state.elapsed_sec)}</span>
      </div>
    </div>
  );
}
