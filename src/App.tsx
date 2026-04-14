import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type TimerStatus = "idle" | "running" | "paused";

interface Interval {
  type: string;
  start_sec: number;
  elapsed_sec: number;
  target_sec?: number | null;
}

interface TimerStateView {
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

const EVENTS = [
  "session:start",
  "session:pause",
  "session:resume",
  "session:tick",
  "session:complete",
  "session:cancel",
  "interval:start",
  "interval:end",
  "question:marked",
  "recovery:restored",
];

function formatTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function App() {
  const [state, setState] = useState<TimerStateView | null>(null);
  const [log, setLog] = useState<string[]>([]);

  const appendLog = (line: string) =>
    setLog((prev) => [line, ...prev].slice(0, 30));

  const refresh = async () => {
    try {
      const s = await invoke<TimerStateView>("get_timer_state");
      setState(s);
    } catch (e) {
      appendLog(`get_timer_state error: ${String(e)}`);
    }
  };

  useEffect(() => {
    refresh();
    const unlisteners: Promise<UnlistenFn>[] = EVENTS.map((name) =>
      listen(name, (evt) => {
        if (name !== "session:tick") {
          appendLog(`${name} ${JSON.stringify(evt.payload)}`);
        }
        refresh();
      }),
    );
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, []);

  const call = async (cmd: string, args?: Record<string, unknown>) => {
    try {
      await invoke(cmd, args);
      await refresh();
    } catch (e) {
      appendLog(`${cmd} error: ${String(e)}`);
    }
  };

  const btn =
    "rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1 font-mono text-xs text-text-primary hover:border-[var(--accent)]";

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-bg-primary text-text-primary">
      <header className="px-6 pt-6">
        <h1 className="font-mono text-3xl tracking-tight">Flint</h1>
        <p className="text-sm text-text-secondary">Strike focus.</p>
      </header>

      <section className="mt-6 border-t border-[var(--border)] px-6 py-5">
        <div className="font-mono text-4xl tabular-nums">
          {state ? formatTime(state.elapsed_sec) : "--:--"}
        </div>
        <div className="mt-1 text-xs text-text-secondary">
          {state
            ? `${state.status} · ${state.mode || "—"} · tags: ${
                state.tags.join(", ") || "—"
              } · Q: ${state.questions_done}`
            : "loading…"}
        </div>
        {state?.current_interval && (
          <div className="mt-1 text-xs text-text-muted">
            interval {state.current_interval.type} ·{" "}
            {state.current_interval.elapsed_sec}s
            {state.current_interval.target_sec != null
              ? ` / ${state.current_interval.target_sec}s`
              : ""}
          </div>
        )}
      </section>

      <section className="flex flex-wrap gap-2 border-t border-[var(--border)] px-6 py-4">
        <button
          className={btn}
          onClick={() =>
            call("start_session", { mode: "pomodoro", tags: ["physics"] })
          }
        >
          start pomodoro
        </button>
        <button
          className={btn}
          onClick={() =>
            call("start_session", { mode: "stopwatch", tags: ["math"] })
          }
        >
          start stopwatch
        </button>
        <button
          className={btn}
          onClick={() =>
            call("start_session", { mode: "countdown", tags: ["deep-work"] })
          }
        >
          start countdown
        </button>
        <button className={btn} onClick={() => call("pause_session")}>
          pause
        </button>
        <button className={btn} onClick={() => call("resume_session")}>
          resume
        </button>
        <button className={btn} onClick={() => call("mark_question")}>
          mark question
        </button>
        <button className={btn} onClick={() => call("next_interval")}>
          next interval
        </button>
        <button className={btn} onClick={() => call("stop_session")}>
          stop (complete)
        </button>
        <button className={btn} onClick={() => call("cancel_session")}>
          cancel
        </button>
      </section>

      <section className="flex min-h-0 flex-1 flex-col border-t border-[var(--border)] px-6 py-4">
        <div className="mb-2 text-xs uppercase tracking-wide text-text-secondary">
          events
        </div>
        <pre className="flex-1 overflow-auto rounded bg-[var(--bg-secondary)] p-3 font-mono text-[11px] leading-relaxed text-text-secondary">
          {log.join("\n") || "(no events yet)"}
        </pre>
      </section>
    </div>
  );
}

export default App;
