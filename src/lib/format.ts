export function isBreakInterval(intervalType: string | null | undefined): boolean {
  return intervalType === "break" || intervalType === "long-break";
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
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
