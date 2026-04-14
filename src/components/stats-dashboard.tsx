import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  HeatmapCell,
  RangeStats,
  TagShare,
  TodayStats,
} from "../lib/types";
import { StatsHeatmap } from "./stats-heatmap";

type StatsTab = "today" | "week" | "month" | "map";

const ACCENT = "#22c55e";
const MUTED = "#555555";

export function StatsDashboard() {
  const [tab, setTab] = useState<StatsTab>("today");
  const [today, setToday] = useState<TodayStats | null>(null);
  const [week, setWeek] = useState<RangeStats | null>(null);
  const [month, setMonth] = useState<RangeStats | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapCell[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, w, m, h] = await Promise.all([
        invoke<TodayStats>("stats_today"),
        invoke<RangeStats>("stats_range", { scope: "week" }),
        invoke<RangeStats>("stats_range", { scope: "month" }),
        invoke<HeatmapCell[]>("stats_heatmap", { days: 182 }),
      ]);
      setToday(t);
      setWeek(w);
      setMonth(m);
      setHeatmap(h);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const handler = () => load();
    window.addEventListener("flint:stats:refresh", handler);
    return () => window.removeEventListener("flint:stats:refresh", handler);
  }, [load]);

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-[var(--border)] px-3 pb-2 pt-2">
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
            Stats
          </div>
          <button
            onClick={load}
            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            title="Refresh"
          >
            ↻
          </button>
        </div>
        <div className="flex gap-1">
          <Tab label="Today" active={tab === "today"} onClick={() => setTab("today")} />
          <Tab label="Week" active={tab === "week"} onClick={() => setTab("week")} />
          <Tab label="Month" active={tab === "month"} onClick={() => setTab("month")} />
          <Tab label="Map" active={tab === "map"} onClick={() => setTab("map")} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {error && <p className="text-[11px] text-[var(--danger)]">{error}</p>}
        {tab === "today" && <TodayView stats={today} />}
        {tab === "week" && <RangeView stats={week} scope="week" />}
        {tab === "month" && <RangeView stats={month} scope="month" />}
        {tab === "map" && <HeatmapView cells={heatmap} />}
      </div>
    </div>
  );
}

function Tab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-[10px] uppercase tracking-wide transition-colors duration-150 ease-out ${
        active
          ? "bg-[var(--accent-subtle)] text-[var(--accent)]"
          : "text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
      }`}
    >
      {label}
    </button>
  );
}

function TodayView({ stats }: { stats: TodayStats | null }) {
  if (!stats) {
    return <p className="text-[11px] text-[var(--text-muted)]">Loading…</p>;
  }
  return (
    <div className="space-y-3">
      <BigStat
        label="Focus today"
        value={formatHoursMinutes(stats.focus_sec)}
      />
      <div className="grid grid-cols-2 gap-2">
        <MetricCard
          label="Sessions"
          value={stats.session_count.toString()}
        />
        <MetricCard
          label="Questions"
          value={stats.questions_done.toString()}
        />
      </div>
      {stats.focus_sec === 0 && (
        <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
          No focus time yet today. Press Space in the timer view to begin.
        </p>
      )}
    </div>
  );
}

function RangeView({
  stats,
  scope,
}: {
  stats: RangeStats | null;
  scope: "week" | "month";
}) {
  if (!stats) {
    return <p className="text-[11px] text-[var(--text-muted)]">Loading…</p>;
  }
  const avg =
    stats.daily.length > 0
      ? Math.round(stats.total_focus_sec / stats.daily.length)
      : 0;
  return (
    <div className="space-y-4">
      <BigStat
        label={scope === "week" ? "Last 7 days" : "This month"}
        value={formatHoursMinutes(stats.total_focus_sec)}
      />
      <div className="grid grid-cols-2 gap-2">
        <MetricCard label="Sessions" value={stats.total_sessions.toString()} />
        <MetricCard
          label="Avg/day"
          value={formatHoursMinutes(avg)}
        />
        <MetricCard
          label="Streak"
          value={`${stats.current_streak}d`}
          hint={
            stats.longest_streak > stats.current_streak
              ? `best ${stats.longest_streak}d`
              : undefined
          }
        />
        <MetricCard
          label="Questions"
          value={stats.total_questions.toString()}
        />
      </div>

      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
          Daily focus
        </div>
        <DailyBarChart buckets={stats.daily} scope={scope} />
      </div>

      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
          Tag distribution
        </div>
        <TagDistribution tags={stats.tags} />
      </div>
    </div>
  );
}

function HeatmapView({ cells }: { cells: HeatmapCell[] | null }) {
  if (!cells) {
    return <p className="text-[11px] text-[var(--text-muted)]">Loading…</p>;
  }
  const total = cells.reduce((acc, c) => acc + c.focus_sec, 0);
  const active = cells.filter((c) => c.focus_sec > 0).length;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <MetricCard label="Days active" value={`${active}`} />
        <MetricCard
          label="Focus total"
          value={formatHoursMinutes(total)}
        />
      </div>
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
          Last 26 weeks
        </div>
        <StatsHeatmap cells={cells} />
      </div>
    </div>
  );
}

function DailyBarChart({
  buckets,
  scope,
}: {
  buckets: RangeStats["daily"];
  scope: "week" | "month";
}) {
  if (buckets.length === 0) {
    return (
      <p className="text-[11px] text-[var(--text-muted)]">No data yet.</p>
    );
  }
  const data = buckets.map((b) => ({
    label: formatAxisLabel(b.date, scope),
    date: b.date,
    minutes: Math.round(b.focus_sec / 60),
    focus_sec: b.focus_sec,
    session_count: b.session_count,
  }));
  return (
    <div className="h-32 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="#333333"
            vertical={false}
          />
          <XAxis
            dataKey="label"
            stroke="#555555"
            fontSize={9}
            tickLine={false}
            axisLine={{ stroke: "#333333" }}
            interval="preserveStartEnd"
          />
          <YAxis
            stroke="#555555"
            fontSize={9}
            tickLine={false}
            axisLine={{ stroke: "#333333" }}
            width={24}
            tickFormatter={(v) => (v >= 60 ? `${Math.round(v / 60)}h` : `${v}m`)}
          />
          <Tooltip
            cursor={{ fill: "#2d2d2d" }}
            contentStyle={{
              background: "#1e1e1e",
              border: "1px solid #333333",
              borderRadius: 4,
              fontSize: 11,
              color: "#e0e0e0",
              padding: "4px 8px",
            }}
            labelStyle={{ color: "#888888" }}
            formatter={(value) => [`${Number(value) || 0} min`, "Focus"]}
          />
          <Bar dataKey="minutes" radius={[2, 2, 0, 0]}>
            {data.map((d, i) => (
              <Cell
                key={i}
                fill={d.minutes > 0 ? ACCENT : MUTED}
                fillOpacity={d.minutes > 0 ? 1 : 0.3}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function TagDistribution({ tags }: { tags: TagShare[] }) {
  if (tags.length === 0) {
    return (
      <p className="text-[11px] text-[var(--text-muted)]">No tags logged yet.</p>
    );
  }
  const total = tags.reduce((acc, t) => acc + t.focus_sec, 0) || 1;
  return (
    <div className="space-y-1.5">
      {tags.slice(0, 6).map((t) => {
        const pct = Math.round((t.focus_sec / total) * 100);
        return (
          <div key={t.tag} className="space-y-0.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="truncate text-[var(--text-primary)]">
                {t.tag}
              </span>
              <span className="font-mono text-[10px] text-[var(--text-secondary)]">
                {formatHoursMinutes(t.focus_sec)} · {pct}%
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-elevated)]">
              <div
                className="h-full bg-[var(--accent)]"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
      {tags.length > 6 && (
        <p className="text-[10px] text-[var(--text-muted)]">
          +{tags.length - 6} more
        </p>
      )}
    </div>
  );
}

function BigStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </div>
      <div className="mt-1 font-mono text-2xl tabular-nums text-[var(--accent)]">
        {value}
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-2">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-sm text-[var(--text-primary)]">
        {value}
      </div>
      {hint && (
        <div className="text-[9px] text-[var(--text-muted)]">{hint}</div>
      )}
    </div>
  );
}

function formatHoursMinutes(sec: number): string {
  if (sec <= 0) return "0m";
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}m`;
  if (rem === 0) return `${h}h`;
  return `${h}h ${rem}m`;
}

function formatAxisLabel(date: string, scope: "week" | "month"): string {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  if (scope === "week") {
    return ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][d.getDay()];
  }
  return `${d.getDate()}`;
}
