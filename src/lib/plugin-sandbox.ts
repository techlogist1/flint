import type { FlintPluginAPI } from "./plugin-api";

// Names shadowed when a plugin runs. These map to `undefined` inside the
// plugin's lexical scope, so references like `window.__TAURI_INTERNALS__` or
// a bare `__TAURI_INTERNALS__` read resolve to undefined instead of leaking
// the main webview's globals.
//
// This is a minimum-viable sandbox as specified by the audit (B-C2 / S-C1).
// It is NOT bulletproof — a determined plugin can still reach the real
// global via tricks like `new Function("return this")()` — but it blocks
// direct access and accidental leakage, and forces any escape attempt to be
// obvious in plugin source code.
const SHADOWED_GLOBALS: readonly string[] = [
  "window",
  "document",
  "globalThis",
  "self",
  "parent",
  "top",
  "frames",
  "__TAURI__",
  "__TAURI_INTERNALS__",
  "__TAURI_INVOKE__",
  "__TAURI_METADATA__",
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "navigator",
  "location",
  "history",
  "Worker",
  "SharedWorker",
];

export function runInSandbox(
  source: string,
  flint: FlintPluginAPI,
): void {
  const body = `"use strict";\n${source}`;
  // eslint-disable-next-line no-new-func
  const runner = new Function("flint", ...SHADOWED_GLOBALS, body);
  const undefs: undefined[] = SHADOWED_GLOBALS.map(() => undefined);
  runner.call(undefined, flint, ...undefs);
}

// Runs once at module load. A plugin that tries to read
// `window.__TAURI_INTERNALS__` must fail — if it succeeds, the sandbox is
// broken and we log a loud SECURITY error to the console so regressions are
// caught during development rather than shipped.
function selfTest(): void {
  const canary = `
    var leaks = [];
    if (typeof window !== "undefined") leaks.push("window");
    if (typeof document !== "undefined") leaks.push("document");
    if (typeof globalThis !== "undefined") leaks.push("globalThis");
    if (typeof __TAURI_INTERNALS__ !== "undefined") leaks.push("__TAURI_INTERNALS__");
    if (typeof __TAURI__ !== "undefined") leaks.push("__TAURI__");
    if (typeof fetch !== "undefined") leaks.push("fetch");
    if (leaks.length > 0) {
      throw new Error("SANDBOX_LEAK:" + leaks.join(","));
    }
  `;
  try {
    runInSandbox(canary, null as unknown as FlintPluginAPI);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("SANDBOX_LEAK")) {
      console.error(
        "[plugin-sandbox] SECURITY: sandbox failed self-test — globals leaked:",
        msg,
      );
    }
  }
}

selfTest();
