import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  createPluginAPI,
  type PluginEventCallback,
} from "../lib/plugin-api";
import { runInSandbox } from "../lib/plugin-sandbox";
import type { PluginDescriptor } from "../lib/plugins";
import type { TimerModeInfo } from "../lib/types";

interface PluginNotification {
  id: string;
  pluginId: string;
  message: string;
}

// Cap on how many notifications can be visible at once. A 4th push drops the
// oldest so rapid-fire plugins (e.g. Pomodoro cycling short intervals during
// testing) can't stack to infinity and crash the app.
const NOTIFICATION_STACK_LIMIT = 3;
// Same-message dedup window. Re-sending an identical (pluginId, message)
// within this window is a no-op — prevents a misfiring plugin from flooding
// the UI with duplicates.
const NOTIFICATION_DEDUP_MS = 10_000;
// Default auto-dismiss. Plugins may override via options.duration.
const NOTIFICATION_DEFAULT_DURATION_MS = 5_000;

interface SlotEntry {
  pluginId: string;
  /** Plain text payload — rendered as React text content (not HTML) so a
   *  plugin cannot inject script into the host webview (S-C2). */
  text: string;
}

interface PluginContextValue {
  plugins: PluginDescriptor[];
  loaded: boolean;
  reload: () => Promise<void>;
  setPluginEnabled: (id: string, enabled: boolean) => Promise<void>;
  slots: Record<string, SlotEntry[]>;
  notifications: PluginNotification[];
  dismissNotification: (id: string) => void;
  /** Enabled timer-mode plugins in registration order. Drives Ctrl+N, the
   *  default-mode dropdown, and every other UI surface that lists modes. */
  timerModes: TimerModeInfo[];
}

const PluginContext = createContext<PluginContextValue | null>(null);

export function usePlugins(): PluginContextValue {
  const ctx = useContext(PluginContext);
  if (!ctx) throw new Error("usePlugins must be used inside PluginHost");
  return ctx;
}

/**
 * Read the dynamic list of enabled timer-mode plugins. Used by any surface
 * that needs to enumerate modes (keyboard shortcuts, tray, settings
 * dropdown, idle placeholder) so nothing has to hardcode pomodoro / stopwatch
 * / countdown.
 */
export function useTimerModes(): TimerModeInfo[] {
  return usePlugins().timerModes;
}

export function PluginHost({ children }: { children: React.ReactNode }) {
  const [plugins, setPlugins] = useState<PluginDescriptor[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [slots, setSlots] = useState<Record<string, SlotEntry[]>>({});
  const [notifications, setNotifications] = useState<PluginNotification[]>([]);

  // event name → pluginId → Set<callback>
  const subscribersRef = useRef<
    Map<string, Map<string, Set<PluginEventCallback>>>
  >(new Map());
  // event name → active Tauri unlisten function (or cancel-sentinel for pending)
  const unlistenersRef = useRef<Map<string, UnlistenFn>>(new Map());
  // Last-seen timestamps keyed by `${pluginId}::${message}`. Pruned opportunistically
  // in showNotification so the map does not grow without bound.
  const notifyDedupRef = useRef<Map<string, number>>(new Map());
  // Active auto-dismiss timers, keyed by notification id, so we can cancel
  // them if the user dismisses manually or the stack-limit drops them first.
  const notifyTimersRef = useRef<Map<string, number>>(new Map());

  const dispatchEvent = useCallback((event: string, payload: unknown) => {
    const byPlugin = subscribersRef.current.get(event);
    if (!byPlugin) return;
    for (const [pluginId, callbacks] of byPlugin) {
      for (const cb of callbacks) {
        try {
          const result = cb(payload);
          if (result && typeof (result as Promise<unknown>).catch === "function") {
            (result as Promise<unknown>).catch((err) =>
              console.error(
                `[plugin ${pluginId}] handler "${event}" rejected:`,
                err,
              ),
            );
          }
        } catch (e) {
          console.error(`[plugin ${pluginId}] handler "${event}" threw:`, e);
        }
      }
    }
  }, []);

  const ensureListener = useCallback(
    (event: string) => {
      if (unlistenersRef.current.has(event)) return;
      let canceled = false;
      const cancel: UnlistenFn = () => {
        canceled = true;
      };
      unlistenersRef.current.set(event, cancel);
      listen(event, (evt) => dispatchEvent(event, evt.payload))
        .then((realUnlisten) => {
          if (canceled) {
            realUnlisten();
            return;
          }
          unlistenersRef.current.set(event, realUnlisten);
        })
        .catch((e) => {
          console.error(`[plugin-host] listen("${event}") failed:`, e);
          if (unlistenersRef.current.get(event) === cancel) {
            unlistenersRef.current.delete(event);
          }
        });
    },
    [dispatchEvent],
  );

  const subscribe = useCallback(
    (pluginId: string, event: string, cb: PluginEventCallback) => {
      const subs = subscribersRef.current;
      let byPlugin = subs.get(event);
      if (!byPlugin) {
        byPlugin = new Map();
        subs.set(event, byPlugin);
      }
      let callbacks = byPlugin.get(pluginId);
      if (!callbacks) {
        callbacks = new Set();
        byPlugin.set(pluginId, callbacks);
      }
      callbacks.add(cb);
      ensureListener(event);
    },
    [ensureListener],
  );

  const renderSlot = useCallback(
    (pluginId: string, slot: string, text: string) => {
      setSlots((prev) => {
        const current = prev[slot] ?? [];
        const filtered = current.filter((s) => s.pluginId !== pluginId);
        return { ...prev, [slot]: [...filtered, { pluginId, text }] };
      });
    },
    [],
  );

  const clearNotifyTimer = useCallback((id: string) => {
    const existing = notifyTimersRef.current.get(id);
    if (existing != null) {
      window.clearTimeout(existing);
      notifyTimersRef.current.delete(id);
    }
  }, []);

  const showNotification = useCallback(
    (
      pluginId: string,
      message: string,
      options?: { duration?: number },
    ) => {
      const now = Date.now();
      const dedupKey = `${pluginId}::${message}`;
      const lastSeen = notifyDedupRef.current.get(dedupKey);
      if (lastSeen != null && now - lastSeen < NOTIFICATION_DEDUP_MS) {
        // Same notification fired recently — drop it so a misbehaving plugin
        // cannot stack identical toasts on top of each other.
        return;
      }
      // Opportunistic prune: drop dedup entries older than the window so the
      // map stays bounded over long sessions.
      for (const [k, ts] of notifyDedupRef.current) {
        if (now - ts >= NOTIFICATION_DEDUP_MS) {
          notifyDedupRef.current.delete(k);
        }
      }
      notifyDedupRef.current.set(dedupKey, now);

      const id = Math.random().toString(36).slice(2, 10);
      const duration = Math.max(
        500,
        options?.duration ?? NOTIFICATION_DEFAULT_DURATION_MS,
      );
      setNotifications((prev) => {
        const next = [...prev, { id, pluginId, message }];
        // Enforce the stack cap: drop the oldest entries and cancel their
        // pending auto-dismiss timers so we don't race with them.
        while (next.length > NOTIFICATION_STACK_LIMIT) {
          const dropped = next.shift();
          if (dropped) clearNotifyTimer(dropped.id);
        }
        return next;
      });
      const timerId = window.setTimeout(() => {
        notifyTimersRef.current.delete(id);
        setNotifications((prev) => prev.filter((n) => n.id !== id));
      }, duration);
      notifyTimersRef.current.set(id, timerId);
    },
    [clearNotifyTimer],
  );

  const dismissNotification = useCallback(
    (id: string) => {
      clearNotifyTimer(id);
      setNotifications((prev) => prev.filter((n) => n.id !== id));
    },
    [clearNotifyTimer],
  );

  const tearDown = useCallback(() => {
    for (const [, unlisten] of unlistenersRef.current) {
      try {
        unlisten();
      } catch (e) {
        console.error("[plugin-host] unlisten error:", e);
      }
    }
    unlistenersRef.current.clear();
    subscribersRef.current.clear();
    for (const [, timerId] of notifyTimersRef.current) {
      window.clearTimeout(timerId);
    }
    notifyTimersRef.current.clear();
    notifyDedupRef.current.clear();
    // P-H2: drop any toasts still on screen so a reload (e.g. enabling/
    // disabling a plugin mid-Pomodoro) cannot leave orphan notifications
    // whose auto-dismiss timers were just cancelled above.
    setNotifications([]);
  }, []);

  const reload = useCallback(async () => {
    tearDown();
    setSlots({});

    let list: PluginDescriptor[] = [];
    try {
      list = await invoke<PluginDescriptor[]>("list_plugins");
    } catch (e) {
      console.error("[plugin-host] list_plugins failed:", e);
      setLoaded(true);
      return;
    }
    setPlugins(list);

    for (const p of list) {
      if (!p.enabled) continue;
      try {
        const api = createPluginAPI(p.manifest.id, {
          subscribe,
          renderSlot,
          showNotification,
        });
        runInSandbox(p.source, api);
      } catch (e) {
        console.error(
          `[plugin ${p.manifest.id}] activation failed:`,
          e,
        );
      }
    }
    setLoaded(true);
  }, [renderSlot, showNotification, subscribe, tearDown]);

  const setPluginEnabled = useCallback(
    async (pluginId: string, enabled: boolean) => {
      await invoke("set_plugin_enabled", { pluginId, enabled });
      await reload();
    },
    [reload],
  );

  useEffect(() => {
    reload();
    return () => {
      tearDown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const timerModes = useMemo<TimerModeInfo[]>(
    () =>
      plugins
        .filter((p) => p.enabled && p.manifest.timer_mode === true)
        .map((p) => ({ id: p.manifest.id, label: p.manifest.name })),
    [plugins],
  );

  return (
    <PluginContext.Provider
      value={{
        plugins,
        loaded,
        reload,
        setPluginEnabled,
        slots,
        notifications,
        dismissNotification,
        timerModes,
      }}
    >
      {children}
    </PluginContext.Provider>
  );
}
