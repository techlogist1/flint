// Pomodoro plugin — drives its own intervals via the interval-authoring API.
// `before:session:start` declares the first focus target via setFirstInterval;
// `after:interval:end` computes the next interval and pushes it via
// setNextInterval. The Rust engine retains a hardcoded pomodoro fallback for
// older host builds, so every API call is wrapped in try/catch and degrades
// silently if the host doesn't expose the new method.

var transitioning = false;
var cyclesDone = 0; // count of completed FOCUS intervals in the active session
var lastNotifyAt = 0;
var NOTIFY_DEDUP_MS = 5 * 60 * 1000;

// Legacy default constants — only used if getConfig() fails outright.
var DEFAULT_FOCUS_MIN = 25;
var DEFAULT_BREAK_MIN = 5;
var DEFAULT_LONG_BREAK_MIN = 15;
var DEFAULT_CYCLES_BEFORE_LONG = 4;

function safeNotify(message) {
  var now = Date.now();
  if (now - lastNotifyAt < NOTIFY_DEDUP_MS) return;
  lastNotifyAt = now;
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
      p.catch(function () {
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

function minutesToSec(min) {
  if (typeof min !== "number" || isNaN(min) || min <= 0) return 1;
  return Math.max(1, Math.round(min * 60));
}

// Read pomodoro config out of the merged plugin config the host returns.
// Top-level keys map directly to the manifest's config_schema — see
// `src-tauri/plugins/pomodoro/manifest.json`.
function readPomodoroConfig(cfg) {
  cfg = cfg || {};
  return {
    focus_duration:
      typeof cfg.focus_duration === "number"
        ? cfg.focus_duration
        : DEFAULT_FOCUS_MIN,
    break_duration:
      typeof cfg.break_duration === "number"
        ? cfg.break_duration
        : DEFAULT_BREAK_MIN,
    long_break_duration:
      typeof cfg.long_break_duration === "number"
        ? cfg.long_break_duration
        : DEFAULT_LONG_BREAK_MIN,
    cycles_before_long:
      typeof cfg.cycles_before_long === "number" && cfg.cycles_before_long > 0
        ? cfg.cycles_before_long
        : DEFAULT_CYCLES_BEFORE_LONG,
    auto_start_breaks: cfg.auto_start_breaks !== false,
    auto_start_focus: cfg.auto_start_focus === true,
  };
}

// Compute the next interval descriptor following pomodoro math. `endedType`
// is the interval that just ended ("focus" or "break"); we mirror the
// existing Rust fallback in `commands.rs::next_interval`.
function computeNextInterval(endedType, cfg) {
  var pomo = readPomodoroConfig(cfg);
  if (endedType === "focus") {
    var isLong =
      pomo.cycles_before_long > 0 &&
      cyclesDone > 0 &&
      cyclesDone % pomo.cycles_before_long === 0;
    return {
      type: isLong ? "long-break" : "break",
      target_sec: minutesToSec(
        isLong ? pomo.long_break_duration : pomo.break_duration,
      ),
    };
  }
  // Anything other than focus -> back to focus.
  return {
    type: "focus",
    target_sec: minutesToSec(pomo.focus_duration),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Lifecycle: keep the cycle counter and transitioning guard in sync with
// the host's session boundary.
// ─────────────────────────────────────────────────────────────────────────

flint.on("session:start", function () {
  // Clear any stale guard and reset cycle counting for the new session.
  transitioning = false;
  cyclesDone = 0;
  lastNotifyAt = 0;
});

flint.on("session:complete", function () {
  transitioning = false;
  cyclesDone = 0;
});

flint.on("session:cancel", function () {
  transitioning = false;
  cyclesDone = 0;
});

// ─────────────────────────────────────────────────────────────────────────
// Before-hook: declare the first focus interval to the engine.
// Runs synchronously inside the session:start pipeline so the engine's
// `build_first_interval` can consume `pending_first_interval` instead of
// hitting its hardcoded pomodoro branch.
// ─────────────────────────────────────────────────────────────────────────

if (typeof flint.hook === "function") {
  flint.hook("session:start", function (ctx) {
    var ctxMode = ctx && (ctx.mode || (ctx.config && ctx.config.mode));
    var ctxPluginId = ctx && ctx.plugin_id;
    var isPomodoro = ctxMode === "pomodoro" || ctxPluginId === "pomodoro";
    if (!isPomodoro) return;
    if (typeof flint.setFirstInterval !== "function") return;

    // Return the promise chain so the host's runBeforeHooks awaits it before
    // invoking start_session — otherwise the engine's build_first_interval
    // takes pending_first before we've set it and silently falls back to the
    // Rust hardcoded branch.
    var configPromise;
    try {
      configPromise =
        typeof flint.getConfig === "function"
          ? flint.getConfig()
          : Promise.resolve(null);
    } catch (err) {
      configPromise = Promise.resolve(null);
    }

    return Promise.resolve(configPromise)
      .catch(function () {
        return null;
      })
      .then(function (cfg) {
        var pomo = readPomodoroConfig(cfg);
        return flint.setFirstInterval({
          type: "focus",
          target_sec: minutesToSec(pomo.focus_duration),
        });
      })
      .catch(function () {
        // Swallow — the Rust fallback handles a missing pending interval.
      });
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Commands: discoverable actions published to the palette (Ctrl+P).
// ─────────────────────────────────────────────────────────────────────────

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
    name: "Pomodoro: reset cycle counter",
    icon: "⟲",
    category: "pomodoro",
    callback: function () {
      cyclesDone = 0;
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// interval:end — drive the transition.
// Plugin-authored next interval gets pushed via `flint.setNextInterval`;
// the actual interval advance is invoked through `flint.nextInterval()`,
// which now consumes the pending interval slot. The Rust side keeps its
// hardcoded pomodoro fallback for safety.
// ─────────────────────────────────────────────────────────────────────────

flint.on("interval:end", function (payload) {
  if (transitioning) return;
  transitioning = true;

  var endedType = payload && payload.type;

  // Increment cycles for any focus interval that just ended.
  if (endedType === "focus") {
    cyclesDone += 1;
  }

  // Fire-and-forget notification. Never awaited, never blocks.
  if (endedType === "focus") {
    safeNotify("Focus done. Break time.");
  } else if (endedType === "break" || endedType === "long-break") {
    safeNotify("Break over. Back to focus.");
  }

  // Defer host calls by 500 ms so the runtime can flush queued events
  // before we re-enter next_interval. The Rust rate limiter (FIX 1) is
  // the authoritative guard if anything still rapid-fires.
  setTimeout(function () {
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

        var cfgPromise;
        try {
          cfgPromise =
            typeof flint.getConfig === "function" ? flint.getConfig() : null;
        } catch (err) {
          cfgPromise = null;
        }

        var applyTransition = function (cfg) {
          var pomo = readPomodoroConfig(cfg);
          var next = computeNextInterval(endedType, cfg);

          // Push the next interval into the engine's pending slot. If the
          // method is missing (older host), the Rust fallback in
          // next_interval will compute the same answer from its hardcoded
          // pomodoro branch, so behaviour is identical.
          if (typeof flint.setNextInterval === "function") {
            try {
              var p = flint.setNextInterval({
                type: next.type,
                target_sec: next.target_sec,
              });
              if (p && typeof p.then === "function") {
                p.catch(function () {
                  // Fall through to fallback.
                });
              }
            } catch (err) {
              // Same fallback.
            }
          }

          // Advance the engine. This consumes pending_next_interval if
          // set, otherwise hits the Rust pomodoro fallback.
          safeInvoke(function () {
            return flint.nextInterval();
          }, "nextInterval");

          // Honour auto-start preferences exactly as before. After a
          // focus interval we may want to immediately pause for the
          // break; after a break we may want to immediately pause for
          // focus.
          if (endedType === "focus" && !pomo.auto_start_breaks) {
            safeInvoke(function () {
              return flint.pauseSession();
            }, "pauseSession");
          } else if (
            (endedType === "break" || endedType === "long-break") &&
            !pomo.auto_start_focus
          ) {
            safeInvoke(function () {
              return flint.pauseSession();
            }, "pauseSession");
          }

          // Release the guard once interval:start has had time to fire.
          setTimeout(finishTransition, 750);
        };

        if (cfgPromise && typeof cfgPromise.then === "function") {
          cfgPromise.then(applyTransition).catch(function () {
            applyTransition(null);
          });
        } else {
          applyTransition(null);
        }
      })
      .catch(function () {
        finishTransition();
      });
  }, 500);
});
