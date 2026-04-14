import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Config } from "../lib/types";
import { PluginSettingsSection } from "./plugin-settings";

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
              <select
                value={draft.core.default_mode}
                onChange={(e) =>
                  patch("core", { ...draft.core, default_mode: e.target.value })
                }
                className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none transition-colors duration-150 ease-out focus:border-[var(--accent)]"
              >
                <option value="pomodoro">Pomodoro</option>
                <option value="stopwatch">Stopwatch</option>
                <option value="countdown">Countdown</option>
              </select>
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
            <Field label="Position">
              <select
                value={draft.overlay.position}
                onChange={(e) =>
                  patch("overlay", {
                    ...draft.overlay,
                    position: e.target.value,
                  })
                }
                className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none transition-colors duration-150 ease-out focus:border-[var(--accent)]"
              >
                <option value="top-left">Top left</option>
                <option value="top-right">Top right</option>
                <option value="bottom-left">Bottom left</option>
                <option value="bottom-right">Bottom right</option>
              </select>
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
            <p className="text-[11px] text-[var(--text-muted)]">
              Session files, config, and recovery all live here. Folder
              actions and cache rebuild land in Phase 5.
            </p>
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
  mono,
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
        <span
          className={`rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-0.5 text-xs text-[var(--text-primary)] ${
            mono ? "font-mono" : "font-mono"
          }`}
        >
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
