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
      <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
        <h2 className="text-lg font-medium text-[var(--text-primary)]">
          Settings
        </h2>
        <button
          onClick={onClose}
          className="rounded px-2 py-1 text-xs text-[var(--text-secondary)] transition-colors duration-150 ease-out hover:text-[var(--text-primary)]"
          title="Close (Esc)"
        >
          Close · Esc
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-2xl space-y-8">
          <Section title="General">
            <Field label="Default mode">
              <FlintSelect
                ariaLabel="Default mode"
                value={draft.core.default_mode}
                options={
                  timerModes.length === 0
                    ? [
                        {
                          value: draft.core.default_mode,
                          label: "(no timer mode plugins enabled)",
                        },
                      ]
                    : timerModes.map((m) => ({ value: m.id, label: m.label }))
                }
                onChange={(v) =>
                  patch("core", { ...draft.core, default_mode: v })
                }
                disabled={timerModes.length === 0}
              />
            </Field>
          </Section>

          <Section title="Appearance">
            <Field label="Sidebar width">
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={160}
                  max={360}
                  value={draft.appearance.sidebar_width}
                  onChange={(e) =>
                    patch("appearance", {
                      ...draft.appearance,
                      sidebar_width: Number(e.target.value),
                    })
                  }
                  className="flex-1 accent-[var(--accent)]"
                />
                <span className="w-12 text-right font-mono text-xs text-[var(--text-secondary)]">
                  {draft.appearance.sidebar_width}px
                </span>
              </div>
            </Field>
            <Toggle
              label="Sidebar visible on launch"
              value={draft.appearance.sidebar_visible}
              onChange={(v) =>
                patch("appearance", {
                  ...draft.appearance,
                  sidebar_visible: v,
                })
              }
            />
          </Section>

          <Section title="Overlay">
            <Toggle
              label="Enabled"
              value={draft.overlay.enabled}
              onChange={(v) =>
                patch("overlay", { ...draft.overlay, enabled: v })
              }
            />
            <Toggle
              label="Always visible"
              value={draft.overlay.always_visible}
              onChange={(v) =>
                patch("overlay", { ...draft.overlay, always_visible: v })
              }
            />
            <Field label="Default position">
              <FlintSelect
                ariaLabel="Default overlay position"
                value={draft.overlay.position}
                options={[
                  { value: "top-left", label: "Top left" },
                  { value: "top-right", label: "Top right" },
                  { value: "bottom-left", label: "Bottom left" },
                  { value: "bottom-right", label: "Bottom right" },
                ]}
                onChange={(v) =>
                  patch("overlay", { ...draft.overlay, position: v })
                }
              />
            </Field>
            <Field label="Opacity">
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
                  className="flex-1 accent-[var(--accent)]"
                />
                <span className="w-12 text-right font-mono text-xs text-[var(--text-secondary)]">
                  {draft.overlay.opacity.toFixed(2)}
                </span>
              </div>
            </Field>
            <p className="text-[11px] text-[var(--text-muted)]">
              Drag the overlay pill to reposition it. The new position is saved
              automatically.
            </p>
          </Section>

          <Section title="System tray">
            <Toggle
              label="Close to tray"
              value={draft.tray.close_to_tray}
              onChange={(v) =>
                patch("tray", { ...draft.tray, close_to_tray: v })
              }
            />
            <Toggle
              label="Show timer in tooltip"
              value={draft.tray.show_timer_in_tray}
              onChange={(v) =>
                patch("tray", { ...draft.tray, show_timer_in_tray: v })
              }
            />
          </Section>

          <Section title="Keybindings">
            <ReadOnlyRow label="Start / pause / resume" value="Space" fixed />
            <ReadOnlyRow label="Mark question" value="Enter" fixed />
            <ReadOnlyRow label="Stop session" value="Escape" fixed />
            <ReadOnlyRow
              label="Toggle sidebar"
              value={draft.keybindings.toggle_sidebar}
            />
            <ReadOnlyRow
              label="Toggle overlay"
              value={draft.keybindings.toggle_overlay}
            />
            <ReadOnlyRow
              label="Quick tag"
              value={draft.keybindings.quick_tag}
            />
            <p className="text-[11px] text-[var(--text-muted)]">
              Core keys (Space/Enter/Escape) are fixed. Rebinding UI for the
              rest lands in a later phase — edit config.toml directly for now.
            </p>
          </Section>

          <PluginSettingsSection onConfigPersisted={resyncFromBackend} />

          <Section title="Data">
            <ReadOnlyRow label="Data directory" value={flintDir} mono />
            <OpenDataFolderRow />
            <RebuildCacheRow />
            <ExportSessionsRow />
          </Section>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-[var(--border)] px-6 py-3">
        <div className="text-xs text-[var(--text-muted)]">
          {error ? (
            <span className="text-[var(--danger)]">{error}</span>
          ) : savedPulse ? (
            <span className="text-[var(--success)]">Saved</span>
          ) : (
            <span>Changes write to ~/.flint/config.toml</span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setDraft(initial)}
            className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-secondary)] transition-colors duration-150 ease-out hover:text-[var(--text-primary)]"
            disabled={saving}
          >
            Reset
          </button>
          <button
            onClick={save}
            disabled={saving}
            className="rounded border border-[var(--accent)] bg-[var(--accent-subtle)] px-3 py-1.5 text-xs text-[var(--accent)] transition-colors duration-150 ease-out hover:bg-[var(--accent)]/20 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save"}
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
      <h3 className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
        {title}
      </h3>
      <div className="space-y-2 rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
        {children}
      </div>
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
    <div className="grid grid-cols-[200px_1fr] items-center gap-4">
      <label className="text-xs text-[var(--text-secondary)]">{label}</label>
      <div>{children}</div>
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="grid grid-cols-[200px_1fr] items-center gap-4">
      <label className="text-xs text-[var(--text-secondary)]">{label}</label>
      <button
        role="switch"
        aria-checked={value}
        onClick={() => onChange(!value)}
        className={`flex h-5 w-9 items-center rounded-full border border-[var(--border)] px-0.5 transition-colors duration-150 ease-out ${
          value ? "bg-[var(--accent-subtle)]" : "bg-[var(--bg-elevated)]"
        }`}
      >
        <span
          className={`h-3.5 w-3.5 rounded-full transition-transform duration-150 ease-out ${
            value
              ? "translate-x-4 bg-[var(--accent)]"
              : "bg-[var(--text-muted)]"
          }`}
        />
      </button>
    </div>
  );
}

function ReadOnlyRow({
  label,
  value,
  fixed,
}: {
  label: string;
  value: string;
  mono?: boolean;
  fixed?: boolean;
}) {
  return (
    <div className="grid grid-cols-[200px_1fr] items-center gap-4">
      <label className="text-xs text-[var(--text-secondary)]">{label}</label>
      <div className="flex items-center gap-2">
        <span className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-0.5 font-mono text-xs text-[var(--text-primary)]">
          {value}
        </span>
        {fixed && (
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            fixed
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
      setMessage(`Rebuilt from ${count} session file${count === 1 ? "" : "s"}.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid grid-cols-[200px_1fr] items-center gap-4">
      <label className="text-xs text-[var(--text-secondary)]">SQLite cache</label>
      <div className="flex items-center gap-3">
        <button
          onClick={rebuild}
          disabled={pending}
          className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1 text-xs text-[var(--text-secondary)] transition-colors duration-150 ease-out hover:text-[var(--text-primary)] disabled:opacity-50"
        >
          {pending ? "Rebuilding…" : "Rebuild"}
        </button>
        {message && (
          <span className="text-[11px] text-[var(--success)]">{message}</span>
        )}
        {error && (
          <span className="text-[11px] text-[var(--danger)]">{error}</span>
        )}
      </div>
    </div>
  );
}

// PR-H3: reveals the ~/.flint/ data directory in the system file explorer
// so users can inspect session files, plugin data, and config.toml
// without leaving the app.
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
    <div className="grid grid-cols-[200px_1fr] items-center gap-4">
      <label className="text-xs text-[var(--text-secondary)]">Data folder</label>
      <div className="flex items-center gap-3">
        <button
          onClick={open}
          className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1 text-xs text-[var(--text-secondary)] transition-colors duration-150 ease-out hover:text-[var(--text-primary)]"
        >
          Open data folder
        </button>
        {error && (
          <span className="text-[11px] text-[var(--danger)]">{error}</span>
        )}
      </div>
    </div>
  );
}

// PR-H3: exports every JSON session file into a single combined JSON
// array under ~/.flint/exports/. Shows the absolute path on success so
// the user can open it from "Open data folder" above.
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
      setMessage(`Exported to ${path}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="grid grid-cols-[200px_1fr] items-start gap-4">
      <label className="mt-1 text-xs text-[var(--text-secondary)]">
        Export sessions
      </label>
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <button
            onClick={exportAll}
            disabled={pending}
            className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-1 text-xs text-[var(--text-secondary)] transition-colors duration-150 ease-out hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            {pending ? "Exporting…" : "Export all sessions"}
          </button>
          {error && (
            <span className="text-[11px] text-[var(--danger)]">{error}</span>
          )}
        </div>
        {message && (
          <span className="break-all font-mono text-[10px] text-[var(--success)]">
            {message}
          </span>
        )}
      </div>
    </div>
  );
}
