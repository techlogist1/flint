import { usePlugins } from "./plugin-host";

export function Notifications() {
  const { notifications, dismissNotification } = usePlugins();
  if (notifications.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      {notifications.map((n) => (
        <div
          key={n.id}
          className="pointer-events-auto flex min-w-[220px] max-w-sm items-start gap-3 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-2.5 text-xs text-[var(--text-primary)] shadow-lg animate-[flint-toast_150ms_ease-out]"
        >
          <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
          <div className="flex-1">
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              {n.pluginId}
            </div>
            <div className="mt-0.5 leading-snug">{n.message}</div>
          </div>
          <button
            onClick={() => dismissNotification(n.id)}
            className="text-[var(--text-muted)] transition-colors duration-150 ease-out hover:text-[var(--text-primary)]"
            title="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
