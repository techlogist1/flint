export interface ChartColors {
  accent: string;
  accentBright: string;
  muted: string;
  secondary: string;
  border: string;
  borderFocus: string;
  bgPrimary: string;
  bgVoid: string;
  bgElevated: string;
  textPrimary: string;
  textBright: string;
  textSecondary: string;
}

let cache: ChartColors | null = null;

// Read once at first access and cache for the lifetime of the window.
// The terminal aesthetic is dark-only so theme switching is unsupported;
// re-reading on every render would be wasted layout work.
export function chartColors(): ChartColors {
  if (cache) return cache;
  const root = document.documentElement;
  const read = (name: string, fallback: string) =>
    getComputedStyle(root).getPropertyValue(name).trim() || fallback;
  cache = {
    accent: read("--accent", "#16a34a"),
    accentBright: read("--accent-bright", "#22c55e"),
    muted: read("--text-muted", "#333333"),
    secondary: read("--text-secondary", "#5a5a5a"),
    border: read("--border", "#1a1a1a"),
    borderFocus: read("--border-focus", "#2a2a2a"),
    bgPrimary: read("--bg-primary", "#0a0a0a"),
    bgVoid: read("--bg-void", "#050505"),
    bgElevated: read("--bg-elevated", "#141414"),
    textPrimary: read("--text-primary", "#b8b8b8"),
    textBright: read("--text-bright", "#e0e0e0"),
    textSecondary: read("--text-secondary", "#5a5a5a"),
  };
  return cache;
}
