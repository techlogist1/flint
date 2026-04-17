// Stopwatch plugin. The Rust engine creates a single untimed interval for
// stopwatch sessions and counts up indefinitely — no interval transitions,
// no targets. The plugin owns the lap counter via plugin storage so the
// count survives a session without leaning on any core counter.

const LAP_KEY = "lap-count";

flint.on("session:start", async (payload) => {
  if (payload.mode !== "stopwatch") return;
  try {
    await flint.storage.set(LAP_KEY, 0);
  } catch (err) {}
});

flint.on("session:complete", async () => {
  try {
    await flint.storage.set(LAP_KEY, 0);
  } catch (err) {}
});

flint.on("session:cancel", async () => {
  try {
    await flint.storage.set(LAP_KEY, 0);
  } catch (err) {}
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
        const current = await flint.storage.get(LAP_KEY);
        const next = typeof current === "number" ? current + 1 : 1;
        await flint.storage.set(LAP_KEY, next);
      } catch (err) {}
    },
  });
}
