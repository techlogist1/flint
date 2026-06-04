export function isBreakInterval(intervalType: string | null | undefined): boolean {
  return intervalType === "break" || intervalType === "long-break";
}

export function formatTime(sec: number): string {
  // FE-STATS-OVERLAY-7: a non-finite input (NaN/Infinity from a malformed
  // cache row or a missing deserialized field) would otherwise render as
  // "NaN:NaN" straight to the user; fall back to 00:00.
  const s = Number.isFinite(sec) ? Math.max(0, Math.floor(sec)) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const mm = String(m).padStart(2, "0");
  const sss = String(ss).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
}

export function modeDescription(
  mode: string,
  pomodoroFocusMin: number,
  countdownMin: number,
): string {
  switch (mode) {
    case "pomodoro":
      return `${pomodoroFocusMin}m focus`;
    case "stopwatch":
      return "count up";
    case "countdown":
      return `${countdownMin}m countdown`;
    default:
      return "";
  }
}
