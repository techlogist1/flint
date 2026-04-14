// Stopwatch plugin. The Rust engine creates a single untimed interval for
// stopwatch sessions and counts up indefinitely — no interval transitions,
// no targets. This plugin is a no-op registration so the mode is discoverable
// via the plugin list and can be enabled/disabled uniformly.

flint.on("session:start", (payload) => {
  if (payload.mode !== "stopwatch") return;
});
