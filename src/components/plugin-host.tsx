import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  createPluginAPI,
  type PluginEventCallback,
} from "../lib/plugin-api";
import type { PluginDescriptor } from "../lib/plugins";

interface PluginNotification {
  id: string;
  pluginId: string;
  message: string;
}

interface SlotEntry {
  pluginId: string;
  html: string;
}

interface PluginContextValue {
  plugins: PluginDescriptor[];
  loaded: boolean;
  reload: () => Promise<void>;
  setPluginEnabled: (id: string, enabled: boolean) => Promise<void>;
  slots: Record<string, SlotEntry[]>;
  notifications: PluginNotification[];
  dismissNotification: (id: string) => void;
}

const PluginContext = createContext<PluginContextValue | null>(null);

export function usePlugins(): PluginContextValue {
  const ctx = useContext(PluginContext);
  if (!ctx) throw new Error("usePlugins must be used inside PluginHost");
  return ctx;
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
    (pluginId: string, slot: string, html: string) => {
      setSlots((prev) => {
        const current = prev[slot] ?? [];
        const filtered = current.filter((s) => s.pluginId !== pluginId);
        return { ...prev, [slot]: [...filtered, { pluginId, html }] };
      });
    },
    [],
  );

  const showNotification = useCallback(
    (
      pluginId: string,
      message: string,
      options?: { duration?: number },
    ) => {
      const id = Math.random().toString(36).slice(2, 10);
      const duration = options?.duration ?? 3000;
      setNotifications((prev) => [...prev, { id, pluginId, message }]);
      window.setTimeout(() => {
        setNotifications((prev) => prev.filter((n) => n.id !== id));
      }, duration);
    },
    [],
  );

  const dismissNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

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
        // eslint-disable-next-line no-new-func
        const runner = new Function("flint", p.source);
        runner(api);
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
      }}
    >
      {children}
    </PluginContext.Provider>
  );
}
