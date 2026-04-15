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
import {
  clearAllHooks,
  clearPluginHooks,
  collectAfterHooks,
  collectBeforeHooks,
  createHookRegistry,
  registerAfterHook,
  registerBeforeHook,
  type HookContext,
  type HookHandler,
  type HookRegistry,
} from "../lib/hook-registry";
import type {
  FlintCommand,
  RegisteredCommand,
} from "../lib/command-registry";

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
// FIX 4: hard auto-dismiss timeout. Non-negotiable — plugins cannot override
// this via `options.duration`. Keeps notifications ephemeral so a buggy
// plugin cannot flood and pin the UI.
const NOTIFICATION_AUTO_DISMISS_MS = 4_000;
// FIX 3: hard timeout for a single plugin event callback. If a handler
// takes longer than this, we log an error and move on so one slow plugin
// cannot wedge the host.
const PLUGIN_CALLBACK_TIMEOUT_MS = 5_000;

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
  /** Current command registry snapshot. Updates reactively so the palette
   *  re-renders when commands are added/removed. */
  commands: RegisteredCommand[];
  /** Register a command owned by the core app (not a plugin). Used by
   *  App.tsx to publish core:* commands. Returns an unsubscribe function. */
  registerCoreCommand: (command: FlintCommand) => () => void;
  /** Register a before-hook owned by the core app. Used when core code needs
   *  to intercept its own events (rare — mostly plugins register hooks). */
  registerCoreHook: (event: string, handler: HookHandler) => () => void;
  /** Run the before-hook pipeline synchronously. Returns `true` if any
   *  handler cancelled. Core code calls this before dispatching an action. */
  runBeforeHooks: (event: string, context: HookContext) => Promise<boolean>;
  /** Fire after-hooks for an event. Called by the Tauri event bridge and
   *  by core code when a pure-frontend event completes. */
  dispatchAfterHooks: (event: string, payload: unknown) => void;
  /** Execute a registered command by id. Runs `before:command:execute`,
   *  the command callback, then after-hooks. Updates MRU ordering. */
  executeCommand: (id: string, source: string) => Promise<void>;
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

const CORE_OWNER = "__core__";

// Command MRU — exposed as a module-level singleton so the palette can read
// recency without re-subscribing. Safe because it's per-process; PluginHost
// only mounts once. `executeCommand` bumps the timestamp; `searchCommands`
// reads it during scoring.
const commandMruShared = new Map<string, number>();

export function getCommandMru(): Map<string, number> {
  return commandMruShared;
}

export function PluginHost({ children }: { children: React.ReactNode }) {
  const [plugins, setPlugins] = useState<PluginDescriptor[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [slots, setSlots] = useState<Record<string, SlotEntry[]>>({});
  const [notifications, setNotifications] = useState<PluginNotification[]>([]);
  const [commands, setCommands] = useState<RegisteredCommand[]>([]);

  const hookRegistryRef = useRef<HookRegistry>(createHookRegistry());
  // event name → active Tauri unlisten function (or cancel-sentinel for pending)
  const unlistenersRef = useRef<Map<string, UnlistenFn>>(new Map());
  // Last-seen timestamps keyed by `${pluginId}::${message}`. Pruned opportunistically
  // in showNotification so the map does not grow without bound.
  const notifyDedupRef = useRef<Map<string, number>>(new Map());
  // Active auto-dismiss timers, keyed by notification id, so we can cancel
  // them if the user dismisses manually or the stack-limit drops them first.
  const notifyTimersRef = useRef<Map<string, number>>(new Map());
  // FIX 4: live count of visible notifications, mirrored from setNotifications.
  // Read synchronously outside the updater to enforce the stack cap without
  // relying on React Strict Mode double-invoking the state updater (which
  // would corrupt an `accepted` flag captured in closure).
  const notifyCountRef = useRef(0);
  // FIX 4: master kill-switch for the notification system. Flipped false
  // during plugin reload/tearDown so any in-flight notify call from an
  // outgoing plugin is dropped before it touches React state. Prevents
  // orphan toasts accumulating across a plugin reload.
  const notificationsEnabledRef = useRef(true);

  /**
   * FIX 3: run a plugin callback with a 5-second hard timeout. If it throws
   * synchronously, rejects a promise, or never resolves, the host logs and
   * moves on — a buggy plugin must never crash the app.
   */
  const safeCallPlugin = useCallback(
    (pluginId: string, event: string, cb: PluginEventCallback, payload: unknown) => {
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        console.error(
          `[plugin ${pluginId}] handler "${event}" timed out after ${PLUGIN_CALLBACK_TIMEOUT_MS}ms`,
        );
      }, PLUGIN_CALLBACK_TIMEOUT_MS);

      const clear = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
      };

      try {
        const result = cb(payload);
        if (result && typeof (result as Promise<unknown>).then === "function") {
          (result as Promise<unknown>)
            .catch((err) =>
              console.error(
                `[plugin ${pluginId}] handler "${event}" rejected:`,
                err,
              ),
            )
            .finally(clear);
        } else {
          clear();
        }
      } catch (err) {
        clear();
        console.error(`[plugin ${pluginId}] handler "${event}" threw:`, err);
      }
    },
    [],
  );

  /**
   * Run a before-hook handler with the same 5-second budget, but await the
   * result so the caller can honour `{ cancel: true }`. Returns the handler's
   * return value, or `undefined` if it timed out / threw.
   */
  const safeCallHook = useCallback(
    async (
      pluginId: string,
      event: string,
      handler: HookHandler,
      context: HookContext,
    ): Promise<void | { cancel?: boolean }> => {
      let timeoutHandle: number | undefined;
      const timeoutPromise = new Promise<undefined>((resolve) => {
        timeoutHandle = window.setTimeout(() => {
          console.error(
            `[plugin ${pluginId}] before-hook "${event}" timed out after ${PLUGIN_CALLBACK_TIMEOUT_MS}ms`,
          );
          resolve(undefined);
        }, PLUGIN_CALLBACK_TIMEOUT_MS);
      });
      try {
        const value = await Promise.race([
          Promise.resolve(handler(context)),
          timeoutPromise,
        ]);
        if (timeoutHandle != null) window.clearTimeout(timeoutHandle);
        return value ?? undefined;
      } catch (err) {
        if (timeoutHandle != null) window.clearTimeout(timeoutHandle);
        console.error(
          `[plugin ${pluginId}] before-hook "${event}" threw:`,
          err,
        );
        return undefined;
      }
    },
    [],
  );

  const dispatchAfterHooks = useCallback(
    (event: string, payload: unknown) => {
      const handlers = collectAfterHooks(hookRegistryRef.current, event);
      for (const { pluginId, handler } of handlers) {
        safeCallPlugin(pluginId, event, handler, payload);
      }
    },
    [safeCallPlugin],
  );

  const runBeforeHooks = useCallback(
    async (event: string, context: HookContext): Promise<boolean> => {
      const handlers = collectBeforeHooks(hookRegistryRef.current, event);
      for (const { pluginId, handler } of handlers) {
        const result = await safeCallHook(pluginId, event, handler, context);
        if (result && typeof result === "object" && result.cancel === true) {
          return true;
        }
      }
      return false;
    },
    [safeCallHook],
  );

  const runEmitPipeline = useCallback(
    async (
      event: string,
      context: HookContext,
    ): Promise<{ cancelled: boolean }> => {
      const cancelled = await runBeforeHooks(event, context);
      if (cancelled) return { cancelled: true };
      dispatchAfterHooks(event, context);
      return { cancelled: false };
    },
    [runBeforeHooks, dispatchAfterHooks],
  );

  const ensureListener = useCallback(
    (event: string) => {
      if (unlistenersRef.current.has(event)) return;
      let canceled = false;
      const cancel: UnlistenFn = () => {
        canceled = true;
      };
      unlistenersRef.current.set(event, cancel);
      listen(event, (evt) => dispatchAfterHooks(event, evt.payload))
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
    [dispatchAfterHooks],
  );

  /**
   * `flint.on(event, handler)` — registers an after-hook. This is the
   * existing plugin API; it now maps to the hook registry's after bucket
   * so the pipeline can dispatch to it uniformly. Also ensures a Tauri
   * event listener is attached so engine-emitted events reach handlers.
   */
  const subscribe = useCallback(
    (pluginId: string, event: string, cb: PluginEventCallback) => {
      registerAfterHook(hookRegistryRef.current, pluginId, event, cb);
      ensureListener(event);
    },
    [ensureListener],
  );

  const registerHookForPlugin = useCallback(
    (pluginId: string, event: string, handler: HookHandler) => {
      return registerBeforeHook(
        hookRegistryRef.current,
        pluginId,
        event,
        handler,
      );
    },
    [],
  );

  const registerCoreHook = useCallback(
    (event: string, handler: HookHandler) => {
      return registerBeforeHook(
        hookRegistryRef.current,
        CORE_OWNER,
        event,
        handler,
      );
    },
    [],
  );

  const registerCommandForOwner = useCallback(
    (owner: string, command: FlintCommand): (() => void) => {
      const registered: RegisteredCommand = { ...command, owner };
      setCommands((prev) => {
        const filtered = prev.filter((c) => c.id !== command.id);
        if (prev.length !== filtered.length) {
          console.warn(
            `[plugin-host] command "${command.id}" re-registered — last registration wins`,
          );
        }
        return [...filtered, registered];
      });
      return () => {
        setCommands((prev) =>
          prev.filter((c) => !(c.id === command.id && c.owner === owner)),
        );
      };
    },
    [],
  );

  const registerPluginCommand = useCallback(
    (pluginId: string, command: FlintCommand) => {
      return registerCommandForOwner(pluginId, command);
    },
    [registerCommandForOwner],
  );

  const registerCoreCommand = useCallback(
    (command: FlintCommand) => {
      return registerCommandForOwner(CORE_OWNER, command);
    },
    [registerCommandForOwner],
  );

  const commandsRef = useRef<RegisteredCommand[]>([]);
  commandsRef.current = commands;

  const executeCommand = useCallback(
    async (id: string, source: string) => {
      const command = commandsRef.current.find((c) => c.id === id);
      if (!command) {
        console.warn(`[plugin-host] executeCommand: unknown id "${id}"`);
        return;
      }
      commandMruShared.set(id, Date.now());
      const ctx: HookContext = { command_id: id, source };
      const cancelled = await runBeforeHooks("command:execute", ctx);
      if (cancelled) return;
      try {
        await Promise.resolve(command.callback());
      } catch (err) {
        console.error(
          `[plugin-host] command "${id}" (${command.owner}) threw:`,
          err,
        );
      }
      dispatchAfterHooks("command:execute", ctx);
    },
    [runBeforeHooks, dispatchAfterHooks],
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

  const actuallyShowNotification = useCallback(
    (pluginId: string, message: string, ctx: HookContext) => {
      if (!notificationsEnabledRef.current) return;
      const now = Date.now();
      const dedupKey = `${pluginId}::${message}`;
      const lastSeen = notifyDedupRef.current.get(dedupKey);
      if (lastSeen != null && now - lastSeen < NOTIFICATION_DEDUP_MS) {
        return;
      }
      for (const [k, ts] of notifyDedupRef.current) {
        if (now - ts >= NOTIFICATION_DEDUP_MS) {
          notifyDedupRef.current.delete(k);
        }
      }
      notifyDedupRef.current.set(dedupKey, now);

      if (notifyCountRef.current >= NOTIFICATION_STACK_LIMIT) return;

      const id = Math.random().toString(36).slice(2, 10);
      notifyCountRef.current += 1;
      setNotifications((prev) => [...prev, { id, pluginId, message }]);
      const timerId = window.setTimeout(() => {
        notifyTimersRef.current.delete(id);
        notifyCountRef.current = Math.max(0, notifyCountRef.current - 1);
        setNotifications((prev) => prev.filter((n) => n.id !== id));
      }, NOTIFICATION_AUTO_DISMISS_MS);
      notifyTimersRef.current.set(id, timerId);

      dispatchAfterHooks("notification:show", ctx);
    },
    [dispatchAfterHooks],
  );

  const showNotification = useCallback(
    (pluginId: string, message: string, _options?: { duration?: number }) => {
      // FIX 4: master kill-switch — if notifications are disabled during a
      // plugin reload, silently drop the call. Prevents orphan toasts.
      if (!notificationsEnabledRef.current) return;

      // Hook pipeline: before:notification:show can cancel or mutate text.
      const ctx: HookContext = {
        title: pluginId,
        body: message,
        plugin_id: pluginId,
      };
      void runBeforeHooks("notification:show", ctx).then((cancelled) => {
        if (cancelled) return;
        const finalMessage =
          typeof ctx.body === "string" ? ctx.body : message;
        const finalPluginId =
          typeof ctx.plugin_id === "string" ? ctx.plugin_id : pluginId;
        actuallyShowNotification(finalPluginId, finalMessage, ctx);
      });
    },
    [runBeforeHooks, actuallyShowNotification],
  );

  const dismissNotification = useCallback(
    (id: string) => {
      clearNotifyTimer(id);
      notifyCountRef.current = Math.max(0, notifyCountRef.current - 1);
      setNotifications((prev) => prev.filter((n) => n.id !== id));
    },
    [clearNotifyTimer],
  );

  const tearDown = useCallback(() => {
    // FIX 4: close the gate before we start ripping state out so any
    // in-flight notify() call from a plugin we're about to unload is
    // silently dropped. reload() will flip it back on once the new
    // plugin set has finished initialising.
    notificationsEnabledRef.current = false;
    for (const [, unlisten] of unlistenersRef.current) {
      try {
        unlisten();
      } catch (e) {
        console.error("[plugin-host] unlisten error:", e);
      }
    }
    unlistenersRef.current.clear();
    // Wipe every hook/command owned by a plugin, but leave core-owned
    // registrations in place — AppShell registers them once at mount and
    // does not re-register on reload.
    const registry = hookRegistryRef.current;
    const pluginOwners = new Set<string>();
    for (const byPlugin of registry.before.values()) {
      for (const owner of byPlugin.keys()) {
        if (owner !== CORE_OWNER) pluginOwners.add(owner);
      }
    }
    for (const byPlugin of registry.after.values()) {
      for (const owner of byPlugin.keys()) {
        if (owner !== CORE_OWNER) pluginOwners.add(owner);
      }
    }
    for (const owner of pluginOwners) {
      clearPluginHooks(registry, owner);
    }
    setCommands((prev) => prev.filter((c) => c.owner === CORE_OWNER));

    for (const [, timerId] of notifyTimersRef.current) {
      window.clearTimeout(timerId);
    }
    notifyTimersRef.current.clear();
    notifyDedupRef.current.clear();
    notifyCountRef.current = 0;
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
      // FIX 4: open the notification gate even on error so the rest of
      // the app can still surface host-side toasts (error boundary, etc).
      notificationsEnabledRef.current = true;
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
          registerHook: registerHookForPlugin,
          registerCommand: registerPluginCommand,
          runEmitPipeline,
        });
        runInSandbox(p.source, api);
      } catch (e) {
        console.error(
          `[plugin ${p.manifest.id}] activation failed:`,
          e,
        );
      }
    }
    // FIX 4: plugins are initialised — safe to accept notifications again.
    notificationsEnabledRef.current = true;
    setLoaded(true);
    // Fire app:ready so any plugin that needs post-load setup hears it.
    dispatchAfterHooks("app:ready", {});
  }, [
    renderSlot,
    showNotification,
    subscribe,
    tearDown,
    registerHookForPlugin,
    registerPluginCommand,
    runEmitPipeline,
    dispatchAfterHooks,
  ]);

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
      // Fire app:quit before cleanup so any hook can observe shutdown.
      dispatchAfterHooks("app:quit", {});
      tearDown();
      clearAllHooks(hookRegistryRef.current);
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
        commands,
        registerCoreCommand,
        registerCoreHook,
        runBeforeHooks,
        dispatchAfterHooks,
        executeCommand,
      }}
    >
      {children}
    </PluginContext.Provider>
  );
}

