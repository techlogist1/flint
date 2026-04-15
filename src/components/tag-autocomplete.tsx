import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePlugins } from "./plugin-host";
import type { HookContext } from "../lib/hook-registry";

interface TagAutocompleteProps {
  initial: string[];
  onChange: (tags: string[]) => void;
  /** Called when the user explicitly submits (Enter on empty input). */
  onConfirm?: (tags: string[]) => void;
  /** Called on Escape when the input is empty or already canceled. */
  onCancel?: () => void;
  /** Optional autofocus on mount. */
  autoFocus?: boolean;
  placeholder?: string;
  /** If true, tag chips render above the input on a separate line. */
  stacked?: boolean;
}

/**
 * Tag input with autocomplete from the in-memory tag index scanned from
 * past session files. Supports inline pill rendering, keyboard navigation
 * of suggestions, and backspace-to-remove. Fires `tag:add` / `tag:remove`
 * through the hook pipeline so plugins can react (and veto) each change.
 */
export function TagAutocomplete({
  initial,
  onChange,
  onConfirm,
  onCancel,
  autoFocus = true,
  placeholder = "type a tag…",
  stacked = false,
}: TagAutocompleteProps) {
  const { runBeforeHooks, dispatchAfterHooks } = usePlugins();
  const [tags, setTags] = useState<string[]>(initial);
  const [input, setInput] = useState("");
  const [known, setKnown] = useState<string[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (autoFocus) {
      inputRef.current?.focus();
    }
  }, [autoFocus]);

  useEffect(() => {
    void (async () => {
      try {
        const list = await invoke<string[]>("get_known_tags");
        setKnown(list);
      } catch (e) {
        console.error("[tags] get_known_tags failed:", e);
      }
    })();
  }, []);

  const suggestions = useMemo<string[]>(() => {
    const q = input.trim().toLowerCase();
    if (!q) return [];
    const existing = new Set(tags.map((t) => t.toLowerCase()));
    return known
      .filter((t) => {
        const lo = t.toLowerCase();
        if (existing.has(lo)) return false;
        return lo.includes(q);
      })
      .sort((a, b) => {
        const al = a.toLowerCase();
        const bl = b.toLowerCase();
        const aStarts = al.startsWith(q);
        const bStarts = bl.startsWith(q);
        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;
        return al.localeCompare(bl);
      })
      .slice(0, 8);
  }, [input, known, tags]);

  useEffect(() => {
    if (activeIdx >= suggestions.length) {
      setActiveIdx(Math.max(0, suggestions.length - 1));
    }
  }, [suggestions, activeIdx]);

  const addTag = useCallback(
    async (raw: string) => {
      const value = raw.trim();
      if (!value) return;
      if (tags.some((t) => t.toLowerCase() === value.toLowerCase())) {
        setInput("");
        return;
      }
      const ctx: HookContext = { tag: value, current_tags: [...tags] };
      const cancelled = await runBeforeHooks("tag:add", ctx);
      if (cancelled) return;
      const finalTag =
        typeof ctx.tag === "string" && ctx.tag.trim() ? ctx.tag.trim() : value;
      const next = [...tags, finalTag];
      setTags(next);
      setInput("");
      onChange(next);
      dispatchAfterHooks("tag:add", { tag: finalTag, current_tags: next });
    },
    [tags, runBeforeHooks, dispatchAfterHooks, onChange],
  );

  const removeTag = useCallback(
    async (target: string) => {
      const ctx: HookContext = { tag: target, current_tags: [...tags] };
      const cancelled = await runBeforeHooks("tag:remove", ctx);
      if (cancelled) return;
      const next = tags.filter((t) => t !== target);
      setTags(next);
      onChange(next);
      dispatchAfterHooks("tag:remove", { tag: target, current_tags: next });
    },
    [tags, runBeforeHooks, dispatchAfterHooks, onChange],
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (input.length > 0) {
          setInput("");
          return;
        }
        onCancel?.();
        return;
      }
      if (e.key === "ArrowDown") {
        if (suggestions.length > 0) {
          e.preventDefault();
          setActiveIdx((i) => Math.min(suggestions.length - 1, i + 1));
        }
        return;
      }
      if (e.key === "ArrowUp") {
        if (suggestions.length > 0) {
          e.preventDefault();
          setActiveIdx((i) => Math.max(0, i - 1));
        }
        return;
      }
      if (e.key === "Tab") {
        if (suggestions.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          void addTag(suggestions[activeIdx]);
        }
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (suggestions.length > 0) {
          void addTag(suggestions[activeIdx]);
        } else if (input.trim()) {
          void addTag(input);
        } else if (onConfirm) {
          onConfirm(tags);
        }
        return;
      }
      if (e.key === "," ) {
        // Comma commits the current token, matching the muscle-memory of
        // the old comma-separated input.
        if (input.trim()) {
          e.preventDefault();
          void addTag(input);
        }
        return;
      }
      if (e.key === "Backspace" && input.length === 0 && tags.length > 0) {
        e.preventDefault();
        const last = tags[tags.length - 1];
        void removeTag(last);
        return;
      }
    },
    [
      input,
      suggestions,
      activeIdx,
      addTag,
      removeTag,
      tags,
      onCancel,
      onConfirm,
    ],
  );

  return (
    <div
      className={
        stacked
          ? "flex w-full max-w-xl flex-col gap-1"
          : "flex w-full max-w-xl flex-col gap-1"
      }
    >
      <div className="flex flex-wrap items-center gap-[6px] text-[11px]">
        {tags.map((t) => (
          <button
            key={t}
            onClick={() => void removeTag(t)}
            className="flex items-center gap-1 border border-[var(--accent-tinted-border)] bg-[var(--accent-subtle)] px-[6px] py-[1px] text-[var(--accent-bright)] transition-colors duration-100 ease-out hover:border-[var(--status-error)] hover:text-[var(--status-error)]"
            title="Remove tag"
            style={{ letterSpacing: "0.04em" }}
          >
            [{t}]
            <span aria-hidden="true" className="text-[9px] opacity-60">
              ×
            </span>
          </button>
        ))}
        <div className="flex items-center gap-[6px]">
          <span className="text-[var(--accent)]">&gt;</span>
          <input
            ref={inputRef}
            data-flint-input="true"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setActiveIdx(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={tags.length === 0 ? placeholder : ""}
            className="w-44 bg-transparent text-[11px] text-[var(--text-bright)] placeholder:text-[var(--text-muted)] outline-none"
          />
        </div>
      </div>

      {suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-[4px] border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-[4px] text-[10px]">
          {suggestions.map((s, idx) => (
            <button
              key={s}
              onMouseEnter={() => setActiveIdx(idx)}
              onMouseDown={(e) => {
                e.preventDefault();
                void addTag(s);
              }}
              className="px-[4px] py-[1px]"
              style={{
                backgroundColor:
                  idx === activeIdx ? "var(--accent-subtle)" : "transparent",
                color:
                  idx === activeIdx
                    ? "var(--text-bright)"
                    : "var(--text-secondary)",
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
