import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Config, Mode } from "../lib/types";
import type { Preset } from "../lib/presets";
import { FlintSelect, type SelectOption } from "./select";
import { FlintErrorBoundary } from "./error-boundary";
import { useTimerModes } from "./plugin-host";

interface PresetFormProps {
  open: boolean;
  onClose: () => void;
  onSaved: (preset: Preset) => void;
  config: Config | null;
  defaultMode: Mode;
  initialTags: string[];
}

/**
 * Terminal-style modal for creating a new preset. Name, plugin, tags,
 * pinned toggle — that's it. Config overrides are captured from the current
 * plugin config at save time so the preset "freezes" whatever the user has
 * configured when they hit save.
 */
export function PresetForm({
  open,
  onClose,
  onSaved,
  config,
  defaultMode,
  initialTags,
}: PresetFormProps) {
  return (
    <FlintErrorBoundary label="preset-form">
      {open && (
        <PresetFormInner
          onClose={onClose}
          onSaved={onSaved}
          config={config}
          defaultMode={defaultMode}
          initialTags={initialTags}
        />
      )}
    </FlintErrorBoundary>
  );
}

function PresetFormInner({
  onClose,
  onSaved,
  config,
  defaultMode,
  initialTags,
}: Omit<PresetFormProps, "open">) {
  const timerModes = useTimerModes();
  const [name, setName] = useState("");
  const [pluginId, setPluginId] = useState<string>(defaultMode);
  const [tagsText, setTagsText] = useState(initialTags.join(", "));
  const [pinned, setPinned] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
  }, []);

  const modeOptions = useMemo<SelectOption[]>(
    () => timerModes.map((m) => ({ value: m.id, label: m.label })),
    [timerModes],
  );

  const captureOverrides = useCallback((): Record<string, unknown> => {
    if (!config) return {};
    if (pluginId === "pomodoro") {
      return {
        focus_duration: config.pomodoro.focus_duration,
        break_duration: config.pomodoro.break_duration,
        long_break_duration: config.pomodoro.long_break_duration,
        cycles_before_long: config.pomodoro.cycles_before_long,
        auto_start_breaks: config.pomodoro.auto_start_breaks,
        auto_start_focus: config.pomodoro.auto_start_focus,
      };
    }
    if (pluginId === "countdown") {
      return {
        countdown_default_min: config.core.countdown_default_min,
      };
    }
    return {};
  }, [config, pluginId]);

  const submit = useCallback(async () => {
    if (saving) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("name is required");
      return;
    }
    setError(null);
    setSaving(true);
    const tagList = tagsText
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    try {
      const preset = await invoke<Preset>("save_preset", {
        preset: {
          name: trimmedName,
          plugin_id: pluginId,
          config_overrides: captureOverrides(),
          tags: tagList,
          pinned,
          sort_order: 0,
          id: null,
        },
      });
      onSaved(preset);
      onClose();
    } catch (e) {
      setError(String(e));
      setSaving(false);
    }
  }, [
    saving,
    name,
    tagsText,
    pluginId,
    pinned,
    captureOverrides,
    onSaved,
    onClose,
  ]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        backgroundColor: "rgba(5,5,5,0.7)",
        paddingTop: "14vh",
      }}
    >
      <div
        className="w-full max-w-md border border-[var(--border-focus)] bg-[var(--bg-primary)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
          <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            NEW PRESET
          </span>
          <button
            onClick={onClose}
            className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-bright)]"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-3 px-3 py-3 text-[11px]">
          <Field label="NAME">
            <input
              ref={nameInputRef}
              data-flint-input="true"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  onClose();
                }
              }}
              placeholder="BITSAT Grind"
              className="w-full border border-[var(--border)] bg-[var(--bg-input)] px-2 py-[4px] text-[11px] text-[var(--text-bright)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent)]"
            />
          </Field>

          <Field label="MODE">
            <FlintSelect
              value={pluginId}
              options={modeOptions}
              onChange={setPluginId}
              ariaLabel="Preset mode"
            />
          </Field>

          <Field label="TAGS">
            <input
              data-flint-input="true"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  onClose();
                }
              }}
              placeholder="physics, math"
              className="w-full border border-[var(--border)] bg-[var(--bg-input)] px-2 py-[4px] text-[11px] text-[var(--text-bright)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent)]"
            />
          </Field>

          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
              className="h-[10px] w-[10px] accent-[var(--accent)]"
            />
            <span>PIN TO QUICK-START BAR</span>
          </label>

          {error && (
            <div className="text-[10px] text-[var(--status-error)]">
              ERROR: {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-3 pt-1">
            <button
              onClick={onClose}
              className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)] hover:text-[var(--text-bright)]"
            >
              [CANCEL]
            </button>
            <button
              onClick={() => {
                void submit();
              }}
              disabled={saving || !name.trim()}
              className="border border-[var(--border-focus)] px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-[var(--text-primary)] hover:border-[var(--accent)] hover:text-[var(--accent)] disabled:opacity-50"
            >
              {saving ? "[SAVING…]" : "[SAVE]"}
            </button>
          </div>
        </div>
      </div>
    </div>
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
    <div className="flex flex-col gap-[4px]">
      <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
        {label}
      </span>
      {children}
    </div>
  );
}
