import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  IntervalView,
  SessionDetail as SessionDetailType,
} from "../lib/types";
import { formatTime } from "../lib/format";

interface SessionDetailProps {
  sessionId: string;
  onClose: () => void;
}

export function SessionDetailPanel({ sessionId, onClose }: SessionDetailProps) {
  const [detail, setDetail] = useState<SessionDetailType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    setError(null);
    invoke<SessionDetailType | null>("cache_session_detail", {
      id: sessionId,
    })
      .then((result) => {
        if (canceled) return;
        setDetail(result);
        setLoading(false);
      })
      .catch((e) => {
        if (canceled) return;
        setError(String(e));
        setLoading(false);
      });
    return () => {
      canceled = true;
    };
  }, [sessionId]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-3">
        <h2 className="text-[13px] uppercase tracking-[0.18em] text-[var(--text-bright)]">
          SESSION
        </h2>
        <button
          onClick={onClose}
          className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)] transition-colors duration-100 ease-out hover:text-[var(--text-bright)]"
          title="Close (Esc)"
        >
          [ESC] CLOSE
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-2xl space-y-8">
          {loading && (
            <p className="text-[11px] text-[var(--text-muted)]">loading…</p>
          )}
          {error && (
            <p className="text-[11px] text-[var(--status-error)]">{error}</p>
          )}
          {!loading && !error && !detail && (
            <p className="text-[11px] text-[var(--text-muted)]">
              session not found. may have been deleted from disk.
            </p>
          )}
          {detail && <DetailBody detail={detail} />}
        </div>
      </div>
    </div>
  );
}

function DetailBody({ detail }: { detail: SessionDetailType }) {
  const started = new Date(detail.started_at);
  const ended = new Date(detail.ended_at);
  const dateLabel = started.toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const range = `${formatClock(started)} → ${formatClock(ended)}`;
  const focusSec = computeFocusSec(detail.intervals, detail.duration_sec);

  return (
    <>
      <section className="space-y-4">
        <div className="flex items-baseline gap-3 text-[10px] uppercase tracking-[0.2em]">
          <span className="text-[var(--accent)]">
            {detail.mode.toUpperCase()}
          </span>
          {!detail.completed && (
            <span className="text-[var(--status-error)]">× CANCELLED</span>
          )}
        </div>
        <div
          className="tabular-nums"
          style={{
            fontSize: "clamp(42px, 10vw, 72px)",
            fontWeight: 500,
            lineHeight: 1,
            letterSpacing: "-0.03em",
            color: "var(--text-bright)",
          }}
        >
          {formatTime(detail.duration_sec)}
        </div>
        <div className="text-[11px] text-[var(--text-secondary)]">
          {dateLabel.toLowerCase()} · {range}
        </div>
        {detail.tags.length > 0 && (
          <div className="flex flex-wrap gap-2 text-[11px]">
            {detail.tags.map((t) => (
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
      </section>

      <section className="space-y-2">
        <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
          <span>## </span>STATS
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 border-t border-[var(--border)] pt-2 text-[11px] tabular-nums">
          <StatItem label="QUESTIONS" value={String(detail.questions_done)} />
          <StatItem label="FOCUS" value={formatTime(focusSec)} />
          <StatItem
            label="INTERVALS"
            value={String(detail.intervals.length || 1)}
          />
        </div>
      </section>

      <section className="space-y-3">
        <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
          <span>## </span>INTERVAL_BREAKDOWN
        </div>
        <div className="border-t border-[var(--border)] pt-2">
          <IntervalBreakdown
            intervals={detail.intervals}
            total={detail.duration_sec}
          />
        </div>
      </section>
    </>
  );
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-[var(--text-muted)]">{label}:</span>{" "}
      <span className="text-[var(--text-bright)]">{value}</span>
    </span>
  );
}

function IntervalBreakdown({
  intervals,
  total,
}: {
  intervals: IntervalView[];
  total: number;
}) {
  if (intervals.length === 0) {
    return (
      <p className="text-[11px] text-[var(--text-muted)]">
        no intervals recorded.
      </p>
    );
  }
  const span = Math.max(total, 1);
  return (
    <div className="space-y-3">
      <div
        className="flex h-[4px] w-full overflow-hidden"
        style={{ background: "var(--border-subtle)" }}
      >
        {intervals.map((iv, idx) => {
          const width = Math.max(
            0,
            Math.min(100, ((iv.end_sec - iv.start_sec) / span) * 100),
          );
          return (
            <div
              key={idx}
              style={{
                width: `${width}%`,
                background:
                  iv.type === "focus"
                    ? "var(--accent)"
                    : "var(--status-break)",
              }}
              title={`${iv.type} · ${formatTime(iv.end_sec - iv.start_sec)}`}
            />
          );
        })}
      </div>
      <ul className="space-y-[2px] text-[11px]">
        {intervals.map((iv, idx) => (
          <li
            key={idx}
            className="flex items-center justify-between tabular-nums"
          >
            <span className="flex items-center gap-2">
              <span
                className="inline-block h-[6px] w-[6px]"
                style={{
                  borderRadius: 9999,
                  background:
                    iv.type === "focus"
                      ? "var(--accent)"
                      : "var(--status-break)",
                }}
              />
              <span className="uppercase tracking-[0.14em] text-[var(--text-secondary)]">
                {iv.type}
              </span>
            </span>
            <span className="text-[var(--text-primary)]">
              {formatTime(iv.end_sec - iv.start_sec)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function formatClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

function computeFocusSec(intervals: IntervalView[], fallback: number): number {
  if (intervals.length === 0) return fallback;
  const focus = intervals
    .filter((i) => i.type === "focus")
    .reduce((acc, i) => acc + Math.max(0, i.end_sec - i.start_sec), 0);
  return focus || fallback;
}
