/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          void: "var(--bg-void)",
          primary: "var(--bg-primary)",
          secondary: "var(--bg-secondary)",
          elevated: "var(--bg-elevated)",
          input: "var(--bg-input)",
          overlay: "var(--bg-overlay)",
        },
        border: {
          DEFAULT: "var(--border)",
          subtle: "var(--border-subtle)",
          focus: "var(--border-focus)",
        },
        text: {
          primary: "var(--text-primary)",
          bright: "var(--text-bright)",
          secondary: "var(--text-secondary)",
          muted: "var(--text-muted)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          bright: "var(--accent-bright)",
          dim: "var(--accent-dim)",
          subtle: "var(--accent-subtle)",
        },
        status: {
          running: "var(--status-running)",
          paused: "var(--status-paused)",
          break: "var(--status-break)",
          idle: "var(--status-idle)",
          error: "var(--status-error)",
        },
        success: "var(--success)",
        warning: "var(--warning)",
        danger: "var(--danger)",
      },
      fontFamily: {
        mono: [
          "'JetBrains Mono'",
          "'Fira Code'",
          "'SF Mono'",
          "'Cascadia Code'",
          "'Consolas'",
          "monospace",
        ],
        sans: [
          "'JetBrains Mono'",
          "'Fira Code'",
          "'SF Mono'",
          "'Cascadia Code'",
          "'Consolas'",
          "monospace",
        ],
      },
      borderRadius: {
        none: "0",
        DEFAULT: "2px",
        sm: "2px",
        md: "2px",
        lg: "2px",
      },
      letterSpacing: {
        tightest: "-0.03em",
        tighter: "-0.02em",
        tight: "-0.01em",
        normal: "0.02em",
        wide: "0.04em",
        wider: "0.08em",
        widest: "0.12em",
      },
    },
  },
  plugins: [],
};
