import { useEffect, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTimer } from "./hooks/use-timer";
import { Sidebar } from "./components/sidebar";
import { TimerDisplay } from "./components/timer-display";
import { SettingsPanel } from "./components/settings-panel";
import { StatusBar } from "./components/status-bar";
import { PluginHost } from "./components/plugin-host";
import { Notifications } from "./components/notifications";
import { SessionDetailPanel } from "./components/session-detail";
import type { Config, Mode } from "./lib/types";
import { MODES } from "./lib/types";

type View = "timer" | "settings" | "session-detail";

function AppShell() {
  const { state, intervalRemaining } = useTimer();
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
        if (MODES.includes(cfg.core.default_mode as Mode)) {
          setSelectedMode(cfg.core.default_mode as Mode);
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

  // If an active session exists (e.g. after recovery), stop showing the hint
  useEffect(() => {
    if (state && state.status !== "idle") {
      setHintDismissed(true);
    }
  }, [state?.status]);

  const startSession = useCallback(async () => {
    try {
      await invoke("start_session", {
        mode: selectedMode,
        tags: stagedTags,
      });
    } catch (e) {
      console.error("start_session failed", e);
    }
  }, [selectedMode, stagedTags]);

  const onTagConfirm = useCallback(
    async (tags: string[]) => {
      setTagInputOpen(false);
      if (state && state.status !== "idle") {
        try {
          await invoke("set_tags", { tags });
        } catch (e) {
          console.error("set_tags failed", e);
        }
      } else {
        setStagedTags(tags);
      }
    },
    [state?.status],
  );

  const confirmStop = useCallback(async () => {
    setStopConfirmOpen(false);
    try {
      await invoke("stop_session");
      setHintDismissed(true);
    } catch (e) {
      console.error("stop_session failed", e);
    }
  }, []);

  // Global keyboard handler
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
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
        if (!e.shiftKey && (k === "1" || k === "2" || k === "3")) {
          if (state?.status === "idle" && view === "timer") {
            e.preventDefault();
            setSelectedMode(MODES[Number(k) - 1]);
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
        if (state && state.status !== "idle") {
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
        if (state && state.status !== "idle") {
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
        if (!state) return;
        if (state.status === "idle") {
          startSession();
        } else if (state.status === "running") {
          invoke("pause_session").catch((err) =>
            console.error("pause_session failed", err),
          );
        } else if (state.status === "paused") {
          invoke("resume_session").catch((err) =>
            console.error("resume_session failed", err),
          );
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    state,
    view,
    sidebarVisible,
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
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {view === "timer" && (
          <>
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
                onStopConfirm={confirmStop}
                onStopCancel={() => setStopConfirmOpen(false)}
              />
            </div>
            <StatusBar state={state} selectedMode={selectedMode} />
          </>
        )}
        {view === "settings" && config && (
          <SettingsPanel
            initial={config}
            flintDir={flintDir}
            onClose={() => setView("timer")}
            onSaved={(cfg) => {
              setConfig(cfg);
              if (MODES.includes(cfg.core.default_mode as Mode)) {
                setSelectedMode(cfg.core.default_mode as Mode);
              }
            }}
          />
        )}
        {view === "session-detail" && activeSessionId && (
          <SessionDetailPanel
            sessionId={activeSessionId}
            onClose={closeSessionDetail}
          />
        )}
      </main>
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
