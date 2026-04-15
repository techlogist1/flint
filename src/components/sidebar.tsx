import { useCallback, useEffect, useMemo, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
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
  onResize?: (width: number) => void;
}

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 360;

export function Sidebar({
  visible,
  width,
  activeSessionId,
  onOpenSession,
  onOpenSettings,
  onResize,
}: SidebarProps) {
  const { plugins } = usePlugins();
  const [localWidth, setLocalWidth] = useState<number | null>(null);
  const displayWidth = localWidth ?? width;

  useEffect(() => {
    if (localWidth !== null && Math.abs(width - localWidth) < 2) {
      setLocalWidth(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width]);

  const onHandlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = displayWidth;
      const clamp = (v: number) =>
        Math.round(Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, v)));
      const onMove = (me: PointerEvent) => {
        setLocalWidth(clamp(startWidth + (me.clientX - startX)));
      };
      const onUp = (ue: PointerEvent) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        const next = clamp(startWidth + (ue.clientX - startX));
        setLocalWidth(next);
        onResize?.(next);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [displayWidth, onResize],
  );

  const tabs: SidebarTabDef[] = useMemo(() => {
    const out: SidebarTabDef[] = [];
    const seen = new Set<string>();
    for (const p of plugins) {
      if (!p.enabled) continue;
      if (!p.manifest.ui_slots.includes("sidebar-tab")) continue;
      if (seen.has(p.manifest.id)) continue;
      seen.add(p.manifest.id);
      out.push({
        id: p.manifest.id,
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

  const active = tabs.find((t) => t.id === activeTab) ?? null;

  return (
    <aside
      id="flint-sidebar"
      tabIndex={-1}
      aria-hidden={!visible}
      className="relative flex h-full shrink-0 flex-col overflow-hidden bg-[var(--bg-secondary)] outline-none"
      style={{
        width: visible ? displayWidth : 0,
        borderRightWidth: visible ? 1 : 0,
        borderRightStyle: "solid",
        borderRightColor: "var(--border)",
      }}
    >
      {/* Tab switcher — plain text buttons with underline on active */}
      <div className="flex items-center gap-4 border-b border-[var(--border)] px-3 pt-3 pb-0">
        {tabs.length === 0 ? (
          <span className="pb-2 text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
            NO PLUGINS
          </span>
        ) : (
          tabs.map((t) => (
            <TextTab
              key={t.id}
              active={activeTab === t.id}
              label={t.label}
              onClick={() => setActiveTab(t.id)}
            />
          ))
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {tabs.some((t) => t.pluginId === "session-log") && (
          <div
            className={
              active?.pluginId === "session-log"
                ? "flex h-full min-h-0"
                : "hidden"
            }
          >
            <div className="min-h-0 flex-1">
              <SessionLog
                activeSessionId={activeSessionId}
                onOpenSession={onOpenSession}
              />
            </div>
          </div>
        )}
        {tabs.some((t) => t.pluginId === "stats") && (
          <div
            className={
              active?.pluginId === "stats" ? "flex h-full min-h-0" : "hidden"
            }
          >
            <div className="min-h-0 flex-1">
              <StatsDashboard />
            </div>
          </div>
        )}
        {active &&
          active.pluginId !== "session-log" &&
          active.pluginId !== "stats" && (
            <CommunityTabPlaceholder label={active.label} />
          )}
        {!active && tabs.length === 0 && <DisabledHint />}
      </div>

      {/* Footer: settings row */}
      <div className="border-t border-[var(--border)]">
        <button
          onClick={onOpenSettings}
          className="flex w-full items-center justify-between px-3 py-2 text-left text-[11px] uppercase tracking-[0.18em] text-[var(--text-secondary)] transition-colors duration-100 ease-out hover:bg-[var(--bg-elevated)] hover:text-[var(--text-bright)]"
          title="Open settings (Ctrl+,)"
        >
          <span>SETTINGS</span>
          <span className="text-[10px] text-[var(--text-muted)]">CTRL+,</span>
        </button>
      </div>

      {/* 4px invisible hit target for edge-drag resize */}
      {visible && (
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={onHandlePointerDown}
          className="absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize"
          title="Drag to resize"
        />
      )}
    </aside>
  );
}

function TextTab({
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
      className="relative pb-2 text-[11px] uppercase tracking-[0.18em] transition-colors duration-100 ease-out"
      style={{
        color: active ? "var(--text-bright)" : "var(--text-secondary)",
      }}
    >
      {label}
      <span
        className="absolute -bottom-[1px] left-0 right-0 h-[1px]"
        style={{
          background: active ? "var(--accent)" : "transparent",
        }}
      />
    </button>
  );
}

function CommunityTabPlaceholder({ label }: { label: string }) {
  return (
    <div className="p-3 text-[11px] text-[var(--text-muted)]">
      {label.toLowerCase()} plugin has no built-in renderer.
    </div>
  );
}

function DisabledHint() {
  return (
    <div className="p-3 text-[11px] leading-relaxed text-[var(--text-muted)]">
      enable session-log or stats in settings → plugins.
    </div>
  );
}

function tabLabelFor(pluginId: string, fallback: string): string {
  if (pluginId === "session-log") return "LOG";
  if (pluginId === "stats") return "STATS";
  return fallback.toUpperCase();
}
