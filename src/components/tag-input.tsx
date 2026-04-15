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
    <div className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
      <span className="text-[var(--accent)]">tags&gt;</span>
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
        placeholder={placeholder ?? "comma, separated"}
        className="w-72 border border-[var(--border)] bg-[var(--bg-input)] px-2 py-[3px] text-[11px] text-[var(--text-bright)] placeholder:text-[var(--text-muted)] outline-none transition-colors duration-100 ease-out focus:border-[var(--accent)]"
      />
    </div>
  );
}
