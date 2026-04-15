// Session Log plugin. The scrollable list and detail view are rendered by
// Flint's React shell in the "sidebar-tab" slot; this entry file listens for
// session lifecycle events and broadcasts a refresh hint via the host's
// `flint.emit` API so the dashboard can re-fetch. The plugin runs sandboxed,
// so `window` is undefined here — emitting through `flint.emit` is the only
// way for sandboxed code to talk back to host React (S-C1).

flint.on("session:complete", (payload) => {
  flint.emit("sessions:refresh", payload);
});

flint.on("session:cancel", (payload) => {
  flint.emit("sessions:refresh", payload);
});

if (typeof flint.registerCommand === "function") {
  flint.registerCommand({
    id: "session-log:refresh",
    name: "Session Log: refresh",
    icon: "⟳",
    category: "log",
    callback: () => {
      flint.emit("sessions:refresh", {});
    },
  });
}
