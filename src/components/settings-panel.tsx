import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Config } from "../lib/types";
import { useTimerModes } from "./plugin-host";
import { PluginSettingsSection } from "./plugin-settings";
import { FlintSelect } from "./select";

interface SettingsPanelProps {
  initial: Config;
  flintDir: string;
  onClose: () => void;
  onSaved: (cfg: Config) => void;
}

export function SettingsPanel({
  initial,
  flintDir,
  onClose,
  onSaved,
}: SettingsPanelProps) {
  const timerModes = useTimerModes();
  const [draft, setDraft] = useState<Config>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedPulse, setSavedPulse] = useState(false);

  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await invoke<Config>("update_config", {
        newConfig: draft,
      });
      onSaved(updated);
      setSavedPulse(true);
      setTimeout(() => setSavedPulse(false), 1200);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const resyncFromBackend = useCallback(async () => {
    try {
      const fresh = await invoke<Config>("get_config");
      setDraft(fresh);
      onSaved(fresh);
    } catch (e) {
      console.error("get_config failed:", e);
    }
  }, [onSaved]);

  const patch = <K extends keyof Config>(key: K, value: Config[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-3">
        <h2 className="text-[13px] uppercase tracking-[0.18em] text-[var(--text-bright)]">
          SETTINGS
        </h2>
        <button
          onClick={onClose}
          className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)] transition-colors duration-100 ease-out hover:text-[var(--text-bright)]"
          title="Close (Esc)"
        >
          [ESC] CLOSE
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-2xl space-y-8">
          <Section title="GENERAL">
            <Field label="default_mode">
              <FlintSelect
                ariaLabel="Default mode"
                value={draft.core.default_mode}
                options={
                  timerModes.length === 0
                    ? [
                        {
                          value: draft.core.default_mode,
                          label: "(no plugins)",
                        },
                      ]
                    : timerModes.map((m) => ({
                        value: m.id,
                        label: m.label.toLowerCase(),
                      }))
                }
                onChange={(v) =>
                  patch("core", { ...draft.core, default_mode: v })
                }
                disabled={timerModes.length === 0}
              />
            </Field>
          </Section>

          <Section title="APPEARANCE">
            <Field label="sidebar_width">
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={180}
                  max={360}
                  value={draft.appearance.sidebar_width}
                  onChange={(e) =>
                    patch("appearance", {
                      ...draft.appearance,
                      sidebar_width: Number(e.target.value),
                    })
                  }
                  className="flex-1"
                  style={{ accentColor: "var(--accent)" }}
                />
                <span className="w-16 text-right text-[11px] tabular-nums text-[var(--text-secondary)]">
                  {draft.appearance.sidebar_width}px
                </span>
              </div>
            </Field>
            <TextToggle
              label="sidebar_visible"
              value={draft.appearance.sidebar_visible}
              onChange={(v) =>
                patch("appearance", {
                  ...draft.appearance,
                  sidebar_visible: v,
                })
              }
            />
          </Section>

          <Section title="OVERLAY">
            <TextToggle
              label="enabled"
              value={draft.overlay.enabled}
              onChange={(v) =>
                patch("overlay", { ...draft.overlay, enabled: v })
              }
            />
            <TextToggle
              label="always_visible"
              value={draft.overlay.always_visible}
              onChange={(v) =>
                patch("overlay", { ...draft.overlay, always_visible: v })
              }
            />
            <Field label="position">
              <FlintSelect
                ariaLabel="Default overlay position"
                value={draft.overlay.position}
                options={[
                  { value: "top-left", label: "top-left" },
                  { value: "top-right", label: "top-right" },
                  { value: "bottom-left", label: "bottom-left" },
                  { value: "bottom-right", label: "bottom-right" },
                ]}
                onChange={(v) =>
                  patch("overlay", { ...draft.overlay, position: v })
                }
              />
            </Field>
            <Field label="opacity">
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0.3}
                  max={1}
                  step={0.05}
                  value={draft.overlay.opacity}
                  onChange={(e) =>
                    patch("overlay", {
                      ...draft.overlay,
                      opacity: Number(e.target.value),
                    })
                  }
                  className="flex-1"
                  style={{ accentColor: "var(--accent)" }}
                />
                <span className="w-16 text-right text-[11px] tabular-nums text-[var(--text-secondary)]">
                  {draft.overlay.opacity.toFixed(2)}
                </span>
              </div>
            </Field>
            <p className="pt-1 text-[10px] leading-relaxed text-[var(--text-muted)]">
              # drag the overlay pill to reposition. position saves
              automatically.
            </p>
          </Section>

          <Section title="TRAY">
            <TextToggle
              label="close_to_tray"
              value={draft.tray.close_to_tray}
              onChange={(v) => patch("tray", { ...draft.tray, close_to_tray: v })}
            />
            <TextToggle
              label="show_timer_in_tray"
              value={draft.tray.show_timer_in_tray}
              onChange={(v) =>
                patch("tray", { ...draft.tray, show_timer_in_tray: v })
              }
            />
          </Section>

          <Section title="KEYBINDINGS">
            <KeybindRow label="start / pause / resume" value="Space" fixed />
            <KeybindRow label="mark question" value="Enter" fixed />
            <KeybindRow label="stop session" value="Escape" fixed />
            <KeybindRow
              label="toggle sidebar"
              value={draft.keybindings.toggle_sidebar}
            />
            <KeybindRow
              label="toggle overlay"
              value={draft.keybindings.toggle_overlay}
            />
            <KeybindRow label="quick tag" value={draft.keybindings.quick_tag} />
            <p className="pt-1 text-[10px] leading-relaxed text-[var(--text-muted)]">
              # core keys are fixed. edit ~/.flint/config.toml for the rest.
            </p>
          </Section>

          <PluginSettingsSection onConfigPersisted={resyncFromBackend} />

          <Section title="DATA">
            <Field label="flint_dir">
              <span className="truncate text-[11px] text-[var(--text-secondary)]">
                {flintDir}
              </span>
            </Field>
            <OpenDataFolderRow />
            <RebuildCacheRow />
            <ExportSessionsRow />
          </Section>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-6 py-3">
        <div className="text-[10px] uppercase tracking-[0.18em]">
          {error ? (
            <span className="text-[var(--status-error)]">
              ERR: {error}
            </span>
          ) : savedPulse ? (
            <span className="text-[var(--accent)]">◆ SAVED</span>
          ) : (
            <span className="text-[var(--text-muted)]">
              # writes ~/.flint/config.toml
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setDraft(initial)}
            className="border border-[var(--border)] px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)] transition-colors duration-100 ease-out hover:border-[var(--border-focus)] hover:text-[var(--text-bright)]"
            disabled={saving}
          >
            RESET
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="border border-[var(--accent-tinted-border)] bg-[var(--accent-subtle)] px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-[var(--accent)] transition-colors duration-100 ease-out hover:border-[var(--accent)] disabled:opacity-50"
          >
            {saving ? "SAVING…" : "SAVE"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <h3 className="border-b border-[var(--border)] pb-1 text-[11px] uppercase tracking-[0.18em] text-[var(--text-bright)]">
        <span className="text-[var(--text-muted)]">## </span>
        {title}
      </h3>
      <div className="space-y-[6px] pl-[4px]">{children}</div>
    </section>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[220px_1fr] items-center gap-4">
      <label className="text-[11px] text-[var(--text-secondary)]">
        <span className="text-[var(--text-muted)]">· </span>
        {label}
      </label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function TextToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-[220px_1fr] items-center gap-4">
      <label className="text-[11px] text-[var(--text-secondary)]">
        <span className="text-[var(--text-muted)]">· </span>
        {label}
      </label>
      <button
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className="w-fit text-[11px] uppercase tracking-[0.1em] transition-colors duration-100 ease-out"
        style={{
          color: value ? "var(--accent)" : "var(--text-muted)",
        }}
      >
        [{value ? "ON" : "OFF"}]
      </button>
    </div>
  );
}

function KeybindRow({
  label,
  value,
  fixed,
}: {
  label: string;
  value: string;
  fixed?: boolean;
}) {
  return (
    <div className="grid grid-cols-[220px_1fr] items-center gap-4">
      <label className="text-[11px] text-[var(--text-secondary)]">
        <span className="text-[var(--text-muted)]">· </span>
        {label}
      </label>
      <div className="flex items-center gap-3">
        <span className="text-[11px] text-[var(--text-primary)]">
          {value.toLowerCase()}
        </span>
        {fixed && (
          <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
            FIXED
          </span>
        )}
      </div>
    </div>
  );
}

function RebuildCacheRow() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rebuild = async () => {
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const count = await invoke<number>("rebuild_cache");
      setMessage(`rebuilt from ${count} file${count === 1 ? "" : "s"}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid grid-cols-[220px_1fr] items-center gap-4">
      <label className="text-[11px] text-[var(--text-secondary)]">
        <span className="text-[var(--text-muted)]">· </span>
        sqlite_cache
      </label>
      <div className="flex items-center gap-3">
        <button
          onClick={rebuild}
          disabled={pending}
          className="border border-[var(--border)] px-3 py-[3px] text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)] transition-colors duration-100 ease-out hover:border-[var(--border-focus)] hover:text-[var(--text-bright)] disabled:opacity-50"
        >
          {pending ? "REBUILDING…" : "REBUILD"}
        </button>
        {message && (
          <span className="text-[10px] text-[var(--accent)]">{message}</span>
        )}
        {error && (
          <span className="text-[10px] text-[var(--status-error)]">{error}</span>
        )}
      </div>
    </div>
  );
}

function OpenDataFolderRow() {
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setError(null);
    try {
      await invoke("open_data_folder");
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="grid grid-cols-[220px_1fr] items-center gap-4">
      <label className="text-[11px] text-[var(--text-secondary)]">
        <span className="text-[var(--text-muted)]">· </span>
        data_folder
      </label>
      <div className="flex items-center gap-3">
        <button
          onClick={open}
          className="border border-[var(--border)] px-3 py-[3px] text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)] transition-colors duration-100 ease-out hover:border-[var(--border-focus)] hover:text-[var(--text-bright)]"
        >
          OPEN
        </button>
        {error && (
          <span className="text-[10px] text-[var(--status-error)]">{error}</span>
        )}
      </div>
    </div>
  );
}

function ExportSessionsRow() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const exportAll = async () => {
    setPending(true);
    setError(null);
    setMessage(null);
    try {
      const path = await invoke<string>("export_all_sessions");
      setMessage(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid grid-cols-[220px_1fr] items-start gap-4">
      <label className="mt-1 text-[11px] text-[var(--text-secondary)]">
        <span className="text-[var(--text-muted)]">· </span>
        export_sessions
      </label>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <button
            onClick={exportAll}
            disabled={pending}
            className="border border-[var(--border)] px-3 py-[3px] text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)] transition-colors duration-100 ease-out hover:border-[var(--border-focus)] hover:text-[var(--text-bright)] disabled:opacity-50"
          >
            {pending ? "EXPORTING…" : "EXPORT ALL"}
          </button>
          {error && (
            <span className="text-[10px] text-[var(--status-error)]">
              {error}
            </span>
          )}
        </div>
        {message && (
          <span className="break-all text-[10px] text-[var(--accent)]">
            → {message}
          </span>
        )}
      </div>
    </div>
  );
}
