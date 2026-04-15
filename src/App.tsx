import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useMetaState } from "./hooks/use-timer";
import { Sidebar } from "./components/sidebar";
import { TimerDisplay } from "./components/timer-display";
import { SettingsPanel } from "./components/settings-panel";
import { StatusBar } from "./components/status-bar";
import { PluginHost, usePlugins, useTimerModes } from "./components/plugin-host";
import { Notifications } from "./components/notifications";
import { SessionDetailPanel } from "./components/session-detail";
import { TrayToast } from "./components/tray-toast";
import { CommandPalette } from "./components/command-palette";
import { PresetForm } from "./components/preset-form";
import type { Config, Mode, TimerModeInfo } from "./lib/types";
import type { Preset } from "./lib/presets";
import type { HookContext } from "./lib/hook-registry";

type View = "timer" | "settings" | "session-detail";

/** Session-scoped config overrides applied by presets. Cleared on session
 *  end. Lives in a module-level ref because multiple code paths need to
 *  observe and clear it (start, end, preset reload). */
const activeOverridesRef: { current: Record<string, unknown> | null } = {
  current: null,
};

export function getActiveOverrides(): Record<string, unknown> | null {
  return activeOverridesRef.current;
}

export function setActiveOverrides(v: Record<string, unknown> | null): void {
  activeOverridesRef.current = v;
}

function AppShell() {
  // P-C2: AppShell only subscribes to the meta slice, so a 1Hz tick no
  // longer reconciles this whole tree. TimerDisplay / StatusBar pull tick
  // state internally via useTickState() in their leaf children.
  const meta = useMetaState();
  const timerModes = useTimerModes();
  const { registerCoreCommand, runBeforeHooks, dispatchAfterHooks } =
    usePlugins();
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
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [presetFormOpen, setPresetFormOpen] = useState(false);

  // Refs that mirror ticking/mutable values, so the global keyboard handler
  // can read the latest values without re-registering every time `meta`
  // changes. Without this the keydown effect re-registers on every
  // lifecycle event (B-H1).
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const selectedModeRef = useRef(selectedMode);
  selectedModeRef.current = selectedMode;
  const stagedTagsRef = useRef(stagedTags);
  stagedTagsRef.current = stagedTags;
  const configRef = useRef(config);
  configRef.current = config;
  const timerModesRef = useRef<TimerModeInfo[]>(timerModes);
  timerModesRef.current = timerModes;
  const sidebarSaveTimerRef = useRef<number | null>(null);
  const paletteOpenRef = useRef(paletteOpen);
  paletteOpenRef.current = paletteOpen;
  const presetsRef = useRef<Preset[]>(presets);
  presetsRef.current = presets;
  const viewRef = useRef<View>(view);
  viewRef.current = view;

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
    if (meta && meta.status !== "idle") {
      setHintDismissed(true);
    }
  }, [meta?.status]);

  // startSession is declared below; the tray effect reads it via a ref so
  // the listener can be wired up with no dependency on the (stable-identity)
  // callback itself.
  const startSessionRef = useRef<() => Promise<void>>(async () => {});

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
        if (!mode || !enabled) return;
        setSelectedMode(mode);
        selectedModeRef.current = mode;
        // Route through startSession so the before:session-start hook
        // fires — tray-launched sessions must be interceptable too.
        await startSessionRef.current();
      }),
    );
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, []);

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

  // Load presets once on mount; `refreshPresets` keeps the in-memory copy
  // fresh after save/delete/load events.
  const refreshPresets = useCallback(async () => {
    try {
      const list = await invoke<Preset[]>("list_presets");
      setPresets(list);
    } catch (e) {
      console.error("[flint] list_presets failed:", e);
    }
  }, []);

  // Session lifecycle: clear active overrides, refresh preset list (for MRU
  // ordering on the next launch).
  useEffect(() => {
    const unlisteners: Promise<UnlistenFn>[] = [];
    const onEnd = () => {
      setActiveOverrides(null);
      refreshPresets();
    };
    unlisteners.push(listen("session:complete", onEnd));
    unlisteners.push(listen("session:cancel", onEnd));
    return () => {
      unlisteners.forEach((p) => p.then((fn) => fn()).catch(() => {}));
    };
  }, [refreshPresets]);

  useEffect(() => {
    refreshPresets();
  }, [refreshPresets]);

  const startSession = useCallback(async () => {
    const ctx: HookContext = {
      plugin_id: selectedModeRef.current,
      config: getActiveOverrides() ?? {},
      tags: [...stagedTagsRef.current],
      preset_id: null,
    };
    const cancelled = await runBeforeHooks("session:start", ctx);
    if (cancelled) return;
    const finalTags = Array.isArray(ctx.tags)
      ? (ctx.tags as string[])
      : stagedTagsRef.current;
    const finalMode =
      typeof ctx.plugin_id === "string"
        ? (ctx.plugin_id as Mode)
        : selectedModeRef.current;
    const overrides =
      (ctx.config as Record<string, unknown>) ?? getActiveOverrides() ?? {};
    try {
      await invoke("start_session", {
        mode: finalMode,
        tags: finalTags,
        overrides: Object.keys(overrides).length > 0 ? overrides : null,
      });
    } catch (e) {
      console.error("start_session failed", e);
    }
  }, [runBeforeHooks]);
  startSessionRef.current = startSession;

  /** Load a preset: fire before:preset-load, apply temporary config
   *  overrides for this session, set tags, then start the session via the
   *  standard hook pipeline. Overrides are cleared on session end. */
  const loadPreset = useCallback(
    async (preset: Preset) => {
      const ctx: HookContext = {
        preset: { ...preset },
        config_overrides: { ...preset.config_overrides },
      };
      const cancelled = await runBeforeHooks("preset:load", ctx);
      if (cancelled) return;
      const overrides =
        (ctx.config_overrides as Record<string, unknown>) ??
        preset.config_overrides;
      setActiveOverrides(overrides);
      setSelectedMode(preset.plugin_id);
      setStagedTags([...preset.tags]);
      selectedModeRef.current = preset.plugin_id;
      stagedTagsRef.current = [...preset.tags];
      // Fire-and-forget: bump last_used_at on the preset.
      invoke("touch_preset", { id: preset.id }).catch(() => {});
      await startSession();
      dispatchAfterHooks("preset:load", ctx);
    },
    [runBeforeHooks, dispatchAfterHooks, startSession],
  );

  const onTagConfirm = useCallback(async (tags: string[]) => {
    setTagInputOpen(false);
    const current = metaRef.current;
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

  /** Live tag updates from the always-visible autocomplete. Idle: stage
   *  for the next session. Running: push to the active session via
   *  set_tags so sidebar/session detail see the change immediately. */
  const onTagsChange = useCallback(async (tags: string[]) => {
    const current = metaRef.current;
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

  // Core commands — registered once at mount. Callbacks read state via refs
  // so they never become stale. Dynamic commands (per-plugin mode switch,
  // per-preset load) live in separate effects below that depend on the
  // relevant collection.
  useEffect(() => {
    const unregs: Array<() => void> = [];
    unregs.push(
      registerCoreCommand({
        id: "core:start-session",
        name: "Start session",
        icon: "▶",
        category: "session",
        hotkey: "Space",
        callback: () => {
          void startSession();
        },
      }),
      registerCoreCommand({
        id: "core:stop-session",
        name: "Stop session",
        icon: "■",
        category: "session",
        hotkey: "Esc",
        callback: () => {
          if (metaRef.current && metaRef.current.status !== "idle") {
            setStopConfirmOpen(true);
          }
        },
      }),
      registerCoreCommand({
        id: "core:pause-session",
        name: "Pause session",
        icon: "‖",
        category: "session",
        callback: () => {
          if (metaRef.current?.status === "running") {
            invoke("pause_session").catch((e) =>
              console.error("pause_session failed", e),
            );
          }
        },
      }),
      registerCoreCommand({
        id: "core:resume-session",
        name: "Resume session",
        icon: "▶",
        category: "session",
        callback: () => {
          if (metaRef.current?.status === "paused") {
            invoke("resume_session").catch((e) =>
              console.error("resume_session failed", e),
            );
          }
        },
      }),
      registerCoreCommand({
        id: "core:mark-question",
        name: "Mark question done",
        icon: "●",
        category: "session",
        hotkey: "Enter",
        callback: () => {
          if (metaRef.current?.status !== "idle") {
            invoke("mark_question").catch((e) =>
              console.error("mark_question failed", e),
            );
          }
        },
      }),
      registerCoreCommand({
        id: "core:toggle-overlay",
        name: "Toggle overlay",
        icon: "▣",
        category: "view",
        hotkey: "Ctrl+Shift+O",
        callback: () => {
          invoke("overlay_toggle").catch((e) =>
            console.error("overlay_toggle failed", e),
          );
        },
      }),
      registerCoreCommand({
        id: "core:toggle-sidebar",
        name: "Toggle sidebar",
        icon: "«",
        category: "view",
        hotkey: "Ctrl+B",
        callback: () => {
          setSidebarVisible((v) => !v);
        },
      }),
      registerCoreCommand({
        id: "core:open-settings",
        name: "Open settings",
        icon: "⚙",
        category: "view",
        hotkey: "Ctrl+,",
        callback: () => {
          setView("settings");
          setActiveSessionId(null);
          setStopConfirmOpen(false);
        },
      }),
      registerCoreCommand({
        id: "core:toggle-command-palette",
        name: "Toggle command palette",
        icon: "❯",
        category: "view",
        hotkey: "Ctrl+P",
        callback: () => {
          setPaletteOpen((o) => !o);
        },
      }),
      registerCoreCommand({
        id: "core:open-tag-input",
        name: "Edit tags",
        icon: "#",
        category: "session",
        hotkey: "Ctrl+T",
        callback: () => {
          if (viewRef.current === "timer") setTagInputOpen(true);
        },
      }),
      registerCoreCommand({
        id: "core:export-sessions",
        name: "Export all sessions",
        icon: "↓",
        category: "data",
        callback: async () => {
          try {
            const path = await invoke<string>("export_all_sessions");
            console.log("[flint] exported to", path);
          } catch (e) {
            console.error("export_all_sessions failed", e);
          }
        },
      }),
      registerCoreCommand({
        id: "core:open-data-folder",
        name: "Open data folder",
        icon: "▸",
        category: "data",
        callback: () => {
          invoke("open_data_folder").catch((e) =>
            console.error("open_data_folder failed", e),
          );
        },
      }),
      registerCoreCommand({
        id: "core:create-preset",
        name: "Save current config as preset",
        icon: "✦",
        category: "preset",
        callback: () => {
          setPresetFormOpen(true);
        },
      }),
      registerCoreCommand({
        id: "core:manage-presets",
        name: "Manage presets",
        icon: "☰",
        category: "preset",
        callback: () => {
          setView("settings");
          dispatchAfterHooks("preset:manage-requested", {});
        },
      }),
      registerCoreCommand({
        id: "core:rebuild-cache",
        name: "Rebuild session cache",
        icon: "⟳",
        category: "data",
        callback: async () => {
          try {
            await invoke<number>("rebuild_cache");
          } catch (e) {
            console.error("rebuild_cache failed", e);
          }
        },
      }),
      registerCoreCommand({
        id: "core:quit-app",
        name: "Quit Flint",
        icon: "×",
        category: "app",
        hotkey: "Ctrl+Q",
        callback: () => {
          invoke("quit_app").catch((e) =>
            console.error("quit_app failed", e),
          );
        },
      }),
    );
    return () => {
      for (const u of unregs) {
        try {
          u();
        } catch {
          // no-op
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registerCoreCommand, startSession, dispatchAfterHooks]);

  // Per-mode "switch to <plugin>" commands. Re-registered whenever the
  // enabled timer-mode set changes.
  useEffect(() => {
    const unregs: Array<() => void> = [];
    for (const mode of timerModes) {
      unregs.push(
        registerCoreCommand({
          id: `core:switch-plugin:${mode.id}`,
          name: `Switch to ${mode.label}`,
          icon: "▶",
          category: "mode",
          callback: () => {
            if (metaRef.current?.status === "idle") {
              setSelectedMode(mode.id);
            }
          },
        }),
      );
    }
    return () => {
      for (const u of unregs) u();
    };
  }, [timerModes, registerCoreCommand]);

  // Per-preset "start <preset>" commands. Re-registered whenever the preset
  // list changes so saved presets are instantly discoverable via Ctrl+P.
  useEffect(() => {
    const unregs: Array<() => void> = [];
    for (const preset of presets) {
      unregs.push(
        registerCoreCommand({
          id: `preset:load:${preset.id}`,
          name: `Start: ${preset.name}`,
          icon: preset.pinned ? "★" : "▸",
          category: "preset",
          callback: () => {
            void loadPreset(preset);
          },
        }),
      );
    }
    return () => {
      for (const u of unregs) u();
    };
  }, [presets, registerCoreCommand, loadPreset]);

  // Global keyboard handler. Reads the latest `meta` via metaRef so the
  // effect only re-registers when view/stopConfirmOpen/tagInputOpen change
  // (B-H1). startSession/confirmStop/closeSessionDetail are stable callbacks
  // so including them in deps is free.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const currentMeta = metaRef.current;
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement | null;
      const inInput =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        (target as HTMLElement | null)?.isContentEditable === true;

      // Global modifier shortcuts — work even in inputs
      if (mod && !e.altKey) {
        const k = e.key.toLowerCase();
        if (!e.shiftKey && k === "p") {
          e.preventDefault();
          setPaletteOpen((o) => !o);
          return;
        }
        if (paletteOpenRef.current) return;
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
          if (currentMeta?.status === "idle" && view === "timer") {
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

      // Palette is modal — every other shortcut gets swallowed while it's
      // open so the palette input can own the keyboard.
      if (paletteOpenRef.current) return;

      // Unmodified number keys 1..4 load pinned presets — the quick-start
      // bar's numbered shortcuts. Only active when idle in the timer view
      // and no tag/stop overlay is open.
      if (
        !mod &&
        !e.altKey &&
        !e.shiftKey &&
        !inInput &&
        view === "timer" &&
        !tagInputOpen &&
        !stopConfirmOpen &&
        currentMeta?.status === "idle" &&
        e.key.length === 1 &&
        e.key >= "1" &&
        e.key <= "4"
      ) {
        const idx = Number(e.key) - 1;
        const pinned = presetsRef.current
          .filter((p) => p.pinned)
          .sort((a, b) => a.sort_order - b.sort_order);
        const preset = pinned[idx];
        if (preset) {
          e.preventDefault();
          void loadPreset(preset);
          return;
        }
      }

      // Escape is global — always handled here unless an input
      // intentionally stops propagation (e.g. TagInput, palette, preset form).
      if (e.key === "Escape") {
        e.preventDefault();
        if (paletteOpenRef.current) {
          setPaletteOpen(false);
          return;
        }
        if (presetFormOpen) {
          setPresetFormOpen(false);
          return;
        }
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
        if (currentMeta && currentMeta.status !== "idle") {
          setStopConfirmOpen(true);
          return;
        }
        return;
      }

      // PR-H4: Tab cycles focus between sidebar and main regions. Only
      // plain Tab (no modifier) outside inputs — Shift+Tab and inner
      // focus cycling are left to the browser. If the sidebar is hidden
      // there is nothing to swap to, so we let Tab pass through. When
      // landing in a region, prefer its first focusable descendant so
      // the session-log roving tabindex (PR-H5) receives the focus
      // and arrow keys work immediately.
      if (
        e.key === "Tab" &&
        !e.shiftKey &&
        !mod &&
        !e.altKey &&
        !inInput &&
        sidebarVisible
      ) {
        const sidebarEl = document.getElementById("flint-sidebar");
        const mainEl = document.getElementById("flint-main");
        if (sidebarEl && mainEl) {
          e.preventDefault();
          const inSidebar = sidebarEl.contains(document.activeElement);
          const target = inSidebar ? mainEl : sidebarEl;
          // Prefer a roving-tabindex target if one exists in the
          // region — that way landing in the sidebar puts focus on
          // the session log's selected row and arrow keys work
          // immediately. Fall back to any natural focusable child,
          // or the region container as a last resort.
          const rovingFocus = target.querySelector<HTMLElement>('[tabindex="0"]');
          const first =
            rovingFocus ??
            target.querySelector<HTMLElement>(
              'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), a[href]',
            );
          (first ?? target).focus();
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
        if (currentMeta && currentMeta.status !== "idle") {
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
        if (!currentMeta) return;
        if (currentMeta.status === "idle") {
          startSession();
        } else if (currentMeta.status === "running") {
          invoke("pause_session").catch((err) =>
            console.error("pause_session failed", err),
          );
        } else if (currentMeta.status === "paused") {
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
    presetFormOpen,
    sidebarVisible,
    startSession,
    confirmStop,
    closeSessionDetail,
    loadPreset,
  ]);

  const sidebarWidth = config?.appearance.sidebar_width ?? 220;

  return (
    <div className="flex h-full w-full overflow-hidden bg-[var(--bg-void)] text-[var(--text-primary)]">
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

      {/* PR-H4: main-area focus target. tabIndex={-1} makes it
          programmatically focusable so Tab (handled in the keyboard
          effect above) can swap focus between the sidebar and main
          regions without triggering the default tab-cycle behaviour. */}
      <main
        id="flint-main"
        tabIndex={-1}
        className="flex min-w-0 flex-1 flex-col outline-none"
      >
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
                meta={meta}
                config={config}
                selectedMode={selectedMode}
                stagedTags={stagedTags}
                tagInputOpen={tagInputOpen}
                stopConfirmOpen={stopConfirmOpen}
                hintDismissed={hintDismissed}
                presets={presets}
                onTagConfirm={onTagConfirm}
                onTagCancel={() => setTagInputOpen(false)}
                onTagsChange={onTagsChange}
                onLoadPreset={loadPreset}
              />
            </div>
            <StatusBar meta={meta} selectedMode={selectedMode} />
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
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
      />
      <PresetForm
        open={presetFormOpen}
        onClose={() => setPresetFormOpen(false)}
        onSaved={() => {
          refreshPresets();
        }}
        config={config}
        defaultMode={selectedMode}
        initialTags={stagedTags}
      />
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
    <div
      className="flex items-center justify-between border-b border-[var(--border)] px-3"
      style={{ height: 28 }}
    >
      <button
        onClick={onToggleSidebar}
        className="text-[14px] text-[var(--text-muted)] transition-colors duration-100 ease-out hover:text-[var(--text-bright)]"
        title="Toggle sidebar (Ctrl+B)"
        style={{ lineHeight: 1 }}
      >
        {sidebarVisible ? "«" : "»"}
      </button>
      <div className="text-[10px] uppercase tracking-[0.24em] text-[var(--text-muted)]">
        FLINT
      </div>
      <div className="w-6" />
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
