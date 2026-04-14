interface TrayToastProps {
  message: string;
}

export function TrayToast({ message }: TrayToastProps) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center">
      <div className="pointer-events-auto flex max-w-md items-start gap-3 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3 text-xs text-[var(--text-primary)] animate-[flint-toast_180ms_ease-out]">
        <span className="mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
        <div className="flex-1 leading-snug">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            Flint
          </div>
          <div className="mt-0.5">{message}</div>
        </div>
      </div>
    </div>
  );
}
