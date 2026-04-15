import { invoke } from "@tauri-apps/api/core";
import type { TimerStateView } from "./types";
import type { HookContext, HookHandler } from "./hook-registry";
import type { FlintCommand } from "./command-registry";

export type PluginEventCallback = (payload: unknown) => void | Promise<void>;

export interface PluginHostHandles {
  subscribe: (pluginId: string, event: string, cb: PluginEventCallback) => void;
  renderSlot: (pluginId: string, slot: string, text: string) => void;
  showNotification: (
    pluginId: string,
    message: string,
    options?: { duration?: number },
  ) => void;
  registerHook: (
    pluginId: string,
    event: string,
    handler: HookHandler,
  ) => () => void;
  registerCommand: (pluginId: string, command: FlintCommand) => () => void;
  runEmitPipeline: (
    event: string,
    context: HookContext,
  ) => Promise<{ cancelled: boolean }>;
}

export interface FlintPluginAPI {
  on(event: string, callback: PluginEventCallback): void;
  /**
   * Broadcast a topic from a sandboxed plugin. Runs the full hook pipeline
   * (before → after), then fires a `window.CustomEvent("flint:plugin:${topic}")`
   * for legacy host-React listeners. The plugin itself never touches
   * `window` — which is shadowed inside the sandbox (S-C1).
   */
  emit(topic: string, payload?: unknown): Promise<{ cancelled: boolean }>;
  /**
   * Register a before-hook (interceptor). Handlers receive a context object
   * they can mutate, and can return `{ cancel: true }` to abort the action.
   * Returns an unsubscribe function; handlers are also auto-cleaned on
   * plugin reload.
   */
  hook(event: string, handler: HookHandler): () => void;
  /**
   * Register a command in the global command registry. Commands appear in
   * the palette (Ctrl+P) and can be bound to hotkeys. Returns an
   * unsubscribe function; commands are auto-cleaned on plugin reload.
   */
  registerCommand(command: FlintCommand): () => void;
  getTimerState(): Promise<TimerStateView>;
  nextInterval(): Promise<void>;
  stopSession(): Promise<void>;
  pauseSession(): Promise<void>;
  resumeSession(): Promise<void>;
  markQuestion(): Promise<void>;
  getSessions(options?: {
    limit?: number;
    tags?: string[];
    since?: string;
  }): Promise<unknown[]>;
  getCurrentSession(): Promise<TimerStateView | null>;
  getConfig(): Promise<Record<string, unknown>>;
  setConfig(key: string, value: unknown): Promise<void>;
  /**
   * Render plain text into a UI slot. The value is treated as text content
   * and React-escaped — never injected as HTML (S-C2).
   */
  renderSlot(slot: string, text: string): void;
  showNotification(
    message: string,
    options?: { duration?: number },
  ): void;
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
  };
}

export function createPluginAPI(
  pluginId: string,
  host: PluginHostHandles,
): FlintPluginAPI {
  return {
    on(event, cb) {
      host.subscribe(pluginId, event, cb);
    },
    async emit(topic, payload) {
      const ctx: HookContext =
        payload && typeof payload === "object"
          ? ({ ...(payload as Record<string, unknown>) } as HookContext)
          : ({ payload } as HookContext);
      const result = await host.runEmitPipeline(topic, ctx);
      if (!result.cancelled) {
        // Dispatched from host context — `window` is the real window here,
        // not the sandbox's `undefined` shadow. Listeners on the React side
        // subscribe to `flint:plugin:${topic}`.
        window.dispatchEvent(
          new CustomEvent(`flint:plugin:${topic}`, { detail: payload }),
        );
      }
      return result;
    },
    hook(event, handler) {
      return host.registerHook(pluginId, event, handler);
    },
    registerCommand(command) {
      return host.registerCommand(pluginId, command);
    },
    async getTimerState() {
      return invoke<TimerStateView>("get_timer_state");
    },
    async nextInterval() {
      await invoke("next_interval");
    },
    async stopSession() {
      await invoke("stop_session");
    },
    async pauseSession() {
      await invoke("pause_session");
    },
    async resumeSession() {
      await invoke("resume_session");
    },
    async markQuestion() {
      await invoke("mark_question");
    },
    async getSessions(options) {
      const all = await invoke<Array<Record<string, unknown>>>("list_sessions");
      let out = all;
      if (options?.tags && options.tags.length > 0) {
        const wanted = new Set(options.tags);
        out = out.filter((s) => {
          const tags = (s.tags as string[] | undefined) ?? [];
          return tags.some((t) => wanted.has(t));
        });
      }
      if (options?.since) {
        const since = options.since;
        out = out.filter((s) => {
          const started = s.started_at as string | undefined;
          return started != null && started >= since;
        });
      }
      if (options?.limit != null) {
        out = out.slice(0, options.limit);
      }
      return out;
    },
    async getCurrentSession() {
      const s = await invoke<TimerStateView>("get_timer_state");
      return s.status === "idle" ? null : s;
    },
    async getConfig() {
      return invoke<Record<string, unknown>>("get_plugin_config", {
        pluginId,
      });
    },
    async setConfig(key, value) {
      await invoke("set_plugin_config", { pluginId, key, value });
    },
    renderSlot(slot, text) {
      host.renderSlot(pluginId, slot, text);
    },
    showNotification(message, options) {
      host.showNotification(pluginId, message, options);
    },
    storage: {
      async get(key) {
        return invoke("plugin_storage_get", { pluginId, key });
      },
      async set(key, value) {
        await invoke("plugin_storage_set", { pluginId, key, value });
      },
      async delete(key) {
        await invoke("plugin_storage_delete", { pluginId, key });
      },
    },
  };
}
