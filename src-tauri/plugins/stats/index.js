// Stats Dashboard plugin. Charts, heatmap, and streak counter are rendered by
// Flint's React shell in the "sidebar-tab" slot. The entry file listens for
// completed sessions and broadcasts a refresh hint via the host's
// `flint.emit` API. The plugin runs sandboxed, so `window` is undefined here
// — emitting through `flint.emit` is the only way for sandboxed code to talk
// back to host React (S-C1).

flint.on("session:complete", (payload) => {
  flint.emit("stats:refresh", payload);
});

if (typeof flint.registerCommand === "function") {
  flint.registerCommand({
    id: "stats:refresh",
    name: "Stats: refresh",
    icon: "⟳",
    category: "stats",
    callback: () => {
      flint.emit("stats:refresh", {});
    },
  });
}
