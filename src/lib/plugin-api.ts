import { invoke } from "@tauri-apps/api/core";
import type { TimerStateView } from "./types";
import type { HookContext, HookHandler } from "./hook-registry";
import type { FlintCommand } from "./command-registry";
import type { RenderSpec } from "../components/plugin-view-renderer";
import { promptViaQueue, type PromptOptions, type PromptResult } from "./prompt-queue";

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
  registerView: (
    pluginId: string,
    slot: string,
    renderFn: () => RenderSpec | null,
  ) => () => void;
  runEmitPipeline: (
    event: string,
    context: HookContext,
  ) => Promise<{ cancelled: boolean }>;
}

/**
 * Interval directive that a plugin can hand to the engine via
 * setFirstInterval / setNextInterval. Mirrors the snake_case payload that
 * Tauri's IPC layer expects — Tauri auto-converts camelCase JS keys to
 * snake_case Rust args, so we use camelCase here for ergonomics.
 */
export interface IntervalDirective {
  type: string;
  target_sec?: number;
  metadata?: unknown;
}

export interface IntervalStateView {
  interval_type?: string;
  interval_elapsed?: number;
  interval_target?: number | null;
}

/**
 * Payload shape for `signal:*` emits. Populated by the keyboard, palette, or
 * another plugin when a user-initiated moment happens during a running
 * session. `source` distinguishes the origin so hook handlers can decide
 * whether to respond (e.g. a plugin might ignore programmatic signals).
 */
export interface SignalContext {
  session_id?: string;
  elapsed_sec?: number;
  source?: "keyboard" | "palette" | "plugin" | string;
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
  /**
   * Register a declarative render spec for a UI slot (currently
   * `sidebar-tab`). The host calls `renderFn` whenever the slot is
   * visible and renders the returned spec via PluginViewRenderer — a
   * sandboxed widget interpreter so plugins can describe charts, tables,
   * lists, and buttons without executing arbitrary React. Returns an
   * unsubscribe; auto-cleaned on plugin reload.
   */
  registerView(slot: string, renderFn: () => RenderSpec | null): () => void;
  getTimerState(): Promise<TimerStateView>;
  nextInterval(): Promise<void>;
  stopSession(): Promise<void>;
  pauseSession(): Promise<void>;
  resumeSession(): Promise<void>;
  /**
   * Emit a `signal:<name>` event through the hook pipeline. Sugar over
   * `flint.emit` with the standard `signal:*` namespace and a defaulted
   * `source: "plugin"`. Core already routes Enter keydowns through
   * `signal:mark`; plugins subscribe via `flint.on("signal:mark", …)` rather
   * than binding keys directly.
   */
  signal(name: string, payload?: SignalContext): Promise<{ cancelled: boolean }>;
  /**
   * Author the FIRST interval of the upcoming session. Plugins call this
   * inside a `before:session:start` hook to set the initial interval type
   * and target. Without this, custom timer modes get an untimed focus
   * interval. The Rust engine consumes the directive on the next
   * `start_session` call.
   */
  setFirstInterval(opts: IntervalDirective): Promise<void>;
  /**
   * Push the NEXT interval the engine will create when `next_interval`
   * fires. Plugins typically call this inside `interval:end` to author
   * multi-section sequences (Physics → Chemistry → Math) or dynamic
   * break durations (Flowtime).
   */
  setNextInterval(opts: IntervalDirective): Promise<void>;
  /**
   * Read the current interval slice — type, elapsed seconds, optional
   * target. Mirrors part of the timer state but stable across mode
   * changes. Returns an empty object when no session is active.
   */
  getIntervalState(): Promise<IntervalStateView>;
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
  /**
   * Show an interactive prompt with accept / decline buttons. Resolves to
   * `"accepted"`, `"declined"`, or `"dismissed"` (timeout / Esc). Only one
   * prompt is visible at a time; up to 3 may queue.
   */
  prompt(opts: PromptOptions): Promise<PromptResult>;
  /**
   * Pre-aggregated stats from the SQLite cache. Thin wrappers around the
   * existing Rust commands so analytics plugins do not have to rebuild
   * aggregates from raw session JSON. (See [H-7].)
   */
  stats: {
    today(): Promise<unknown>;
    range(scope: "week" | "month" | "all" | string): Promise<unknown>;
    heatmap(days: number): Promise<unknown>;
    lifetime(): Promise<unknown>;
  };
  /**
   * Preset CRUD exposed to plugins so that "preset packs" (e.g. Exam Mode
   * shipping JEE / NEET / SAT presets) can ship without touching the
   * filesystem. (See [H-5].)
   */
  presets: {
    list(): Promise<unknown[]>;
    save(preset: unknown): Promise<unknown>;
    delete(id: string): Promise<void>;
    load(id: string): Promise<unknown>;
  };
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
    registerView(slot, renderFn) {
      return host.registerView(pluginId, slot, renderFn);
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
    async signal(name, payload) {
      const ctx: HookContext = {
        ...(payload ?? {}),
        source: payload?.source ?? "plugin",
      } as HookContext;
      return host.runEmitPipeline(`signal:${name}`, ctx);
    },
    async setFirstInterval(opts) {
      // RUST_ENGINE adds set_first_interval(intervalType, targetSec, metadata).
      // Tauri's IPC layer auto-converts camelCase → snake_case, so the JS
      // names here become Rust args of the same name in snake_case.
      await invoke("set_first_interval", {
        intervalType: opts.type,
        targetSec: opts.target_sec ?? null,
        metadata: opts.metadata ?? null,
      });
    },
    async setNextInterval(opts) {
      await invoke("set_next_interval", {
        intervalType: opts.type,
        targetSec: opts.target_sec ?? null,
        metadata: opts.metadata ?? null,
      });
    },
    async getIntervalState() {
      const state = await invoke<TimerStateView>("get_timer_state");
      return {
        interval_type: state.current_interval?.type,
        interval_elapsed: state.current_interval?.elapsed_sec,
        interval_target: state.current_interval?.target_sec ?? null,
      };
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
    async prompt(opts) {
      return promptViaQueue(opts);
    },
    stats: {
      async today() {
        return invoke("stats_today");
      },
      async range(scope) {
        return invoke("stats_range", { scope });
      },
      async heatmap(days) {
        return invoke("stats_heatmap", { days });
      },
      async lifetime() {
        return invoke("stats_lifetime");
      },
    },
    presets: {
      async list() {
        return invoke<unknown[]>("list_presets");
      },
      async save(preset) {
        return invoke("save_preset", { preset });
      },
      async delete(id) {
        await invoke("delete_preset", { id });
      },
      async load(id) {
        return invoke("load_preset", { id });
      },
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
