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
  /** Called after a session has been successfully deleted. Use this to
   *  close any detail view still pointing at the removed session. */
  onSessionDeleted?: (id: string) => void;
}

export function SessionLog({
  activeSessionId,
  onOpenSession,
  onSessionDeleted,
}: SessionLogProps) {
  const [sessions, setSessions] = useState<CachedSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [range, setRange] = useState<DateRange>("all");
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [confirmId, setConfirmId] = useState<string | null>(null);
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

  const deleteSession = useCallback(
    async (id: string) => {
      try {
        await invoke("delete_session", { id });
        setConfirmId(null);
        onSessionDeleted?.(id);
        await load();
      } catch (e) {
        setError(String(e));
        setConfirmId(null);
      }
    },
    [load, onSessionDeleted],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 border-b border-[var(--border)] px-3 pb-3 pt-3">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--text-muted)]">
            SESSIONS
          </div>
          {sessions && (
            <div className="text-[10px] text-[var(--text-muted)] tabular-nums">
              {filtered.length}/{sessions.length}
            </div>
          )}
        </div>
        <input
          type="search"
          data-flint-input="true"
          placeholder="filter…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 text-[11px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors duration-100 ease-out focus:border-[var(--accent)]"
        />
        <div className="flex items-center gap-4 pt-1">
          {(["all", "today", "week", "month"] as DateRange[]).map((r) => (
            <RangeTab
              key={r}
              label={rangeLabel(r)}
              active={range === r}
              onClick={() => setRange(r)}
            />
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p className="px-3 py-2 text-[11px] text-[var(--status-error)]">
            {error}
          </p>
        )}
        {sessions == null && !error && (
          <p className="px-3 py-2 text-[11px] text-[var(--text-muted)]">
            loading…
          </p>
        )}
        {sessions != null && filtered.length === 0 && !error && (
          <p className="px-3 py-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
            {sessions.length === 0
              ? "no sessions yet — press space to start."
              : "no matches."}
          </p>
        )}
        <ul role="listbox" aria-label="Sessions">
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
                confirming={confirmId === s.id}
                onClick={() => onOpenSession(s.id)}
                onFocus={() => setFocusedIndex(idx)}
                onKeyDown={(e) => onRowKeyDown(e, idx)}
                onRequestDelete={() => setConfirmId(s.id)}
                onConfirmDelete={() => void deleteSession(s.id)}
                onCancelDelete={() => setConfirmId(null)}
              />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function RangeTab({
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
      className="relative pb-1 text-[10px] uppercase tracking-[0.18em] transition-colors duration-100 ease-out"
      style={{
        color: active ? "var(--text-bright)" : "var(--text-muted)",
      }}
    >
      {label}
      <span
        className="absolute -bottom-[4px] left-0 right-0 h-[1px]"
        style={{ background: active ? "var(--accent)" : "transparent" }}
      />
    </button>
  );
}

interface SessionRowProps {
  session: CachedSession;
  active: boolean;
  focused: boolean;
  tabIndex: number;
  confirming: boolean;
  onClick: () => void;
  onFocus: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onRequestDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

const SessionRow = forwardRef<HTMLButtonElement, SessionRowProps>(
  function SessionRow(
    {
      session,
      active,
      focused,
      tabIndex,
      confirming,
      onClick,
      onFocus,
      onKeyDown,
      onRequestDelete,
      onConfirmDelete,
      onCancelDelete,
    },
    ref,
  ) {
    const timeStr = formatTimeOfDay(session.started_at);
    const duration = formatTime(session.duration_sec);
    const modeShort = modeAbbrev(session.mode);
    const primaryTag = session.tags[0];

    // Accent-colored left border when selected; no card backgrounds.
    const leftBorder = active
      ? "border-l-[2px] border-l-[var(--accent)]"
      : focused
        ? "border-l-[2px] border-l-[var(--text-secondary)]"
        : "border-l-[2px] border-l-transparent";

    if (confirming) {
      return (
        <div
          className={`${leftBorder} flex w-full items-center gap-3 py-[6px] pl-[10px] pr-3 text-[10px] uppercase tracking-[0.14em]`}
        >
          <span
            className="tabular-nums"
            style={{ color: "var(--text-muted)", minWidth: 38 }}
          >
            {timeStr}
          </span>
          <span className="text-[var(--status-error)]">DELETE?</span>
          <button
            onClick={onConfirmDelete}
            className="text-[var(--status-error)] hover:text-[var(--text-bright)]"
          >
            [YES]
          </button>
          <button
            onClick={onCancelDelete}
            className="text-[var(--text-muted)] hover:text-[var(--text-bright)]"
          >
            [NO]
          </button>
        </div>
      );
    }

    return (
      <div
        className={`${leftBorder} group relative flex items-stretch transition-colors duration-100 ease-out hover:bg-[var(--bg-elevated)]`}
      >
        <button
          ref={ref}
          tabIndex={tabIndex}
          onClick={onClick}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
          className="flex min-w-0 flex-1 items-center gap-2 py-[6px] pl-[10px] pr-8 text-left text-[11px] leading-tight outline-none"
        >
          <span
            className="tabular-nums"
            style={{ color: "var(--text-muted)", minWidth: 38 }}
          >
            {timeStr}
          </span>
          <span
            className="tabular-nums"
            style={{ color: "var(--text-primary)", minWidth: 44 }}
          >
            {duration}
          </span>
          <span
            className="uppercase"
            style={{
              color: "var(--text-secondary)",
              letterSpacing: "0.1em",
              fontSize: 10,
              minWidth: 26,
            }}
          >
            {modeShort}
          </span>
          <span
            className="ml-auto truncate text-right"
            style={{
              color: primaryTag ? "var(--accent)" : "var(--text-muted)",
              maxWidth: "50%",
            }}
          >
            {primaryTag
              ? session.tags.length > 1
                ? `[${primaryTag}]+${session.tags.length - 1}`
                : `[${primaryTag}]`
              : "—"}
          </span>
          {!session.completed && (
            <span
              className="text-[9px] uppercase tracking-wider"
              style={{ color: "var(--status-error)" }}
            >
              ×
            </span>
          )}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRequestDelete();
          }}
          title="Delete session"
          aria-label="Delete session"
          tabIndex={-1}
          className="absolute right-[6px] top-1/2 -translate-y-1/2 px-[4px] text-[12px] leading-none text-[var(--text-muted)] opacity-0 transition-opacity duration-100 ease-out hover:text-[var(--status-error)] group-hover:opacity-100 focus:opacity-100"
        >
          ×
        </button>
      </div>
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
      return "ALL";
    case "today":
      return "TODAY";
    case "week":
      return "7D";
    case "month":
      return "MONTH";
  }
}

function formatTimeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

function modeAbbrev(mode: string): string {
  const m = mode.toLowerCase();
  if (m.startsWith("pom")) return "POM";
  if (m.startsWith("sto")) return "STO";
  if (m.startsWith("cou")) return "COU";
  return mode.slice(0, 3).toUpperCase();
}
