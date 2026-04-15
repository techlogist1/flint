interface TrayToastProps {
  message: string;
}

export function TrayToast({ message }: TrayToastProps) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-8 z-50 flex justify-center">
      <div className="pointer-events-auto flex max-w-md items-start gap-3 border border-[var(--border-focus)] bg-[var(--bg-overlay)] px-3 py-2 text-[11px] text-[var(--text-primary)] animate-[flint-toast_140ms_ease-out]">
        <div className="flex-1 leading-snug">
          <div className="text-[9px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
            FLINT
          </div>
          <div className="mt-0.5">{message}</div>
        </div>
      </div>
    </div>
  );
}
