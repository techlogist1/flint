import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  searchCommands,
  type RegisteredCommand,
} from "../lib/command-registry";
import { FlintErrorBoundary } from "./error-boundary";
import { getCommandMru, usePlugins } from "./plugin-host";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

const MAX_VISIBLE = 12;

/**
 * Ctrl+P palette. Fuzzy search over the full command registry, keyboard
 * navigation, MRU ordering when the query is empty. Terminal aesthetic:
 * no animation, instant open/close, 1px border, JetBrains Mono everywhere.
 */
export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  return (
    <FlintErrorBoundary label="command-palette">
      {open && <CommandPaletteInner onClose={onClose} />}
    </FlintErrorBoundary>
  );
}

function CommandPaletteInner({ onClose }: { onClose: () => void }) {
  const { commands, executeCommand } = usePlugins();
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const results = useMemo<RegisteredCommand[]>(
    () => searchCommands(query, commands, getCommandMru()),
    [query, commands],
  );

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    if (activeIdx >= results.length) {
      setActiveIdx(Math.max(0, results.length - 1));
    }
  }, [results, activeIdx]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLDivElement>(
      `[data-idx="${activeIdx}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  const run = useCallback(
    async (cmd: RegisteredCommand) => {
      onClose();
      await executeCommand(cmd.id, "palette");
    },
    [executeCommand, onClose],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(results.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        const cmd = results[activeIdx];
        if (cmd) {
          void run(cmd);
        }
        return;
      }
    },
    [results, activeIdx, run, onClose],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        backgroundColor: "rgba(5,5,5,0.7)",
        paddingTop: "14vh",
      }}
    >
      <div
        className="w-full max-w-2xl border border-[var(--border-focus)] bg-[var(--bg-primary)]"
        style={{ minHeight: 56 }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
          <span className="text-[12px] text-[var(--accent)]">&gt;</span>
          <input
            ref={inputRef}
            data-flint-input="true"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="type a command…"
            className="flex-1 bg-transparent text-[12px] text-[var(--text-bright)] placeholder:text-[var(--text-muted)] outline-none"
          />
          <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
            {results.length}/{commands.length}
          </span>
        </div>

        <div
          ref={listRef}
          className="max-h-[60vh] overflow-y-auto"
          style={{ maxHeight: `${MAX_VISIBLE * 32}px` }}
        >
          {results.length === 0 && (
            <div className="px-3 py-3 text-[11px] text-[var(--text-muted)]">
              no matching commands
            </div>
          )}
          {results.map((cmd, idx) => (
            <CommandRow
              key={`${cmd.owner}::${cmd.id}`}
              command={cmd}
              active={idx === activeIdx}
              index={idx}
              onHover={() => setActiveIdx(idx)}
              onSelect={() => run(cmd)}
            />
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--border)] px-3 py-1 text-[9px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
          <span>↑↓ NAV · ENTER RUN · ESC CLOSE</span>
          <span>CTRL+P</span>
        </div>
      </div>
    </div>
  );
}

function CommandRow({
  command,
  active,
  index,
  onHover,
  onSelect,
}: {
  command: RegisteredCommand;
  active: boolean;
  index: number;
  onHover: () => void;
  onSelect: () => void;
}) {
  return (
    <div
      data-idx={index}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        e.preventDefault();
        onSelect();
      }}
      className="flex cursor-pointer items-center justify-between px-3 py-[6px] text-[11px] transition-colors duration-75 ease-out"
      style={{
        backgroundColor: active ? "var(--accent-subtle)" : "transparent",
        color: active ? "var(--text-bright)" : "var(--text-primary)",
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="shrink-0 text-[var(--text-muted)]"
          aria-hidden="true"
          style={{ width: 12 }}
        >
          {command.icon ?? (active ? "▸" : " ")}
        </span>
        <span className="truncate">{command.name}</span>
        {command.category && (
          <span className="shrink-0 text-[var(--text-muted)]">
            · {command.category}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {command.hotkey && (
          <span className="text-[9px] uppercase tracking-wider text-[var(--text-secondary)]">
            {command.hotkey}
          </span>
        )}
        <span className="text-[9px] text-[var(--text-muted)]">
          {command.id}
        </span>
      </div>
    </div>
  );
}
