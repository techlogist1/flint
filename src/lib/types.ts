export type TimerStatus = "idle" | "running" | "paused";
export type Mode = "pomodoro" | "stopwatch" | "countdown";

export interface Interval {
  type: string;
  start_sec: number;
  elapsed_sec: number;
  target_sec?: number | null;
}

export interface TimerStateView {
  status: TimerStatus;
  session_id: string | null;
  started_at: string | null;
  elapsed_sec: number;
  questions_done: number;
  mode: string;
  tags: string[];
  current_interval: Interval | null;
  completed_intervals: Interval[];
}

export interface Config {
  core: {
    default_mode: string;
    countdown_default_min: number;
  };
  appearance: {
    sidebar_visible: boolean;
    sidebar_width: number;
  };
  overlay: {
    enabled: boolean;
    position: string;
    opacity: number;
  };
  keybindings: {
    toggle_sidebar: string;
    toggle_overlay: string;
    quick_tag: string;
  };
  pomodoro: {
    focus_min: number;
    break_min: number;
    long_break_min: number;
    cycles_before_long: number;
    auto_start_breaks: boolean;
    auto_start_focus: boolean;
  };
  tray: {
    close_to_tray: boolean;
    show_timer_in_tray: boolean;
  };
  plugins: {
    enabled: Record<string, boolean>;
  };
}

export const MODES: Mode[] = ["pomodoro", "stopwatch", "countdown"];

export const MODE_LABELS: Record<Mode, string> = {
  pomodoro: "Pomodoro",
  stopwatch: "Stopwatch",
  countdown: "Countdown",
};
