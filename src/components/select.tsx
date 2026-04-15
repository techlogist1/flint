import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

export interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
}

/**
 * FIX 6: minimal custom dropdown. Replaces the native `<select>` so the
 * OS-rendered popup (which on Windows draws a checkmark next to the
 * selected option — the "Pomodoro✓" the user sees) is not used. Fully
 * keyboard-navigable: ArrowUp/ArrowDown to move, Enter/Space to commit,
 * Escape to cancel.
 */
export function FlintSelect({
  value,
  options,
  onChange,
  disabled,
  placeholder,
  ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value),
    ),
  );
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);
  const label = selected?.label ?? placeholder ?? "";

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", onDocClick);
    return () => window.removeEventListener("mousedown", onDocClick);
  }, [open]);

  useEffect(() => {
    if (open) {
      const idx = options.findIndex((o) => o.value === value);
      setActiveIndex(idx >= 0 ? idx : 0);
    }
  }, [open, options, value]);

  const commit = useCallback(
    (v: string) => {
      onChange(v);
      setOpen(false);
    },
    [onChange],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (!open) {
      if (
        e.key === "Enter" ||
        e.key === " " ||
        e.key === "ArrowDown" ||
        e.key === "ArrowUp"
      ) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(options.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = options[activeIndex];
      if (opt) commit(opt.value);
    }
  };

  return (
    <div ref={rootRef} className="relative inline-block">
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        className="flex min-w-[140px] items-center justify-between gap-2 border border-[var(--border)] bg-[var(--bg-input)] px-2 py-[3px] text-left text-[11px] text-[var(--text-primary)] outline-none transition-colors duration-100 ease-out hover:border-[var(--border-focus)] focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span className="truncate">{label}</span>
        <span
          className="shrink-0 text-[10px] text-[var(--text-muted)]"
          aria-hidden="true"
        >
          ▾
        </span>
      </button>
      {open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute left-0 z-20 mt-1 min-w-full border border-[var(--border-focus)] bg-[var(--bg-elevated)] py-1"
          style={{ minWidth: "100%" }}
        >
          {options.map((opt, idx) => {
            const isSelected = opt.value === value;
            const isActive = idx === activeIndex;
            return (
              <li
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setActiveIndex(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(opt.value);
                }}
                className={`cursor-pointer px-3 py-[4px] text-[11px] transition-colors duration-75 ease-out ${
                  isActive
                    ? "bg-[var(--accent-subtle)] text-[var(--text-bright)]"
                    : isSelected
                      ? "text-[var(--text-bright)]"
                      : "text-[var(--text-secondary)]"
                }`}
              >
                {isSelected ? "▸ " : "  "}
                {opt.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
