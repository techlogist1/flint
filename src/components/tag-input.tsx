import { useEffect, useRef, useState } from "react";

interface TagInputProps {
  initial: string[];
  onConfirm: (tags: string[]) => void;
  onCancel: () => void;
  placeholder?: string;
}

export function TagInput({
  initial,
  onConfirm,
  onCancel,
  placeholder,
}: TagInputProps) {
  const [value, setValue] = useState(initial.join(", "));
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = () => {
    const tags = value
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    onConfirm(tags);
  };

  return (
    <input
      ref={ref}
      data-flint-input="true"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
      onBlur={commit}
      placeholder={placeholder ?? "tags, comma separated"}
      className="w-80 max-w-full rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2 text-center font-mono text-xs text-[var(--text-primary)] outline-none transition-colors duration-150 ease-out focus:border-[var(--accent)]"
    />
  );
}
