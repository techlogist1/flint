// Stats Dashboard plugin. Charts, heatmap, and streak counter are rendered by
// Flint's React shell in the "sidebar-tab" slot. The entry file listens for
// completed sessions so the dashboard can refresh aggregated data.

flint.on("session:complete", (payload) => {
  window.dispatchEvent(
    new CustomEvent("flint:stats:refresh", { detail: payload }),
  );
});
