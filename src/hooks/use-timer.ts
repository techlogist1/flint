import { useCallback, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Interval, TimerStateView, TimerStatus } from "../lib/types";

interface TickPayload {
  elapsed_sec: number;
  interval_elapsed: number;
  interval_remaining: number | null;
}

/**
 * P-C2: timer state split into the parts that change every second (tick) and
 * the parts that only change on lifecycle events (meta). Components that
 * only need digits / progress subscribe to tick; components that need
 * mode/status/tags subscribe to meta. AppShell only subscribes to meta, so a
 * 1Hz tick no longer reconciles the entire app tree.
 */
export interface TickState {
  elapsed_sec: number;
  interval_elapsed: number;
  interval_remaining: number | null;
}

/** Slow-changing fields of the current interval — type/start/target update on
 *  interval:start, never on tick. `elapsed_sec` is intentionally absent so
 *  meta consumers do not re-render every second. */
export interface MetaInterval {
  type: string;
  start_sec: number;
  target_sec: number | null;
}

export interface MetaState {
  status: TimerStatus;
  session_id: string | null;
  started_at: string | null;
  mode: string;
  tags: string[];
  questions_done: number;
  current_interval: MetaInterval | null;
  completed_intervals: Interval[];
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

let tickSnapshot: TickState = {
  elapsed_sec: 0,
  interval_elapsed: 0,
  interval_remaining: null,
};
let metaSnapshot: MetaState | null = null;

const tickListeners = new Set<() => void>();
const metaListeners = new Set<() => void>();

function emitTick(): void {
  for (const l of tickListeners) l();
}

function emitMeta(): void {
  for (const l of metaListeners) l();
}

function applyState(s: TimerStateView): void {
  const remaining =
    s.current_interval?.target_sec != null
      ? Math.max(
          0,
          s.current_interval.target_sec - s.current_interval.elapsed_sec,
        )
      : null;

  const nextTick: TickState = {
    elapsed_sec: s.elapsed_sec,
    interval_elapsed: s.current_interval?.elapsed_sec ?? 0,
    interval_remaining: remaining,
  };

  const nextMeta: MetaState = {
    status: s.status,
    session_id: s.session_id,
    started_at: s.started_at,
    mode: s.mode,
    tags: s.tags,
    questions_done: s.questions_done,
    current_interval: s.current_interval
      ? {
          type: s.current_interval.type,
          start_sec: s.current_interval.start_sec,
          target_sec: s.current_interval.target_sec ?? null,
        }
      : null,
    completed_intervals: s.completed_intervals,
  };

  tickSnapshot = nextTick;
  metaSnapshot = nextMeta;
  emitTick();
  emitMeta();
}

async function refreshNow(): Promise<void> {
  try {
    const s = await invoke<TimerStateView>("get_timer_state");
    applyState(s);
  } catch (e) {
    console.error("get_timer_state failed", e);
  }
}

let metaBridgeStarted = false;
const metaBridgeUnlisteners: Promise<UnlistenFn>[] = [];

function activateMetaBridge(): void {
  if (metaBridgeStarted) return;
  metaBridgeStarted = true;
  refreshNow();
  for (const name of REFRESH_EVENTS) {
    metaBridgeUnlisteners.push(listen(name, () => refreshNow()));
  }
}

let tickBridgeUnlisten: Promise<UnlistenFn> | null = null;

function activateTickBridge(): void {
  if (tickBridgeUnlisten) return;
  tickBridgeUnlisten = listen<TickPayload>("session:tick", (evt) => {
    const { elapsed_sec, interval_elapsed, interval_remaining } = evt.payload;
    tickSnapshot = { elapsed_sec, interval_elapsed, interval_remaining };
    emitTick();
  });
}

function deactivateTickBridge(): void {
  if (!tickBridgeUnlisten) return;
  const promise = tickBridgeUnlisten;
  tickBridgeUnlisten = null;
  promise
    .then((fn) => fn())
    .catch((e) => console.error("unlisten session:tick failed", e));
}

function getTickSnapshot(): TickState {
  return tickSnapshot;
}

function getMetaSnapshot(): MetaState | null {
  return metaSnapshot;
}

export function useMetaState(): MetaState | null {
  const subscribe = useCallback((onChange: () => void) => {
    activateMetaBridge();
    metaListeners.add(onChange);
    return () => {
      metaListeners.delete(onChange);
    };
  }, []);
  return useSyncExternalStore(subscribe, getMetaSnapshot, getMetaSnapshot);
}

/**
 * Subscribe to the 1Hz tick state. Pass `enabled = false` to suspend the
 * Tauri `session:tick` listener entirely while a hidden window does not
 * need updates (P-H4). When the last consumer disables, the underlying
 * Tauri listener is detached so the event no longer crosses the IPC
 * boundary into this webview.
 */
export function useTickState(enabled: boolean = true): TickState {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!enabled) return () => {};
      activateMetaBridge();
      activateTickBridge();
      tickListeners.add(onChange);
      return () => {
        tickListeners.delete(onChange);
        if (tickListeners.size === 0) {
          deactivateTickBridge();
        }
      };
    },
    [enabled],
  );
  return useSyncExternalStore(subscribe, getTickSnapshot, getTickSnapshot);
}

/** Force a refresh from the backend. Used by the overlay after it becomes
 *  visible again — meta events fire reliably but the local snapshot can be
 *  stale if the overlay was hidden across a session boundary. */
export async function refreshTimerState(): Promise<void> {
  await refreshNow();
}
