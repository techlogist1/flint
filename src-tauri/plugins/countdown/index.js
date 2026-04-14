// Countdown plugin. The Rust engine builds the first focus interval with
// target = countdown_default_min when a countdown session starts. When the
// interval ends, this plugin finalises the session and surfaces a completion
// notification.

flint.on("interval:end", async (payload) => {
  const state = await flint.getTimerState();
  if (state.mode !== "countdown" || state.status === "idle") return;
  if (payload.type !== "focus") return;

  flint.showNotification("Countdown complete.", { duration: 6000 });
  try {
    await flint.stopSession();
  } catch (e) {
    console.error("[countdown] stopSession failed", e);
  }
});
