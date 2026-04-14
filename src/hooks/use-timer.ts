import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { TimerStateView } from "../lib/types";

interface TickPayload {
  elapsed_sec: number;
  interval_elapsed: number;
  interval_remaining: number | null;
}

const REFRESH_EVENTS = [
  "session:start",
  "session:pause",
  "session:resume",
  "session:complete",
  "session:cancel",
  "interval:start",
  "interval:end",
  "question:marked",
  "recovery:restored",
];

export function useTimer() {
  const [state, setState] = useState<TimerStateView | null>(null);
  const [intervalRemaining, setIntervalRemaining] = useState<number | null>(
    null,
  );

  const refresh = async () => {
    try {
      const s = await invoke<TimerStateView>("get_timer_state");
      setState(s);
      if (s.current_interval?.target_sec != null) {
        setIntervalRemaining(
          Math.max(
            0,
            s.current_interval.target_sec - s.current_interval.elapsed_sec,
          ),
        );
      } else {
        setIntervalRemaining(null);
      }
    } catch (e) {
      console.error("get_timer_state failed", e);
    }
  };

  useEffect(() => {
    refresh();
    const unlisteners: Promise<UnlistenFn>[] = [];

    for (const name of REFRESH_EVENTS) {
      unlisteners.push(listen(name, () => refresh()));
    }

    unlisteners.push(
      listen<TickPayload>("session:tick", (evt) => {
        const { elapsed_sec, interval_elapsed, interval_remaining } =
          evt.payload;
        setIntervalRemaining(interval_remaining);
        setState((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            elapsed_sec,
            current_interval: prev.current_interval
              ? { ...prev.current_interval, elapsed_sec: interval_elapsed }
              : prev.current_interval,
          };
        });
      }),
    );

    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, []);

  return { state, intervalRemaining, refresh };
}
