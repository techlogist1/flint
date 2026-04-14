export type TimerStatus = "idle" | "running" | "paused";
// A mode is just a plugin id — the set of valid modes is whatever
// timer-mode plugins are currently enabled. Treating it as `string` means
// adding a community plugin with a new mode does not require any core
// refactor.
export type Mode = string;

export interface TimerModeInfo {
  id: string;
  label: string;
}

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
    x?: number | null;
    y?: number | null;
    always_visible: boolean;
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

/**
 * Best-effort label for a mode id when the plugin registry is not available
 * (e.g. inside the separate overlay window which has no PluginHost). Known
 * built-in modes have canonical labels; everything else falls back to a
 * title-cased version of the raw id.
 */
export function fallbackModeLabel(mode: string): string {
  if (!mode) return "";
  const builtIn: Record<string, string> = {
    pomodoro: "Pomodoro",
    stopwatch: "Stopwatch",
    countdown: "Countdown",
  };
  if (builtIn[mode]) return builtIn[mode];
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

export interface CachedSession {
  id: string;
  started_at: string;
  ended_at: string;
  duration_sec: number;
  mode: string;
  tags: string[];
  questions_done: number;
  completed: boolean;
}

export interface IntervalView {
  type: string;
  start_sec: number;
  end_sec: number;
}

export interface SessionDetail extends CachedSession {
  intervals: IntervalView[];
}

export interface TodayStats {
  focus_sec: number;
  session_count: number;
  questions_done: number;
}

export interface DailyBucket {
  date: string;
  focus_sec: number;
  session_count: number;
}

export interface TagShare {
  tag: string;
  focus_sec: number;
  session_count: number;
}

export interface HeatmapCell {
  date: string;
  focus_sec: number;
}

export interface RangeStats {
  total_focus_sec: number;
  total_sessions: number;
  total_questions: number;
  current_streak: number;
  longest_streak: number;
  daily: DailyBucket[];
  tags: TagShare[];
}

export interface LifetimeTotals {
  longest_session_sec: number;
  best_day_date: string | null;
  best_day_focus_sec: number;
  all_time_focus_sec: number;
}
