import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { IntervalView, SessionDetail as SessionDetailType } from "../lib/types";
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
      <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
        <h2 className="text-lg font-medium text-[var(--text-primary)]">
          Session
        </h2>
        <button
          onClick={onClose}
          className="rounded px-2 py-1 text-xs text-[var(--text-secondary)] transition-colors duration-150 ease-out hover:text-[var(--text-primary)]"
          title="Close (Esc)"
        >
          Close · Esc
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-2xl space-y-6">
          {loading && (
            <p className="text-xs text-[var(--text-muted)]">Loading…</p>
          )}
          {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
          {!loading && !error && !detail && (
            <p className="text-xs text-[var(--text-muted)]">
              Session not found. It may have been deleted from disk.
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
  const dateLabel = started.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const range = `${formatClock(started)} → ${formatClock(ended)}`;

  return (
    <>
      <div className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-5">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
          <span>{detail.mode}</span>
          {!detail.completed && (
            <span className="rounded border border-[var(--warning)] bg-[var(--warning)]/10 px-1.5 py-0.5 text-[var(--warning)]">
              cancelled
            </span>
          )}
        </div>
        <div className="mt-3 font-mono text-5xl tabular-nums text-[var(--text-primary)]">
          {formatTime(detail.duration_sec)}
        </div>
        <div className="mt-2 text-xs text-[var(--text-secondary)]">
          {dateLabel} · {range}
        </div>
        {detail.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {detail.tags.map((t) => (
              <span
                key={t}
                className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-secondary)]"
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatCell label="Questions" value={`${detail.questions_done}`} />
        <StatCell
          label="Focus time"
          value={formatTime(computeFocusSec(detail.intervals, detail.duration_sec))}
        />
        <StatCell label="Intervals" value={`${detail.intervals.length || 1}`} />
      </div>

      <section className="space-y-3">
        <h3 className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
          Interval breakdown
        </h3>
        <IntervalBreakdown intervals={detail.intervals} total={detail.duration_sec} />
      </section>
    </>
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
      <p className="text-xs text-[var(--text-muted)]">
        No intervals recorded for this session.
      </p>
    );
  }
  const span = Math.max(total, 1);
  return (
    <div className="space-y-2">
      <div className="flex h-3 w-full overflow-hidden rounded border border-[var(--border)] bg-[var(--bg-elevated)]">
        {intervals.map((iv, idx) => {
          const width = Math.max(
            0,
            Math.min(100, ((iv.end_sec - iv.start_sec) / span) * 100),
          );
          return (
            <div
              key={idx}
              className={
                iv.type === "focus"
                  ? "bg-[var(--accent)]"
                  : "bg-[var(--text-muted)]"
              }
              style={{ width: `${width}%` }}
              title={`${iv.type} · ${formatTime(iv.end_sec - iv.start_sec)}`}
            />
          );
        })}
      </div>
      <ul className="divide-y divide-[var(--border)] rounded border border-[var(--border)] bg-[var(--bg-secondary)]">
        {intervals.map((iv, idx) => (
          <li
            key={idx}
            className="flex items-center justify-between px-3 py-2 text-xs"
          >
            <span className="flex items-center gap-2">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  iv.type === "focus"
                    ? "bg-[var(--accent)]"
                    : "bg-[var(--text-muted)]"
                }`}
              />
              <span className="capitalize text-[var(--text-primary)]">
                {iv.type}
              </span>
            </span>
            <span className="font-mono text-[var(--text-secondary)]">
              {formatTime(iv.end_sec - iv.start_sec)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-3">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
        {label}
      </div>
      <div className="mt-1 font-mono text-xl text-[var(--text-primary)]">
        {value}
      </div>
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
