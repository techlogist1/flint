import { useState } from "react";

type SidebarTab = "log" | "stats";

interface SidebarProps {
  visible: boolean;
  width: number;
  onOpenSettings: () => void;
}

export function Sidebar({ visible, width, onOpenSettings }: SidebarProps) {
  const [tab, setTab] = useState<SidebarTab>("log");

  if (!visible) return null;

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)]"
      style={{ width }}
    >
      <div className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-2">
        <TabButton
          active={tab === "log"}
          label="Log"
          onClick={() => setTab("log")}
        />
        <TabButton
          active={tab === "stats"}
          label="Stats"
          onClick={() => setTab("stats")}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm text-[var(--text-secondary)]">
        {tab === "log" ? <LogPlaceholder /> : <StatsPlaceholder />}
      </div>

      <div className="border-t border-[var(--border)] p-2">
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-[var(--text-secondary)] transition-colors duration-150 ease-out hover:bg-[var(--bg-elevated)] hover:text-[var(--text-primary)]"
          title="Open settings (Ctrl+,)"
        >
          <GearIcon />
          <span>Settings</span>
          <span className="ml-auto font-mono text-[10px] text-[var(--text-muted)]">
            Ctrl+,
          </span>
        </button>
      </div>
    </aside>
  );
}

function TabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-3 py-1 text-xs transition-colors duration-150 ease-out ${
        active
          ? "bg-[var(--bg-elevated)] text-[var(--text-primary)]"
          : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      }`}
    >
      {label}
    </button>
  );
}

function LogPlaceholder() {
  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
        Session Log
      </div>
      <p className="text-xs leading-relaxed text-[var(--text-muted)]">
        Past sessions will appear here. Built in Phase 5.
      </p>
    </div>
  );
}

function StatsPlaceholder() {
  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
        Stats
      </div>
      <p className="text-xs leading-relaxed text-[var(--text-muted)]">
        Focus time, streaks, and heatmap will appear here. Built in Phase 5.
      </p>
    </div>
  );
}

function GearIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
