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
  LifetimeTotals,
  RangeStats,
  TagShare,
  TodayStats,
} from "../lib/types";
import { chartColors, type ChartColors } from "../lib/chart-colors";
import { StatsHeatmap } from "./stats-heatmap";

type StatsTab = "today" | "week" | "month" | "map";

export function StatsDashboard() {
  const [tab, setTab] = useState<StatsTab>("today");
  const [today, setToday] = useState<TodayStats | null>(null);
  const [week, setWeek] = useState<RangeStats | null>(null);
  const [month, setMonth] = useState<RangeStats | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapCell[] | null>(null);
  const [lifetime, setLifetime] = useState<LifetimeTotals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const colors = chartColors();

  const load = useCallback(async () => {
    try {
      const [t, w, m, h, l] = await Promise.all([
        invoke<TodayStats>("stats_today"),
        invoke<RangeStats>("stats_range", { scope: "week" }),
        invoke<RangeStats>("stats_range", { scope: "month" }),
        invoke<HeatmapCell[]>("stats_heatmap", { days: 182 }),
        invoke<LifetimeTotals>("stats_lifetime"),
      ]);
      setToday(t);
      setWeek(w);
      setMonth(m);
      setHeatmap(h);
      setLifetime(l);
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
    window.addEventListener("flint:plugin:stats:refresh", handler);
    return () =>
      window.removeEventListener("flint:plugin:stats:refresh", handler);
  }, [load]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--border)] px-3 pt-3 pb-0">
        <div className="flex items-center justify-between pb-2">
          <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]">
            STATS
          </div>
          <button
            onClick={load}
            className="text-[10px] text-[var(--text-muted)] transition-colors duration-100 ease-out hover:text-[var(--text-bright)]"
            title="Refresh"
          >
            ↻
          </button>
        </div>
        <div className="flex items-center gap-4">
          <Tab
            label="TODAY"
            active={tab === "today"}
            onClick={() => setTab("today")}
          />
          <Tab label="7D" active={tab === "week"} onClick={() => setTab("week")} />
          <Tab
            label="MONTH"
            active={tab === "month"}
            onClick={() => setTab("month")}
          />
          <Tab label="MAP" active={tab === "map"} onClick={() => setTab("map")} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {error && (
          <p className="text-[11px] text-[var(--status-error)]">{error}</p>
        )}
        {tab === "today" && <TodayView stats={today} />}
        {tab === "week" && (
          <RangeView stats={week} scope="week" colors={colors} />
        )}
        {tab === "month" && (
          <RangeView stats={month} scope="month" colors={colors} />
        )}
        {tab === "map" && <HeatmapView cells={heatmap} lifetime={lifetime} />}
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
      className="relative pb-2 text-[10px] uppercase tracking-[0.18em] transition-colors duration-100 ease-out"
      style={{
        color: active ? "var(--text-bright)" : "var(--text-muted)",
      }}
    >
      {label}
      <span
        className="absolute -bottom-[1px] left-0 right-0 h-[1px]"
        style={{ background: active ? "var(--accent)" : "transparent" }}
      />
    </button>
  );
}

function TodayView({ stats }: { stats: TodayStats | null }) {
  if (!stats) {
    return <p className="text-[11px] text-[var(--text-muted)]">loading…</p>;
  }
  return (
    <div className="space-y-4">
      <SummaryLine
        items={[
          ["FOCUS", formatHoursMinutes(stats.focus_sec)],
          ["SESSIONS", stats.session_count.toString()],
        ]}
      />
      {stats.focus_sec === 0 && (
        <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">
          # no focus yet today. press space to begin.
        </p>
      )}
    </div>
  );
}

function RangeView({
  stats,
  scope,
  colors,
}: {
  stats: RangeStats | null;
  scope: "week" | "month";
  colors: ChartColors;
}) {
  if (!stats) {
    return <p className="text-[11px] text-[var(--text-muted)]">loading…</p>;
  }
  const avg =
    stats.daily.length > 0
      ? Math.round(stats.total_focus_sec / stats.daily.length)
      : 0;
  return (
    <div className="space-y-4">
      <SummaryLine
        items={[
          ["FOCUS", formatHoursMinutes(stats.total_focus_sec)],
          ["SESS", stats.total_sessions.toString()],
          ["AVG", formatHoursMinutes(avg)],
          ["STREAK", `${stats.current_streak}D`],
        ]}
      />
      {stats.longest_streak > stats.current_streak && (
        <p className="text-[10px] text-[var(--text-muted)]">
          # best streak: {stats.longest_streak}d
        </p>
      )}

      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
          DAILY_FOCUS
        </div>
        <DailyBarChart buckets={stats.daily} scope={scope} colors={colors} />
      </div>

      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
          TAG_DISTRIBUTION
        </div>
        <TagDistribution tags={stats.tags} />
      </div>
    </div>
  );
}

function HeatmapView({
  cells,
  lifetime,
}: {
  cells: HeatmapCell[] | null;
  lifetime: LifetimeTotals | null;
}) {
  if (!cells) {
    return <p className="text-[11px] text-[var(--text-muted)]">loading…</p>;
  }
  const total = cells.reduce((acc, c) => acc + c.focus_sec, 0);
  const active = cells.filter((c) => c.focus_sec > 0).length;
  return (
    <div className="space-y-4">
      <SummaryLine
        items={[
          ["ACTIVE", `${active}D`],
          ["FOCUS", formatHoursMinutes(total)],
        ]}
      />
      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
          LAST_26_WEEKS
        </div>
        <StatsHeatmap cells={cells} />
      </div>
      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
          ALL_TIME
        </div>
        <div className="space-y-1 pl-[4px] text-[11px]">
          <KVLine
            k="longest_session"
            v={
              lifetime && lifetime.longest_session_sec > 0
                ? formatHoursMinutes(lifetime.longest_session_sec)
                : "—"
            }
          />
          <KVLine
            k="best_day"
            v={
              lifetime && lifetime.best_day_date
                ? `${formatHoursMinutes(lifetime.best_day_focus_sec)} (${formatBestDay(
                    lifetime.best_day_date,
                  )})`
                : "—"
            }
          />
          <KVLine
            k="all_time_focus"
            v={lifetime ? formatHoursMinutes(lifetime.all_time_focus_sec) : "—"}
          />
        </div>
      </div>
    </div>
  );
}

function SummaryLine({ items }: { items: [string, string][] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] tabular-nums">
      {items.map(([k, v]) => (
        <span key={k}>
          <span className="text-[var(--text-muted)]">{k}:</span>{" "}
          <span className="text-[var(--accent)]">{v}</span>
        </span>
      ))}
    </div>
  );
}

function KVLine({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between text-[11px]">
      <span className="text-[var(--text-secondary)]">
        <span className="text-[var(--text-muted)]">· </span>
        {k}
      </span>
      <span className="text-[var(--text-primary)] tabular-nums">{v}</span>
    </div>
  );
}

function formatBestDay(date: string): string {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function DailyBarChart({
  buckets,
  scope,
  colors,
}: {
  buckets: RangeStats["daily"];
  scope: "week" | "month";
  colors: ChartColors;
}) {
  if (buckets.length === 0) {
    return <p className="text-[11px] text-[var(--text-muted)]">no data.</p>;
  }
  const data = buckets.map((b) => ({
    label: formatAxisLabel(b.date, scope),
    date: b.date,
    minutes: Math.round(b.focus_sec / 60),
    focus_sec: b.focus_sec,
    session_count: b.session_count,
  }));
  return (
    <div className="h-28 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid
            stroke={colors.border}
            strokeDasharray="0"
            vertical={false}
          />
          <XAxis
            dataKey="label"
            stroke={colors.secondary}
            fontSize={9}
            fontFamily="'JetBrains Mono', monospace"
            tickLine={false}
            axisLine={{ stroke: colors.border }}
            interval="preserveStartEnd"
          />
          <YAxis
            stroke={colors.secondary}
            fontSize={9}
            fontFamily="'JetBrains Mono', monospace"
            tickLine={false}
            axisLine={{ stroke: colors.border }}
            width={22}
            tickFormatter={(v) => (v >= 60 ? `${Math.round(v / 60)}h` : `${v}m`)}
          />
          <Tooltip
            cursor={{ fill: colors.bgElevated }}
            contentStyle={{
              background: colors.bgVoid,
              border: `1px solid ${colors.borderFocus}`,
              borderRadius: 0,
              fontSize: 10,
              fontFamily: "'JetBrains Mono', monospace",
              color: colors.textBright,
              padding: "3px 6px",
              boxShadow: "none",
              letterSpacing: "0.04em",
            }}
            labelStyle={{
              color: colors.muted,
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              fontSize: 9,
            }}
            formatter={(value) => [`${Number(value) || 0}m`, "focus"]}
          />
          <Bar dataKey="minutes" radius={[0, 0, 0, 0]}>
            {data.map((d, i) => (
              <Cell
                key={i}
                fill={d.minutes > 0 ? colors.accent : colors.border}
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
    return <p className="text-[11px] text-[var(--text-muted)]">no tags.</p>;
  }
  const total = tags.reduce((acc, t) => acc + t.focus_sec, 0) || 1;
  return (
    <div className="space-y-1">
      {tags.slice(0, 6).map((t) => {
        const pct = Math.round((t.focus_sec / total) * 100);
        return (
          <div key={t.tag} className="space-y-0.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="truncate text-[var(--accent)]">[{t.tag}]</span>
              <span className="text-[10px] tabular-nums text-[var(--text-secondary)]">
                {formatHoursMinutes(t.focus_sec)} · {pct}%
              </span>
            </div>
            <div className="h-[2px] bg-[var(--border-subtle)]">
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

function formatHoursMinutes(sec: number): string {
  if (sec <= 0) return "0m";
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}m`;
  if (rem === 0) return `${h}h`;
  return `${h}h${rem}m`;
}

function formatAxisLabel(date: string, scope: "week" | "month"): string {
  const d = new Date(`${date}T00:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  if (scope === "week") {
    return ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][d.getDay()];
  }
  return `${d.getDate()}`;
}
