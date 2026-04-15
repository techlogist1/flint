import { useMemo } from "react";
import type { Preset } from "../lib/presets";

interface QuickStartBarProps {
  presets: Preset[];
  onLoad: (preset: Preset) => void;
}

/**
 * Idle-view quick-start strip: the pinned presets the user wants one-click
 * access to. Number keys 1..4 map to these slots. If the user has no
 * presets yet, the strip renders a muted hint pointing them at the
 * "Create Preset" command.
 */
export function QuickStartBar({ presets, onLoad }: QuickStartBarProps) {
  const pinned = useMemo(
    () =>
      presets
        .filter((p) => p.pinned)
        .sort((a, b) => a.sort_order - b.sort_order)
        .slice(0, 4),
    [presets],
  );

  if (pinned.length === 0) {
    return (
      <div className="text-[11px] lowercase tracking-wide text-[var(--text-muted)]">
        no presets yet ·{" "}
        <span className="text-[var(--text-secondary)]">[Ctrl+P]</span>{" "}
        <span className="text-[var(--text-secondary)]">&quot;create preset&quot;</span>{" "}
        to get started
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-[10px] text-[11px]">
      {pinned.map((preset, idx) => (
        <button
          key={preset.id}
          onClick={() => onLoad(preset)}
          className="group flex items-center gap-[6px] border border-[var(--border-focus)] bg-[var(--bg-elevated)] px-[10px] py-[4px] text-[var(--text-primary)] transition-colors duration-100 ease-out hover:border-[var(--accent)] hover:text-[var(--accent-bright)]"
          title={`${preset.plugin_id} · ${preset.tags.join(", ") || "no tags"}`}
          style={{ letterSpacing: "0.02em" }}
        >
          <span
            className="text-[9px] text-[var(--text-muted)] group-hover:text-[var(--accent)]"
            style={{ lineHeight: 1 }}
          >
            [{idx + 1}]
          </span>
          <span className="uppercase">{preset.name}</span>
        </button>
      ))}
    </div>
  );
}
