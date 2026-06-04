// Countdown plugin. The Rust engine builds the first focus interval with
// target = countdown_default_min when a countdown session starts. When the
// interval ends, this plugin finalises the session and surfaces a completion
// notification.

flint.on("interval:end", async (payload) => {
  // PLUGINS-2: cheap synchronous guard before the IPC round-trip, and tolerate
  // a getTimerState rejection — the Rust engine already marked this interval
  // ended, so it won't re-fire; this handler must never throw before stopping.
  if (payload.type !== "focus") return;
  let state;
  try {
    state = await flint.getTimerState();
  } catch (e) {
    console.error("[countdown] getTimerState failed", e);
    return;
  }
  if (state.mode !== "countdown" || state.status === "idle") return;

  // PLUGINS-1: finalize first — the notification is cosmetic and must never
  // block stopSession. A throw from the notification would otherwise leave the
  // countdown overrunning forever (interval:end won't fire again).
  try {
    await flint.stopSession();
  } catch (e) {
    console.error("[countdown] stopSession failed", e);
  }
  try {
    flint.showNotification("Countdown complete.", { duration: 6000 });
  } catch (e) {
    console.error("[countdown] notification failed", e);
  }
});

if (typeof flint.registerCommand === "function") {
  flint.registerCommand({
    id: "countdown:abort",
    name: "Countdown: abort current timer",
    icon: "×",
    category: "countdown",
    callback: async () => {
      try {
        const state = await flint.getTimerState();
        if (state.mode === "countdown" && state.status !== "idle") {
          await flint.stopSession();
        }
      } catch (e) {
        console.error("[countdown] abort failed", e);
      }
    },
  });
}
