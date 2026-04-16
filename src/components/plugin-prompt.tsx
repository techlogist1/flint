/**
 * [H-6] Plugin prompt dialog. Mounted high in App.tsx alongside the command
 * palette. Subscribes to the module-level prompt queue (src/lib/prompt-queue.ts)
 * and renders the head entry. Plugins push prompts via `flint.prompt(...)`
 * and get back a Promise that resolves with the user's choice.
 *
 * UI rules:
 *   - Centered dialog using the same fixed/transform pattern as the command
 *     palette so the sidebar flexbox can't shift the modal off-axis.
 *   - Terminal aesthetic: 1px subtle border, 2px corner radius, JetBrains
 *     Mono everywhere, two `[label]` text buttons, no decorative animation.
 *   - Keyboard: Left/Right swaps focus, Enter confirms focused button,
 *     Escape dismisses (resolves "dismissed").
 *   - Optional timeout (default 30s) — auto-dismisses to "dismissed".
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { FlintErrorBoundary } from "./error-boundary";
import {
  resolveActivePrompt,
  subscribePromptQueue,
  type PromptEntry,
  type PromptOptions,
  type PromptResult,
} from "../lib/prompt-queue";

const DEFAULT_TIMEOUT_MS = 30_000;

export function PluginPrompt() {
  return (
    <FlintErrorBoundary label="plugin-prompt">
      <PluginPromptInner />
    </FlintErrorBoundary>
  );
}

function PluginPromptInner() {
  const [active, setActive] = useState<PromptEntry | null>(null);

  useEffect(() => {
    const unsub = subscribePromptQueue((entry) => {
      setActive(entry);
    });
    return unsub;
  }, []);

  if (!active) return null;
  return (
    <PromptDialog
      key={active.id}
      entry={active}
      onResolve={(result: PromptResult) => {
        resolveActivePrompt(result);
      }}
    />
  );
}

function PromptDialog({
  entry,
  onResolve,
}: {
  entry: PromptEntry;
  onResolve: (r: PromptResult) => void;
}) {
  const opts: PromptOptions = entry.options;
  const [focused, setFocused] = useState<"accept" | "decline">("accept");
  const acceptRef = useRef<HTMLButtonElement | null>(null);
  const declineRef = useRef<HTMLButtonElement | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const safeAccept = useMemo(
    () => trim(opts.accept, "[YES]"),
    [opts.accept],
  );
  const safeDecline = useMemo(
    () => trim(opts.decline, "[NO]"),
    [opts.decline],
  );
  const safeTitle = useMemo(() => trim(opts.title, "Prompt"), [opts.title]);
  const safeBody = useMemo(
    () => (opts.body ? trim(opts.body, "") : null),
    [opts.body],
  );

  // Auto-dismiss timeout
  useEffect(() => {
    const ms = clampTimeout(opts.timeout);
    timeoutRef.current = window.setTimeout(() => {
      onResolve("dismissed");
    }, ms);
    return () => {
      if (timeoutRef.current != null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [opts.timeout, onResolve]);

  // Initial focus on accept
  useEffect(() => {
    acceptRef.current?.focus();
  }, []);

  // Keep focus on the active button so Enter / Esc semantics behave
  useEffect(() => {
    if (focused === "accept") acceptRef.current?.focus();
    else declineRef.current?.focus();
  }, [focused]);

  const handleAccept = useCallback(() => {
    onResolve("accepted");
  }, [onResolve]);

  const handleDecline = useCallback(() => {
    onResolve("declined");
  }, [onResolve]);

  const handleDismiss = useCallback(() => {
    onResolve("dismissed");
  }, [onResolve]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleDismiss();
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        setFocused((f) => (f === "accept" ? "decline" : "accept"));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        if (focused === "accept") handleAccept();
        else handleDecline();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        e.stopPropagation();
        setFocused((f) => (f === "accept" ? "decline" : "accept"));
      }
    },
    [focused, handleAccept, handleDecline, handleDismiss],
  );

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleDismiss();
      }}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 60,
        backgroundColor: "rgba(5,5,5,0.7)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={safeTitle}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
        tabIndex={-1}
        className="border border-[var(--border-subtle)] bg-[var(--bg-panel,var(--bg-elevated))] outline-none"
        style={{
          position: "fixed",
          top: "18vh",
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(440px, 90vw)",
          zIndex: 61,
          borderRadius: 2,
        }}
      >
        <div className="border-b border-[var(--border)] px-4 py-2">
          <div className="text-[9px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
            PROMPT
          </div>
          <div className="mt-1 text-[13px] text-[var(--text-bright)]">
            {safeTitle}
          </div>
        </div>
        {safeBody && (
          <div className="border-b border-[var(--border-subtle)] px-4 py-3 text-[11px] leading-relaxed text-[var(--text-secondary)]">
            {safeBody}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 px-4 py-2">
          <button
            ref={declineRef}
            type="button"
            onClick={handleDecline}
            onMouseEnter={() => setFocused("decline")}
            className="border border-[var(--border)] px-3 py-1 text-[10px] uppercase tracking-[0.18em] outline-none transition-colors duration-100 ease-out"
            style={{
              color:
                focused === "decline"
                  ? "var(--text-bright)"
                  : "var(--text-secondary)",
              borderColor:
                focused === "decline"
                  ? "var(--border-focus)"
                  : "var(--border)",
              background:
                focused === "decline"
                  ? "var(--bg-elevated)"
                  : "transparent",
            }}
          >
            [{safeDecline}]
          </button>
          <button
            ref={acceptRef}
            type="button"
            onClick={handleAccept}
            onMouseEnter={() => setFocused("accept")}
            className="border px-3 py-1 text-[10px] uppercase tracking-[0.18em] outline-none transition-colors duration-100 ease-out"
            style={{
              color:
                focused === "accept"
                  ? "var(--accent)"
                  : "var(--text-secondary)",
              borderColor:
                focused === "accept"
                  ? "var(--accent)"
                  : "var(--border)",
              background:
                focused === "accept"
                  ? "var(--accent-subtle)"
                  : "transparent",
            }}
          >
            [{safeAccept}]
          </button>
        </div>
        <div className="border-t border-[var(--border-subtle)] px-4 py-1 text-[9px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
          ← → SWITCH · ENTER CONFIRM · ESC DISMISS
        </div>
      </div>
    </div>
  );
}

function trim(s: unknown, fallback: string): string {
  if (typeof s !== "string") return fallback;
  if (s.length === 0) return fallback;
  if (s.length > 500) return s.slice(0, 500);
  return s;
}

function clampTimeout(t: unknown): number {
  if (typeof t !== "number" || !Number.isFinite(t)) return DEFAULT_TIMEOUT_MS;
  // Floor at 1s, cap at 5min
  return Math.max(1000, Math.min(300_000, t));
}
