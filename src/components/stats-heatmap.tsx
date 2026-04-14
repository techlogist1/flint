import { useMemo } from "react";
import type { HeatmapCell } from "../lib/types";

interface StatsHeatmapProps {
  cells: HeatmapCell[];
}

interface WeekColumn {
  weekStart: Date;
  days: (HeatmapCell | null)[];
}

const CELL = 11;
const GAP = 2;
const LABEL_H = 14;

export function StatsHeatmap({ cells }: StatsHeatmapProps) {
  const { columns, maxFocus, monthLabels } = useMemo(() => build(cells), [cells]);

  if (cells.length === 0) {
    return (
      <p className="text-[11px] text-[var(--text-muted)]">No data yet.</p>
    );
  }

  const naturalWidth = Math.max(1, columns.length * (CELL + GAP) - GAP);
  const naturalHeight = 7 * (CELL + GAP) - GAP + LABEL_H;

  return (
    <div className="space-y-1">
      <svg
        viewBox={`0 0 ${naturalWidth} ${naturalHeight}`}
        preserveAspectRatio="xMinYMin meet"
        role="img"
        aria-label="Focus time heatmap"
        className="block h-auto w-full"
      >
        {monthLabels.map((label, idx) => (
          <text
            key={idx}
            x={label.x * (CELL + GAP)}
            y={10}
            fontSize={9}
            fill="#555555"
            fontFamily="ui-monospace, monospace"
          >
            {label.text}
          </text>
        ))}
        <g transform={`translate(0, ${LABEL_H})`}>
          {columns.map((col, colIdx) => (
            <g key={colIdx} transform={`translate(${colIdx * (CELL + GAP)}, 0)`}>
              {col.days.map((day, dayIdx) => (
                <rect
                  key={dayIdx}
                  x={0}
                  y={dayIdx * (CELL + GAP)}
                  width={CELL}
                  height={CELL}
                  rx={2}
                  ry={2}
                  fill={cellColor(day, maxFocus)}
                >
                  {day && (
                    <title>
                      {day.date}
                      {day.focus_sec > 0
                        ? ` · ${formatFocus(day.focus_sec)}`
                        : " · no focus"}
                    </title>
                  )}
                </rect>
              ))}
            </g>
          ))}
        </g>
      </svg>
      <Legend />
    </div>
  );
}

function build(cells: HeatmapCell[]): {
  columns: WeekColumn[];
  maxFocus: number;
  monthLabels: { x: number; text: string }[];
} {
  if (cells.length === 0) {
    return { columns: [], maxFocus: 0, monthLabels: [] };
  }
  // Align to weeks: first column starts on the Sunday <= first cell's date.
  const first = new Date(`${cells[0].date}T00:00:00`);
  const start = new Date(first);
  start.setDate(start.getDate() - start.getDay()); // back to Sunday

  const last = new Date(`${cells[cells.length - 1].date}T00:00:00`);
  const end = new Date(last);
  end.setDate(end.getDate() + (6 - end.getDay())); // forward to Saturday

  const totalDays =
    Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const totalWeeks = Math.ceil(totalDays / 7);

  const byDate = new Map<string, HeatmapCell>();
  for (const c of cells) byDate.set(c.date, c);

  let maxFocus = 0;
  const columns: WeekColumn[] = [];
  const monthLabels: { x: number; text: string }[] = [];
  let lastMonth = -1;

  for (let w = 0; w < totalWeeks; w++) {
    const weekStart = new Date(start);
    weekStart.setDate(weekStart.getDate() + w * 7);
    const days: (HeatmapCell | null)[] = [];
    for (let d = 0; d < 7; d++) {
      const cursor = new Date(weekStart);
      cursor.setDate(cursor.getDate() + d);
      const iso = toIso(cursor);
      const match = byDate.get(iso) ?? null;
      if (match && match.focus_sec > maxFocus) maxFocus = match.focus_sec;
      days.push(match);
    }
    columns.push({ weekStart, days });
    const m = weekStart.getMonth();
    if (m !== lastMonth) {
      monthLabels.push({
        x: w,
        text: weekStart.toLocaleString(undefined, { month: "short" }),
      });
      lastMonth = m;
    }
  }

  return { columns, maxFocus, monthLabels };
}

function cellColor(day: HeatmapCell | null, max: number): string {
  if (!day || day.focus_sec <= 0 || max <= 0) return "#2d2d2d";
  const ratio = Math.min(1, day.focus_sec / max);
  if (ratio < 0.25) return "#22c55e40";
  if (ratio < 0.5) return "#22c55e70";
  if (ratio < 0.75) return "#22c55ea0";
  return "#22c55e";
}

function Legend() {
  const levels = ["#2d2d2d", "#22c55e40", "#22c55e70", "#22c55ea0", "#22c55e"];
  return (
    <div className="flex items-center justify-end gap-1 text-[9px] text-[var(--text-muted)]">
      <span>less</span>
      {levels.map((c) => (
        <span
          key={c}
          className="inline-block h-2 w-2 rounded-sm"
          style={{ backgroundColor: c }}
        />
      ))}
      <span>more</span>
    </div>
  );
}

function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatFocus(sec: number): string {
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}
