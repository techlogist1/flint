// Pomodoro plugin. The Rust engine builds the first focus interval when a
// pomodoro session starts; this plugin drives the transitions after each
// interval ends based on auto-start config.

flint.on("interval:end", async (payload) => {
  const state = await flint.getTimerState();
  if (state.mode !== "pomodoro" || state.status === "idle") return;

  const cfg = await flint.getConfig();

  if (payload.type === "focus") {
    flint.showNotification("Focus done. Break time.", { duration: 4000 });
    await flint.nextInterval();
    if (!cfg.auto_start_breaks) {
      await flint.pauseSession();
    }
  } else if (payload.type === "break") {
    flint.showNotification("Break over. Back to focus.", { duration: 4000 });
    await flint.nextInterval();
    if (!cfg.auto_start_focus) {
      await flint.pauseSession();
    }
  }
});
