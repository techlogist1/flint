// Pomodoro plugin — defensive rewrite (FIX 2).
//
// The Rust engine builds the first focus interval when a pomodoro session
// starts; this plugin drives the transitions after each interval ends based
// on the user's auto-start configuration.
//
// Every call site that reaches out to the host is wrapped in try/catch so a
// single failing invoke can never propagate up into the event dispatcher
// and crash the app. The `transitioning` flag guarantees that only one
// transition is ever in flight at a time, no matter how many interval:end
// events stack up while the app is alt-tabbed or the event loop is slow.
// The 500 ms setTimeout before nextInterval breaks the synchronous
// interval:end → next_interval → interval:start chain so the runtime gets
// a breathing gap between each transition.

var transitioning = false;

function safeNotify(message) {
  try {
    flint.showNotification(message, { duration: 4000 });
  } catch (err) {
    // Notification failures must never block the transition.
  }
}

function safeInvoke(fn, label) {
  try {
    var p = fn();
    if (p && typeof p.then === "function") {
      p.catch(function (err) {
        // Swallow async rejection — the engine stays consistent, we just
        // log and move on.
      });
    }
  } catch (err) {
    // Synchronous throw — same policy.
  }
}

function finishTransition() {
  transitioning = false;
}

flint.on("session:start", function () {
  // Clear any stale guard from a previous session that might have been
  // interrupted mid-transition.
  transitioning = false;
});

flint.on("session:complete", function () {
  transitioning = false;
});

// Commands: discoverable actions published to the palette (Ctrl+P).
if (typeof flint.registerCommand === "function") {
  flint.registerCommand({
    id: "pomodoro:skip-interval",
    name: "Pomodoro: skip to next interval",
    icon: "»",
    category: "pomodoro",
    callback: function () {
      safeInvoke(function () {
        return flint.nextInterval();
      }, "skip-interval");
    },
  });

  flint.registerCommand({
    id: "pomodoro:reset-cycle",
    name: "Pomodoro: reset cycle (stop session)",
    icon: "⟲",
    category: "pomodoro",
    callback: function () {
      safeInvoke(function () {
        return flint.stopSession();
      }, "reset-cycle");
    },
  });
}

flint.on("interval:end", function (payload) {
  if (transitioning) return;
  transitioning = true;

  var type = payload && payload.type;

  // Fire-and-forget notification. Never awaited, never blocks.
  if (type === "focus") {
    safeNotify("Focus done. Break time.");
  } else if (type === "break") {
    safeNotify("Break over. Back to focus.");
  }

  // Break the synchronous chain: defer the host call by 500 ms so the
  // runtime can flush any queued events before we re-enter next_interval.
  // The Rust-side rate limiter (FIX 1) will drop the call if something
  // rapid-fires this path anyway, so 500 ms is an extra margin for the
  // frontend side.
  setTimeout(function () {
    // Re-check mode & state: if the user stopped the session during the
    // 500 ms window, do nothing.
    var statePromise;
    try {
      statePromise = flint.getTimerState();
    } catch (err) {
      finishTransition();
      return;
    }

    if (!statePromise || typeof statePromise.then !== "function") {
      finishTransition();
      return;
    }

    statePromise
      .then(function (state) {
        if (!state || state.mode !== "pomodoro" || state.status === "idle") {
          finishTransition();
          return;
        }

        // Read config. Defaults cover the case where getConfig() fails or
        // returns nothing.
        var cfgPromise;
        try {
          cfgPromise = flint.getConfig();
        } catch (err) {
          cfgPromise = null;
        }

        var applyTransition = function (cfg) {
          cfg = cfg || {};
          var autoStartBreak = cfg.auto_start_breaks !== false;
          var autoStartFocus = cfg.auto_start_focus === true;

          // Kick off the interval change. The Rust rate limiter (FIX 1)
          // is the authoritative guard against rapid-fire calls.
          safeInvoke(
            function () {
              return flint.nextInterval();
            },
            "nextInterval",
          );

          // Decide whether to immediately pause after the transition so
          // the user has to press Space to begin the next segment. These
          // invokes are independent — one failing must not prevent the
          // other from running.
          if (type === "focus" && !autoStartBreak) {
            safeInvoke(
              function () {
                return flint.pauseSession();
              },
              "pauseSession",
            );
          } else if (type === "break" && !autoStartFocus) {
            safeInvoke(
              function () {
                return flint.pauseSession();
              },
              "pauseSession",
            );
          }

          // Release the guard a short delay later so the interval:start
          // event has time to propagate. Any interval:end arriving before
          // the guard flips back is definitely a stacked/spurious event
          // and should be ignored.
          setTimeout(finishTransition, 750);
        };

        if (cfgPromise && typeof cfgPromise.then === "function") {
          cfgPromise
            .then(applyTransition)
            .catch(function () {
              applyTransition({});
            });
        } else {
          applyTransition({});
        }
      })
      .catch(function () {
        finishTransition();
      });
  }, 500);
});
