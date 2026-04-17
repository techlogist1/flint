/**
 * [H-6] Plugin prompt primitive — interactive dismissible dialog.
 *
 * Plugins call `flint.prompt({...})` and get a Promise that resolves to
 * "accepted", "declined", or "dismissed". The host owns the rendering; the
 * plugin owns the decision. One prompt is visible at a time; up to 3 may
 * queue. Over the queue cap the call rejects with an Error so a misfiring
 * plugin cannot stack infinite prompts.
 *
 * The PluginPrompt component (mounted high in App.tsx) subscribes to this
 * queue via `subscribePromptQueue` and renders the active entry.
 */

export type PromptResult = "accepted" | "declined" | "dismissed";

export interface PromptOptions {
  title: string;
  body?: string;
  accept: string;
  decline: string;
  /** Auto-dismiss after this many ms. Defaults to 30 000. */
  timeout?: number;
}

export interface PromptEntry {
  id: number;
  options: PromptOptions;
  resolve: (result: PromptResult) => void;
}

const MAX_QUEUE_DEPTH = 3;

let nextId = 1;
const queue: PromptEntry[] = [];
type Listener = (active: PromptEntry | null, depth: number) => void;
const listeners = new Set<Listener>();

function notify(): void {
  const active = queue[0] ?? null;
  for (const l of listeners) {
    try {
      l(active, queue.length);
    } catch (err) {
      console.error("[prompt-queue] listener threw:", err);
    }
  }
}

/**
 * Push a prompt onto the queue. Returns a Promise that resolves with the
 * user's choice. Rejects if the queue is already at MAX_QUEUE_DEPTH.
 */
export function promptViaQueue(options: PromptOptions): Promise<PromptResult> {
  if (queue.length >= MAX_QUEUE_DEPTH) {
    return Promise.reject(
      new Error(
        `flint.prompt queue full (${MAX_QUEUE_DEPTH} pending) — refusing to enqueue more`,
      ),
    );
  }
  return new Promise<PromptResult>((resolve) => {
    queue.push({ id: nextId++, options, resolve });
    notify();
  });
}

/**
 * Resolve the active prompt with a result and advance the queue. Called
 * by the PluginPrompt component on accept / decline / dismiss / timeout.
 */
export function resolveActivePrompt(result: PromptResult): void {
  const entry = queue.shift();
  if (!entry) return;
  try {
    entry.resolve(result);
  } catch (err) {
    console.error("[prompt-queue] resolve threw:", err);
  }
  notify();
}

/**
 * Subscribe to queue changes. The listener is called immediately with the
 * current active entry and queue depth. Returns an unsubscribe.
 */
export function subscribePromptQueue(listener: Listener): () => void {
  listeners.add(listener);
  listener(queue[0] ?? null, queue.length);
  return () => {
    listeners.delete(listener);
  };
}

