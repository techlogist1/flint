// Stopwatch plugin. The Rust engine creates a single untimed interval for
// stopwatch sessions and counts up indefinitely — no interval transitions,
// no targets. This plugin is a no-op registration so the mode is discoverable
// via the plugin list and can be enabled/disabled uniformly.

flint.on("session:start", (payload) => {
  if (payload.mode !== "stopwatch") return;
});

if (typeof flint.registerCommand === "function") {
  flint.registerCommand({
    id: "stopwatch:mark-lap",
    name: "Stopwatch: mark lap",
    icon: "●",
    category: "stopwatch",
    callback: async () => {
      try {
        const state = await flint.getTimerState();
        if (state.mode !== "stopwatch" || state.status === "idle") return;
        await flint.markQuestion();
      } catch (err) {}
    },
  });
}
