/**
 * [C-3] Frontend wrappers for every timer action so the before-hook pipeline
 * runs even when the action was triggered by a keyboard shortcut, the overlay,
 * or a button click. Without these, plugins that register
 * `before:session:pause → cancel` are silently bypassed by Space.
 *
 * The wrappers are NOT React hooks; they are plain async functions that
 * accept the host runner + probe pair as arguments. App.tsx pulls those
 * from `usePlugins()`. The overlay window does NOT host the plugin
 * runtime, so it cannot call these helpers directly — instead it emits a
 * `flint:overlay-action` event that App.tsx's listener (in the main
 * window) translates into the matching wrapped* call so the before-hook
 * pipeline still runs for overlay-driven pause/resume/stop.
 *
 * The fast path: if `hasBeforeHooks(event) === false` the wrapper skips the
 * pipeline entirely and dispatches `invoke(...)` synchronously. With no
 * plugin subscribed, Space pause is exactly as fast as before.
 *
 * Event names match the after-event names already shipped by Rust
 * (`session:pause`, `session:resume`, `session:cancel`).
 */
import { invoke } from "@tauri-apps/api/core";
import type { HookContext } from "./hook-registry";

export interface TimerActionDeps {
  runBeforeHooks: (event: string, ctx: HookContext) => Promise<boolean>;
  hasBeforeHooks: (event: string) => boolean;
}

interface BaseOpts {
  /** Optional context the caller wants to expose to before-hooks. */
  context?: HookContext;
}

/**
 * Generic action runner — used by every wrapper below. Encapsulates the
 * fast-path probe, the cancel check, and the invoke catch.
 */
async function runAction(
  deps: TimerActionDeps,
  event: string,
  ctx: HookContext,
  invokeFn: () => Promise<void>,
  label: string,
): Promise<{ cancelled: boolean }> {
  if (!deps.hasBeforeHooks(event)) {
    try {
      await invokeFn();
    } catch (e) {
      console.error(`[timer-action] ${label} failed:`, e);
    }
    return { cancelled: false };
  }
  try {
    const cancelled = await deps.runBeforeHooks(event, ctx);
    if (cancelled) {
      // dev-time diagnostic so plugin authors can see when their hook fires
      if (import.meta.env.DEV) {
        console.info(`[timer-action] ${label} cancelled by before:${event}`);
      }
      return { cancelled: true };
    }
  } catch (err) {
    console.error(
      `[timer-action] before:${event} threw — proceeding without intercept:`,
      err,
    );
  }
  try {
    await invokeFn();
  } catch (e) {
    console.error(`[timer-action] ${label} failed:`, e);
  }
  return { cancelled: false };
}

export async function wrappedPause(
  deps: TimerActionDeps,
  opts: BaseOpts = {},
): Promise<{ cancelled: boolean }> {
  const ctx: HookContext = { ...(opts.context ?? {}) };
  return runAction(
    deps,
    "session:pause",
    ctx,
    () => invoke("pause_session"),
    "pause_session",
  );
}

export async function wrappedResume(
  deps: TimerActionDeps,
  opts: BaseOpts = {},
): Promise<{ cancelled: boolean }> {
  const ctx: HookContext = { ...(opts.context ?? {}) };
  return runAction(
    deps,
    "session:resume",
    ctx,
    () => invoke("resume_session"),
    "resume_session",
  );
}

export async function wrappedStop(
  deps: TimerActionDeps,
  opts: BaseOpts = {},
): Promise<{ cancelled: boolean }> {
  // Stop runs through `before:session:cancel` because the engine emits
  // `session:cancel` as its after-event. Plugins that want to veto stop
  // (Exam Mode penalty enforcement) hook the cancel name.
  const ctx: HookContext = { ...(opts.context ?? {}) };
  return runAction(
    deps,
    "session:cancel",
    ctx,
    () => invoke("stop_session"),
    "stop_session",
  );
}

