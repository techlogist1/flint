import { useEffect, useMemo, useState } from "react";
import { SessionLog } from "./session-log";
import { StatsDashboard } from "./stats-dashboard";
import { usePlugins } from "./plugin-host";

interface SidebarTabDef {
  id: string;
  label: string;
  pluginId: string;
}

interface SidebarProps {
  visible: boolean;
  width: number;
  activeSessionId: string | null;
  onOpenSession: (id: string) => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  visible,
  width,
  activeSessionId,
  onOpenSession,
  onOpenSettings,
}: SidebarProps) {
  const { plugins } = usePlugins();

  const tabs: SidebarTabDef[] = useMemo(() => {
    const out: SidebarTabDef[] = [];
    const seen = new Set<string>();
    for (const p of plugins) {
      if (!p.enabled) continue;
      if (!p.manifest.ui_slots.includes("sidebar-tab")) continue;
      if (seen.has(p.manifest.id)) continue;
      seen.add(p.manifest.id);
      out.push({
        id: tabIdFor(p.manifest.id),
        label: tabLabelFor(p.manifest.id, p.manifest.name),
        pluginId: p.manifest.id,
      });
    }
    return out;
  }, [plugins]);

  const [activeTab, setActiveTab] = useState<string | null>(null);

  useEffect(() => {
    if (tabs.length === 0) {
      setActiveTab(null);
      return;
    }
    setActiveTab((prev) => {
      if (prev && tabs.some((t) => t.id === prev)) return prev;
      return tabs[0].id;
    });
  }, [tabs]);

  if (!visible) return null;

  const active = tabs.find((t) => t.id === activeTab) ?? null;

  return (
    <aside
      className="flex h-full shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg-secondary)]"
      style={{ width }}
    >
      <div className="flex items-center gap-1 border-b border-[var(--border)] px-2 py-2">
        {tabs.length === 0 ? (
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            No sidebar plugins
          </span>
        ) : (
          tabs.map((t) => (
            <TabButton
              key={t.id}
              active={activeTab === t.id}
              label={t.label}
              onClick={() => setActiveTab(t.id)}
            />
          ))
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {active?.pluginId === "session-log" && (
          <SessionLog
            activeSessionId={activeSessionId}
            onOpenSession={onOpenSession}
          />
        )}
        {active?.pluginId === "stats" && <StatsDashboard />}
        {active && active.pluginId !== "session-log" && active.pluginId !== "stats" && (
          <CommunityTabPlaceholder label={active.label} />
        )}
        {!active && tabs.length === 0 && <DisabledHint />}
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

function CommunityTabPlaceholder({ label }: { label: string }) {
  return (
    <div className="p-3 text-[11px] text-[var(--text-muted)]">
      {label} is a community plugin. Its sidebar content will render when it
      targets a built-in slot renderer.
    </div>
  );
}

function DisabledHint() {
  return (
    <div className="p-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
      Enable Session Log or Stats from Settings → Plugins to populate the
      sidebar.
    </div>
  );
}

function tabIdFor(pluginId: string): string {
  return pluginId;
}

function tabLabelFor(pluginId: string, fallback: string): string {
  if (pluginId === "session-log") return "Log";
  if (pluginId === "stats") return "Stats";
  return fallback;
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
