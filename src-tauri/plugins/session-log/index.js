// Session Log plugin. The scrollable list and detail view are rendered by
// Flint's React shell in the "sidebar-tab" slot; this entry file listens for
// session lifecycle events so the host can broadcast refresh hints.

flint.on("session:complete", (payload) => {
  window.dispatchEvent(
    new CustomEvent("flint:session-log:refresh", { detail: payload }),
  );
});

flint.on("session:cancel", (payload) => {
  window.dispatchEvent(
    new CustomEvent("flint:session-log:refresh", { detail: payload }),
  );
});
