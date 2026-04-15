import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CachedSession } from "../lib/types";
import { formatTime } from "../lib/format";

type DateRange = "all" | "today" | "week" | "month";

interface SessionLogProps {
  activeSessionId: string | null;
  onOpenSession: (id: string) => void;
}

export function SessionLog({ activeSessionId, onOpenSession }: SessionLogProps) {
  const [sessions, setSessions] = useState<CachedSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<DateRange>("all");
  // PR-H5: roving tabindex for keyboard nav. `focusedIndex` is the index
  // of the currently-focusable session row; ArrowUp/ArrowDown move it,
  // Enter opens the focused session. Resets to 0 whenever the filter
  // or underlying list length changes so a shrunk list never traps
  // focus on a removed index.
  const [focusedIndex, setFocusedIndex] = useState(0);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const load = useCallback(async () => {
    try {
      const list = await invoke<CachedSession[]>("cache_list_sessions", {
        limit: null,
      });
      setSessions(list);
      setError(null);
    } catch (e) {
      setError(String(e));
      setSessions([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    // S-C1: built-in plugins emit refresh hints via `flint.emit`, which
    // dispatches a CustomEvent on the host window with the `flint:plugin:`
    // prefix. The plugin sandbox can't reach `window` directly.
    const handler = () => {
      load();
    };
    window.addEventListener("flint:plugin:sessions:refresh", handler);
    return () => {
      window.removeEventListener("flint:plugin:sessions:refresh", handler);
    };
  }, [load]);

  const filtered = useMemo(() => {
    if (!sessions) return [];
    const q = query.trim().toLowerCase();
    const cutoff = rangeCutoff(range);
    return sessions.filter((s) => {
      if (cutoff != null && Date.parse(s.started_at) < cutoff) return false;
      if (!q) return true;
      if (s.tags.some((t) => t.toLowerCase().includes(q))) return true;
      if (s.mode.toLowerCase().includes(q)) return true;
      if (s.id.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [sessions, query, range]);

  useEffect(() => {
    setFocusedIndex(0);
  }, [query, range, filtered.length]);

  const onRowKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>, idx: number) => {
      if (filtered.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = Math.min(filtered.length - 1, idx + 1);
        setFocusedIndex(next);
        itemRefs.current[next]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const prev = Math.max(0, idx - 1);
        setFocusedIndex(prev);
        itemRefs.current[prev]?.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        setFocusedIndex(0);
        itemRefs.current[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        const last = filtered.length - 1;
        setFocusedIndex(last);
        itemRefs.current[last]?.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const s = filtered[idx];
        if (s) onOpenSession(s.id);
      }
    },
    [filtered, onOpenSession],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-[var(--border)] px-3 pb-3 pt-2">
        <div className="flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
            Session Log
          </div>
          {sessions && (
            <div className="font-mono text-[10px] text-[var(--text-muted)]">
              {filtered.length}/{sessions.length}
            </div>
          )}
        </div>
        <input
          type="search"
          data-flint-input="true"
          placeholder="Filter tags…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors duration-150 ease-out focus:border-[var(--accent)]"
        />
        <div className="flex flex-wrap gap-1">
          {(["all", "today", "week", "month"] as DateRange[]).map((r) => (
            <RangeChip
              key={r}
              label={rangeLabel(r)}
              active={range === r}
              onClick={() => setRange(r)}
            />
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {error && (
          <p className="px-2 text-[11px] text-[var(--danger)]">{error}</p>
        )}
        {sessions == null && !error && (
          <p className="px-2 text-[11px] text-[var(--text-muted)]">Loading…</p>
        )}
        {sessions != null && filtered.length === 0 && !error && (
          <p className="px-2 text-[11px] text-[var(--text-muted)]">
            {sessions.length === 0
              ? "No sessions yet. Press Space to start your first focus block."
              : "No sessions match this filter."}
          </p>
        )}
        <ul className="space-y-1" role="listbox" aria-label="Sessions">
          {filtered.map((s, idx) => (
            <li key={s.id} role="option" aria-selected={idx === focusedIndex}>
              <SessionRow
                ref={(el) => {
                  itemRefs.current[idx] = el;
                }}
                session={s}
                active={s.id === activeSessionId}
                focused={idx === focusedIndex}
                tabIndex={idx === focusedIndex ? 0 : -1}
                onClick={() => onOpenSession(s.id)}
                onFocus={() => setFocusedIndex(idx)}
                onKeyDown={(e) => onRowKeyDown(e, idx)}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function RangeChip({
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

interface SessionRowProps {
  session: CachedSession;
  active: boolean;
  focused: boolean;
  tabIndex: number;
  onClick: () => void;
  onFocus: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
}

const SessionRow = forwardRef<HTMLButtonElement, SessionRowProps>(
  function SessionRow(
    { session, active, focused, tabIndex, onClick, onFocus, onKeyDown },
    ref,
  ) {
    const date = formatRelativeDate(session.started_at);
    const duration = formatTime(session.duration_sec);
    const primaryTag = session.tags[0];
    const extraTags =
      session.tags.length > 1 ? `+${session.tags.length - 1}` : "";

    // PR-H5: visible focus ring when the row is the roving-tabindex
    // target, regardless of whether it also happens to be the
    // currently-selected (active) session. Active still paints the
    // accent background; focused adds an extra ring so the user can
    // tell at a glance where arrow-key focus is.
    const borderClass = active
      ? "border border-[var(--accent)] bg-[var(--accent-subtle)]"
      : focused
        ? "border border-[var(--accent)] bg-[var(--bg-elevated)]"
        : "border border-transparent hover:bg-[var(--bg-elevated)]";

    return (
      <button
        ref={ref}
        tabIndex={tabIndex}
        onClick={onClick}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        className={`flex w-full flex-col items-start gap-0.5 rounded px-2 py-1.5 text-left transition-colors duration-100 ease-out outline-none ${borderClass}`}
      >
        <div className="flex w-full items-center justify-between gap-2 text-[11px]">
          <span className="truncate text-[var(--text-primary)]">
            {primaryTag ?? "untagged"}
            {extraTags && (
              <span className="ml-1 text-[var(--text-muted)]">{extraTags}</span>
            )}
          </span>
          <span className="font-mono text-[10px] text-[var(--text-secondary)]">
            {duration}
          </span>
        </div>
        <div className="flex w-full items-center justify-between text-[10px] text-[var(--text-muted)]">
          <span>{date}</span>
          <span className="flex items-center gap-2 font-mono">
            {session.questions_done > 0 && (
              <span>Q:{session.questions_done}</span>
            )}
            <span className="uppercase tracking-wide">
              {session.mode.slice(0, 3)}
            </span>
            {!session.completed && (
              <span className="uppercase tracking-wide text-[var(--warning)]">
                cancel
              </span>
            )}
          </span>
        </div>
      </button>
    );
  },
);

function rangeCutoff(range: DateRange): number | null {
  if (range === "all") return null;
  const now = new Date();
  if (range === "today") {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return d.getTime();
  }
  if (range === "week") {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    return d.getTime();
  }
  const d = new Date(now.getFullYear(), now.getMonth(), 1);
  return d.getTime();
}

function rangeLabel(range: DateRange): string {
  switch (range) {
    case "all":
      return "All";
    case "today":
      return "Today";
    case "week":
      return "7d";
    case "month":
      return "Month";
  }
}

function formatRelativeDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86400000);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
  if (diffDays === 0) return `Today · ${hhmm}`;
  if (diffDays === 1) return `Yesterday · ${hhmm}`;
  if (diffDays < 7) return `${diffDays}d ago · ${hhmm}`;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
