import { useMemo, useState } from "react";
import type { Preset } from "../lib/presets";

interface QuickStartBarProps {
  presets: Preset[];
  onLoad: (preset: Preset) => void;
  onEdit: (preset: Preset) => void;
  onDelete: (preset: Preset) => void;
}

/**
 * Idle-view quick-start strip: the pinned presets the user wants one-click
 * access to. Number keys 1..4 map to these slots. Hover reveals edit (✎) and
 * delete (×) actions per preset — clicking delete shows an inline
 * [YES]/[NO] confirmation without breaking out to a modal. If the user has
 * no presets yet, the strip renders a muted hint pointing them at the
 * "Create Preset" command.
 */
export function QuickStartBar({
  presets,
  onLoad,
  onEdit,
  onDelete,
}: QuickStartBarProps) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
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
        <span className="text-[var(--text-secondary)]">
          &quot;create preset&quot;
        </span>{" "}
        to get started
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-center gap-[10px] text-[11px]">
      {pinned.map((preset, idx) => {
        const isConfirming = confirmId === preset.id;
        return (
          <div
            key={preset.id}
            className="group relative flex items-center gap-[2px] border border-[var(--border-focus)] bg-[var(--bg-elevated)] transition-colors duration-100 ease-out hover:border-[var(--accent)]"
            style={{ letterSpacing: "0.02em" }}
          >
            {isConfirming ? (
              <div className="flex items-center gap-2 px-[10px] py-[4px] text-[10px] uppercase tracking-[0.18em]">
                <span className="text-[var(--status-error)]">DELETE?</span>
                <button
                  onClick={() => {
                    setConfirmId(null);
                    onDelete(preset);
                  }}
                  className="text-[var(--status-error)] hover:text-[var(--text-bright)]"
                >
                  [YES]
                </button>
                <button
                  onClick={() => setConfirmId(null)}
                  className="text-[var(--text-muted)] hover:text-[var(--text-bright)]"
                >
                  [NO]
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => onLoad(preset)}
                  className="flex items-center gap-[6px] px-[10px] py-[4px] text-[var(--text-primary)] group-hover:text-[var(--accent-bright)]"
                  title={`${preset.plugin_id} · ${preset.tags.join(", ") || "no tags"}`}
                >
                  <span
                    className="text-[9px] text-[var(--text-muted)] group-hover:text-[var(--accent)]"
                    style={{ lineHeight: 1 }}
                  >
                    [{idx + 1}]
                  </span>
                  <span className="uppercase">{preset.name}</span>
                </button>
                <div className="flex items-center gap-[1px] pr-[6px] opacity-0 transition-opacity duration-100 ease-out group-hover:opacity-100 focus-within:opacity-100">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onEdit(preset);
                    }}
                    title="Edit preset"
                    aria-label={`Edit ${preset.name}`}
                    className="px-[3px] text-[10px] text-[var(--text-muted)] hover:text-[var(--text-bright)]"
                  >
                    ✎
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmId(preset.id);
                    }}
                    title="Delete preset"
                    aria-label={`Delete ${preset.name}`}
                    className="px-[3px] text-[10px] text-[var(--text-muted)] hover:text-[var(--status-error)]"
                  >
                    ×
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
