/**
 * Hook registry — the spine of the sandbox primitive layer.
 *
 * Every significant action in Flint fires a two-phase hook:
 *   before:<event>  — interceptors. Sequential, can mutate ctx, can cancel.
 *   after:<event>   — observers. Fire-and-forget, cannot cancel.
 *
 * `flint.hook(event, handler)` registers a before-hook.
 * `flint.on(event, handler)`   registers an after-hook (existing API, unchanged).
 *
 * Handlers are tracked by plugin id so `tearDown` can unregister everything
 * belonging to a plugin when it reloads — the Obsidian Component pattern.
 */

export type HookContext = Record<string, unknown>;

export interface HookResult {
  cancel?: boolean;
}

export type HookHandler = (
  context: HookContext,
) => void | HookResult | Promise<void | HookResult>;

export type AfterHookHandler = (payload: unknown) => void | Promise<void>;

export interface HookRegistry {
  /** event → pluginId → Set<handler> */
  before: Map<string, Map<string, Set<HookHandler>>>;
  after: Map<string, Map<string, Set<AfterHookHandler>>>;
}

export function createHookRegistry(): HookRegistry {
  return {
    before: new Map(),
    after: new Map(),
  };
}

function addToNested<H>(
  map: Map<string, Map<string, Set<H>>>,
  event: string,
  pluginId: string,
  handler: H,
): void {
  let byPlugin = map.get(event);
  if (!byPlugin) {
    byPlugin = new Map();
    map.set(event, byPlugin);
  }
  let handlers = byPlugin.get(pluginId);
  if (!handlers) {
    handlers = new Set();
    byPlugin.set(pluginId, handlers);
  }
  handlers.add(handler);
}

function removeFromNested<H>(
  map: Map<string, Map<string, Set<H>>>,
  event: string,
  pluginId: string,
  handler: H,
): void {
  const byPlugin = map.get(event);
  if (!byPlugin) return;
  const handlers = byPlugin.get(pluginId);
  if (!handlers) return;
  handlers.delete(handler);
  if (handlers.size === 0) byPlugin.delete(pluginId);
  if (byPlugin.size === 0) map.delete(event);
}

export function registerBeforeHook(
  registry: HookRegistry,
  pluginId: string,
  event: string,
  handler: HookHandler,
): () => void {
  addToNested(registry.before, event, pluginId, handler);
  return () => removeFromNested(registry.before, event, pluginId, handler);
}

export function registerAfterHook(
  registry: HookRegistry,
  pluginId: string,
  event: string,
  handler: AfterHookHandler,
): () => void {
  addToNested(registry.after, event, pluginId, handler);
  return () => removeFromNested(registry.after, event, pluginId, handler);
}

/** Clear all handlers owned by a plugin. Called on plugin unload. */
export function clearPluginHooks(
  registry: HookRegistry,
  pluginId: string,
): void {
  for (const byPlugin of registry.before.values()) {
    byPlugin.delete(pluginId);
  }
  for (const byPlugin of registry.after.values()) {
    byPlugin.delete(pluginId);
  }
}

export function clearAllHooks(registry: HookRegistry): void {
  registry.before.clear();
  registry.after.clear();
}

/**
 * Collect every before-hook handler for an event in registration order.
 * Returns an array so callers can iterate synchronously without re-walking
 * the nested Maps on each hop.
 */
export function collectBeforeHooks(
  registry: HookRegistry,
  event: string,
): Array<{ pluginId: string; handler: HookHandler }> {
  const byPlugin = registry.before.get(event);
  if (!byPlugin) return [];
  const out: Array<{ pluginId: string; handler: HookHandler }> = [];
  for (const [pluginId, handlers] of byPlugin) {
    for (const handler of handlers) {
      out.push({ pluginId, handler });
    }
  }
  return out;
}

/**
 * Fast-path probe: is there at least one before-hook registered for this
 * event? [C-3] uses this to skip the pipeline overhead when no plugin has
 * subscribed — the keyboard handler can call `invoke(...)` directly with no
 * perceptible latency in the common (no plugin) case.
 */
export function hasBeforeHooks(
  registry: HookRegistry,
  event: string,
): boolean {
  const byPlugin = registry.before.get(event);
  if (!byPlugin) return false;
  for (const handlers of byPlugin.values()) {
    if (handlers.size > 0) return true;
  }
  return false;
}

export function collectAfterHooks(
  registry: HookRegistry,
  event: string,
): Array<{ pluginId: string; handler: AfterHookHandler }> {
  const byPlugin = registry.after.get(event);
  if (!byPlugin) return [];
  const out: Array<{ pluginId: string; handler: AfterHookHandler }> = [];
  for (const [pluginId, handlers] of byPlugin) {
    for (const handler of handlers) {
      out.push({ pluginId, handler });
    }
  }
  return out;
}
