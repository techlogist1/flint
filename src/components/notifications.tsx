import { usePlugins } from "./plugin-host";

export function Notifications() {
  const { notifications, dismissNotification } = usePlugins();
  if (notifications.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-8 right-6 z-50 flex flex-col gap-[6px]">
      {notifications.map((n) => (
        <div
          key={n.id}
          className="pointer-events-auto flex min-w-[240px] max-w-sm items-start gap-3 border border-[var(--border-focus)] bg-[var(--bg-overlay)] px-3 py-2 text-[11px] text-[var(--text-primary)] animate-[flint-toast_120ms_ease-out]"
        >
          <div className="flex-1 min-w-0">
            <div className="text-[9px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
              {n.pluginId}
            </div>
            <div className="mt-0.5 leading-snug text-[var(--text-primary)]">
              {n.message}
            </div>
          </div>
          <button
            onClick={() => dismissNotification(n.id)}
            className="shrink-0 text-[var(--text-muted)] transition-colors duration-100 ease-out hover:text-[var(--text-bright)]"
            title="Dismiss"
            style={{ fontSize: 14, lineHeight: 1 }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
