import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTimer } from "./hooks/use-timer";
import { Sidebar } from "./components/sidebar";
import { TimerDisplay } from "./components/timer-display";
import { SettingsPanel } from "./components/settings-panel";
import { StatusBar } from "./components/status-bar";
import { PluginHost, useTimerModes } from "./components/plugin-host";
import { Notifications } from "./components/notifications";
import { SessionDetailPanel } from "./components/session-detail";
import { TrayToast } from "./components/tray-toast";
import type { Config, Mode, TimerModeInfo } from "./lib/types";

type View = "timer" | "settings" | "session-detail";

function AppShell() {
  const { state, intervalRemaining } = useTimer();
  const timerModes = useTimerModes();
  const [config, setConfig] = useState<Config | null>(null);
  const [flintDir, setFlintDir] = useState<string>("");

  const [view, setView] = useState<View>("timer");
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [selectedMode, setSelectedMode] = useState<Mode>("pomodoro");
  const [stagedTags, setStagedTags] = useState<string[]>([]);
  const [tagInputOpen, setTagInputOpen] = useState(false);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [trayToast, setTrayToast] = useState<string | null>(null);

  // Refs that mirror ticking/mutable values, so the global keyboard handler
  // can read the latest values without re-registering every time `state`
  // changes. Without this the keydown effect re-registers on every
  // `session:tick` (B-H1).
  const stateRef = useRef(state);
  stateRef.current = state;
  const selectedModeRef = useRef(selectedMode);
  selectedModeRef.current = selectedMode;
  const stagedTagsRef = useRef(stagedTags);
  stagedTagsRef.current = stagedTags;
  const configRef = useRef(config);
  configRef.current = config;
  const timerModesRef = useRef<TimerModeInfo[]>(timerModes);
  timerModesRef.current = timerModes;
  const sidebarSaveTimerRef = useRef<number | null>(null);

  const hasTimerMode = useCallback(
    (id: string) => timerModes.some((m) => m.id === id),
    [timerModes],
  );

  const openSession = useCallback((id: string) => {
    setActiveSessionId(id);
    setView("session-detail");
    setStopConfirmOpen(false);
    setTagInputOpen(false);
  }, []);

  const closeSessionDetail = useCallback(() => {
    setActiveSessionId(null);
    setView("timer");
  }, []);

  // Load config + flint dir once
  useEffect(() => {
    (async () => {
      try {
        const cfg = await invoke<Config>("get_config");
        setConfig(cfg);
        setSidebarVisible(cfg.appearance.sidebar_visible);
        if (cfg.core.default_mode) {
          setSelectedMode(cfg.core.default_mode);
        }
      } catch (e) {
        console.error("get_config failed", e);
      }
      try {
        const dir = await invoke<string>("get_flint_dir");
        setFlintDir(dir);
      } catch (e) {
        console.error("get_flint_dir failed", e);
      }
    })();
  }, []);

  // Once plugins have loaded, make sure the selected mode still points to an
  // enabled timer-mode plugin. If the user disabled the plugin that was their
  // last-used mode, snap to the first available one.
  useEffect(() => {
    if (timerModes.length === 0) return;
    if (!timerModes.some((m) => m.id === selectedMode)) {
      setSelectedMode(timerModes[0].id);
    }
  }, [timerModes, selectedMode]);

  // If an active session exists (e.g. after recovery), stop showing the hint
  useEffect(() => {
    if (state && state.status !== "idle") {
      setHintDismissed(true);
    }
  }, [state?.status]);

  // Tray-originated events: first-close toast, quick-start from menu
  useEffect(() => {
    const unlisteners: Promise<UnlistenFn>[] = [];
    unlisteners.push(
      listen<{ message: string }>("tray:first-close", async (evt) => {
        const msg =
          evt.payload?.message ??
          "Flint minimized to tray. Right-click the tray icon → Quit to exit.";
        setTrayToast(msg);
        window.setTimeout(async () => {
          try {
            await invoke("mark_first_close_shown");
          } catch (e) {
            console.error("mark_first_close_shown failed", e);
          }
          try {
            await invoke("hide_main_window");
          } catch (e) {
            console.error("hide_main_window failed", e);
          }
          setTrayToast(null);
        }, 3500);
      }),
    );
    unlisteners.push(
      listen<{ mode: string }>("tray:start-session", async (evt) => {
        const mode = evt.payload?.mode;
        const enabled = timerModesRef.current.some((m) => m.id === mode);
        if (mode && enabled) {
          setSelectedMode(mode);
          try {
            await invoke("start_session", { mode, tags: stagedTags });
          } catch (e) {
            console.error("start_session from tray failed", e);
          }
        }
      }),
    );
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [stagedTags]);

  // Auto-show/hide overlay based on session state + config preference
  useEffect(() => {
    if (!config) return;
    if (!config.overlay.enabled) return;
    if (config.overlay.always_visible) return;
    const unlisteners: Promise<UnlistenFn>[] = [];
    unlisteners.push(
      listen("session:start", () => {
        invoke("overlay_show").catch((e) =>
          console.error("overlay_show failed", e),
        );
      }),
    );
    const hideOnEnd = () => {
      invoke("overlay_hide").catch((e) =>
        console.error("overlay_hide failed", e),
      );
    };
    unlisteners.push(listen("session:complete", hideOnEnd));
    unlisteners.push(listen("session:cancel", hideOnEnd));
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [config]);

  const startSession = useCallback(async () => {
    try {
      await invoke("start_session", {
        mode: selectedModeRef.current,
        tags: stagedTagsRef.current,
      });
    } catch (e) {
      console.error("start_session failed", e);
    }
  }, []);

  const onTagConfirm = useCallback(async (tags: string[]) => {
    setTagInputOpen(false);
    const current = stateRef.current;
    if (current && current.status !== "idle") {
      try {
        await invoke("set_tags", { tags });
      } catch (e) {
        console.error("set_tags failed", e);
      }
    } else {
      setStagedTags(tags);
    }
  }, []);

  const confirmStop = useCallback(async () => {
    setStopConfirmOpen(false);
    try {
      await invoke("stop_session");
      setHintDismissed(true);
    } catch (e) {
      console.error("stop_session failed", e);
    }
  }, []);

  // D-H4: edge-drag resize. Update config state optimistically so the
  // sidebar width takes effect immediately, then debounce the backend save.
  const onSidebarResize = useCallback((newWidth: number) => {
    setConfig((prev) => {
      if (!prev) return prev;
      if (prev.appearance.sidebar_width === newWidth) return prev;
      return {
        ...prev,
        appearance: { ...prev.appearance, sidebar_width: newWidth },
      };
    });
    if (sidebarSaveTimerRef.current != null) {
      window.clearTimeout(sidebarSaveTimerRef.current);
    }
    sidebarSaveTimerRef.current = window.setTimeout(() => {
      const current = configRef.current;
      if (current) {
        invoke<Config>("update_config", { newConfig: current }).catch((e) =>
          console.error("save sidebar width failed", e),
        );
      }
      sidebarSaveTimerRef.current = null;
    }, 400);
  }, []);

  // Global keyboard handler. Reads the ticking `state` via stateRef so the
  // effect only re-registers when view/stopConfirmOpen/tagInputOpen change
  // (B-H1). startSession/confirmStop/closeSessionDetail are stable callbacks
  // so including them in deps is free.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const currentState = stateRef.current;
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const inInput =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        (target as HTMLElement | null)?.isContentEditable === true;

      // Global modifier shortcuts — work even in inputs
      if (mod && !e.altKey) {
        const k = e.key.toLowerCase();
        if (!e.shiftKey && k === "b") {
          e.preventDefault();
          setSidebarVisible((v) => !v);
          return;
        }
        if (e.shiftKey && k === "o") {
          e.preventDefault();
          invoke("overlay_toggle").catch((err) =>
            console.error("overlay_toggle failed", err),
          );
          return;
        }
        if (!e.shiftKey && k === "q") {
          e.preventDefault();
          invoke("quit_app").catch((err) =>
            console.error("quit_app failed", err),
          );
          return;
        }
        if (!e.shiftKey && k === "t") {
          e.preventDefault();
          if (view === "timer") setTagInputOpen(true);
          return;
        }
        if (!e.shiftKey && k === ",") {
          e.preventDefault();
          setView((v) => (v === "settings" ? "timer" : "settings"));
          setActiveSessionId(null);
          setStopConfirmOpen(false);
          return;
        }
        if (!e.shiftKey && k.length === 1 && k >= "1" && k <= "9") {
          if (currentState?.status === "idle" && view === "timer") {
            const index = Number(k) - 1;
            const modes = timerModesRef.current;
            if (index < modes.length) {
              e.preventDefault();
              setSelectedMode(modes[index].id);
            }
          }
          return;
        }
      }

      // Escape is global — always handled here unless an input
      // intentionally stops propagation (e.g. TagInput).
      if (e.key === "Escape") {
        e.preventDefault();
        if (stopConfirmOpen) {
          setStopConfirmOpen(false);
          return;
        }
        if (tagInputOpen) {
          setTagInputOpen(false);
          return;
        }
        if (view === "settings") {
          setView("timer");
          return;
        }
        if (view === "session-detail") {
          closeSessionDetail();
          return;
        }
        if (currentState && currentState.status !== "idle") {
          setStopConfirmOpen(true);
          return;
        }
        return;
      }

      if (inInput) return;

      if (e.key === "Enter") {
        if (view === "settings" || view === "session-detail") return;
        e.preventDefault();
        if (stopConfirmOpen) {
          confirmStop();
          return;
        }
        if (currentState && currentState.status !== "idle") {
          invoke("mark_question").catch((err) =>
            console.error("mark_question failed", err),
          );
        }
        return;
      }

      if (e.key === " " || e.code === "Space") {
        if (
          view === "settings" ||
          view === "session-detail" ||
          stopConfirmOpen ||
          tagInputOpen
        )
          return;
        e.preventDefault();
        if (!currentState) return;
        if (currentState.status === "idle") {
          startSession();
        } else if (currentState.status === "running") {
          invoke("pause_session").catch((err) =>
            console.error("pause_session failed", err),
          );
        } else if (currentState.status === "paused") {
          invoke("resume_session").catch((err) =>
            console.error("resume_session failed", err),
          );
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    view,
    stopConfirmOpen,
    tagInputOpen,
    startSession,
    confirmStop,
    closeSessionDetail,
  ]);

  const sidebarWidth = config?.appearance.sidebar_width ?? 220;

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <Sidebar
        visible={sidebarVisible}
        width={sidebarWidth}
        activeSessionId={activeSessionId}
        onOpenSession={openSession}
        onOpenSettings={() => {
          setView("settings");
          setActiveSessionId(null);
          setStopConfirmOpen(false);
        }}
        onResize={onSidebarResize}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {view === "timer" && (
          <div
            key="view-timer"
            className="flex min-h-0 flex-1 flex-col animate-[flint-crossfade_150ms_ease-out]"
          >
            <div className="flex min-h-0 flex-1 flex-col">
              <TopBar
                sidebarVisible={sidebarVisible}
                onToggleSidebar={() => setSidebarVisible((v) => !v)}
              />
              <TimerDisplay
                state={state}
                intervalRemaining={intervalRemaining}
                config={config}
                selectedMode={selectedMode}
                stagedTags={stagedTags}
                tagInputOpen={tagInputOpen}
                stopConfirmOpen={stopConfirmOpen}
                hintDismissed={hintDismissed}
                onTagConfirm={onTagConfirm}
                onTagCancel={() => setTagInputOpen(false)}
              />
            </div>
            <StatusBar state={state} selectedMode={selectedMode} />
          </div>
        )}
        {view === "settings" && config && (
          <div
            key="view-settings"
            className="flex min-h-0 flex-1 flex-col animate-[flint-fadein_150ms_ease-out]"
          >
            <SettingsPanel
              initial={config}
              flintDir={flintDir}
              onClose={() => setView("timer")}
              onSaved={(cfg) => {
                setConfig(cfg);
                if (cfg.core.default_mode && hasTimerMode(cfg.core.default_mode)) {
                  setSelectedMode(cfg.core.default_mode);
                }
              }}
            />
          </div>
        )}
        {view === "session-detail" && activeSessionId && (
          <div
            key="view-session-detail"
            className="flex min-h-0 flex-1 flex-col animate-[flint-crossfade_150ms_ease-out]"
          >
            <SessionDetailPanel
              sessionId={activeSessionId}
              onClose={closeSessionDetail}
            />
          </div>
        )}
      </main>
      {trayToast && <TrayToast message={trayToast} />}
    </div>
  );
}

function TopBar({
  sidebarVisible,
  onToggleSidebar,
}: {
  sidebarVisible: boolean;
  onToggleSidebar: () => void;
}) {
  return (
    <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
      <button
        onClick={onToggleSidebar}
        className="rounded px-2 py-1 text-xs text-[var(--text-secondary)] transition-colors duration-150 ease-out hover:text-[var(--text-primary)]"
        title="Toggle sidebar (Ctrl+B)"
      >
        {sidebarVisible ? "⟨" : "⟩"}
      </button>
      <div className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
        Flint
      </div>
      <div className="w-8" />
    </div>
  );
}

function App() {
  return (
    <PluginHost>
      <AppShell />
      <Notifications />
    </PluginHost>
  );
}

export default App;
