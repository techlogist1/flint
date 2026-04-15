import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Mode } from "../lib/types";
import type { Preset } from "../lib/presets";
import type { ConfigSchemaField, PluginDescriptor } from "../lib/plugins";
import { FlintSelect, type SelectOption } from "./select";
import { FlintErrorBoundary } from "./error-boundary";
import { usePlugins, useTimerModes } from "./plugin-host";

interface PresetFormProps {
  open: boolean;
  onClose: () => void;
  onSaved: (preset: Preset) => void;
  onDeleted?: (id: string) => void;
  defaultMode: Mode;
  initialTags: string[];
  /** If supplied the form enters EDIT mode: fields are pre-populated from
   *  this preset and save writes back to the same id. */
  editing?: Preset | null;
}

/**
 * Terminal-style modal for creating or editing a preset. The body dynamically
 * renders the selected plugin's `config_schema` so users can capture their
 * custom durations / toggles as session-scoped overrides. Overrides live in
 * the preset JSON — never in config.toml — so experimenting is safe.
 */
export function PresetForm({
  open,
  onClose,
  onSaved,
  onDeleted,
  defaultMode,
  initialTags,
  editing,
}: PresetFormProps) {
  return (
    <FlintErrorBoundary label="preset-form">
      {open && (
        <PresetFormInner
          onClose={onClose}
          onSaved={onSaved}
          onDeleted={onDeleted}
          defaultMode={defaultMode}
          initialTags={initialTags}
          editing={editing ?? null}
        />
      )}
    </FlintErrorBoundary>
  );
}

function PresetFormInner({
  onClose,
  onSaved,
  onDeleted,
  defaultMode,
  initialTags,
  editing,
}: Omit<PresetFormProps, "open"> & { editing: Preset | null }) {
  const timerModes = useTimerModes();
  const { plugins } = usePlugins();
  const isEditing = editing != null;

  const [name, setName] = useState(editing?.name ?? "");
  const [pluginId, setPluginId] = useState<string>(
    editing?.plugin_id ?? defaultMode,
  );
  const [tagsText, setTagsText] = useState(
    (editing?.tags ?? initialTags).join(", "),
  );
  const [pinned, setPinned] = useState(editing?.pinned ?? true);
  const [overrides, setOverrides] = useState<Record<string, unknown>>(
    editing?.config_overrides ?? {},
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameInputRef.current?.focus();
    nameInputRef.current?.select();
  }, []);

  const modeOptions = useMemo<SelectOption[]>(
    () => timerModes.map((m) => ({ value: m.id, label: m.label })),
    [timerModes],
  );

  const activePlugin = useMemo<PluginDescriptor | null>(
    () => plugins.find((p) => p.manifest.id === pluginId) ?? null,
    [plugins, pluginId],
  );

  const schemaEntries = useMemo<[string, ConfigSchemaField][]>(
    () =>
      activePlugin ? Object.entries(activePlugin.manifest.config_schema) : [],
    [activePlugin],
  );

  // When the plugin changes, reset the override map to the plugin's current
  // config values (fetched live from the backend). For the plugin that was
  // stored in `editing`, keep the preset's saved overrides so editing feels
  // non-destructive.
  const baselineFetchKey = pluginId;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const current = await invoke<Record<string, unknown>>(
          "get_plugin_config",
          { pluginId: baselineFetchKey },
        );
        if (cancelled) return;
        const baseline: Record<string, unknown> = { ...current };
        const keepExisting =
          isEditing && editing.plugin_id === baselineFetchKey;
        if (keepExisting) {
          for (const [k, v] of Object.entries(editing.config_overrides)) {
            baseline[k] = v;
          }
        }
        setOverrides(baseline);
      } catch (e) {
        console.error("[preset-form] get_plugin_config failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baselineFetchKey, isEditing, editing]);

  const setOverride = useCallback((key: string, value: unknown) => {
    setOverrides((prev) => ({ ...prev, [key]: value }));
  }, []);

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
    // Only persist keys that actually exist in the plugin schema — if the
    // user switched plugins mid-edit the baseline might have residual keys
    // from the previous plugin, and saving those would bloat the JSON.
    const filteredOverrides: Record<string, unknown> = {};
    for (const [key] of schemaEntries) {
      if (key in overrides) filteredOverrides[key] = overrides[key];
    }
    try {
      const preset = await invoke<Preset>("save_preset", {
        preset: {
          name: trimmedName,
          plugin_id: pluginId,
          config_overrides: filteredOverrides,
          tags: tagList,
          pinned,
          sort_order: editing?.sort_order ?? 0,
          id: editing?.id ?? null,
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
    overrides,
    schemaEntries,
    editing,
    onSaved,
    onClose,
  ]);

  const runDelete = useCallback(async () => {
    if (!editing || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await invoke("delete_preset", { id: editing.id });
      onDeleted?.(editing.id);
      onClose();
    } catch (e) {
      setError(String(e));
      setDeleting(false);
      setConfirmDelete(false);
    }
  }, [editing, deleting, onDeleted, onClose]);

  return (
    <div
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 60,
        backgroundColor: "rgba(5,5,5,0.7)",
      }}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="border border-[var(--border-focus)] bg-[var(--bg-primary)]"
        style={{
          position: "fixed",
          top: "14vh",
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(480px, 92vw)",
          zIndex: 61,
        }}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
          <span className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)]">
            {isEditing ? "EDIT PRESET" : "NEW PRESET"}
          </span>
          <button
            onClick={onClose}
            className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text-bright)]"
            title="Close (Esc)"
          >
            ×
          </button>
        </div>

        <div className="flex max-h-[68vh] flex-col gap-3 overflow-y-auto px-3 py-3 text-[11px]">
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
              placeholder="preset name…"
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
              placeholder="comma-separated, e.g. project, deep-work"
              className="w-full border border-[var(--border)] bg-[var(--bg-input)] px-2 py-[4px] text-[11px] text-[var(--text-bright)] placeholder:text-[var(--text-muted)] outline-none focus:border-[var(--accent)]"
            />
          </Field>

          {schemaEntries.length > 0 && (
            <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
              <span className="text-[9px] uppercase tracking-[0.18em] text-[var(--text-muted)]">
                CONFIGURATION
              </span>
              <div className="flex flex-col gap-[6px] pl-[4px]">
                {schemaEntries.map(([key, field]) => (
                  <OverrideField
                    key={`${pluginId}::${key}`}
                    fieldKey={key}
                    field={field}
                    value={overrides[key] ?? field.default}
                    onChange={(v) => setOverride(key, v)}
                  />
                ))}
              </div>
              <span className="text-[9px] text-[var(--text-muted)]">
                # overrides live in the preset only — base config unchanged
              </span>
            </div>
          )}

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

          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="flex items-center gap-2">
              {isEditing && !confirmDelete && (
                <button
                  onClick={() => setConfirmDelete(true)}
                  className="text-[10px] uppercase tracking-[0.18em] text-[var(--text-muted)] hover:text-[var(--status-error)]"
                  title="Delete this preset"
                >
                  [DELETE]
                </button>
              )}
              {isEditing && confirmDelete && (
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em]">
                  <span className="text-[var(--status-error)]">DELETE?</span>
                  <button
                    onClick={() => void runDelete()}
                    disabled={deleting}
                    className="text-[var(--status-error)] hover:text-[var(--text-bright)] disabled:opacity-50"
                  >
                    [YES]
                  </button>
                  <button
                    onClick={() => setConfirmDelete(false)}
                    disabled={deleting}
                    className="text-[var(--text-muted)] hover:text-[var(--text-bright)] disabled:opacity-50"
                  >
                    [NO]
                  </button>
                </div>
              )}
            </div>
            <div className="flex items-center gap-3">
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
                {saving ? "[SAVING…]" : isEditing ? "[UPDATE]" : "[SAVE]"}
              </button>
            </div>
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

function OverrideField({
  fieldKey,
  field,
  value,
  onChange,
}: {
  fieldKey: string;
  field: ConfigSchemaField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-center gap-3">
      <label
        className="text-[11px] lowercase text-[var(--text-secondary)]"
        htmlFor={`preset-field-${fieldKey}`}
      >
        <span className="text-[var(--text-muted)]">· </span>
        {field.label.toLowerCase()}
      </label>
      <div className="flex items-center gap-2">
        {field.type === "number" && (
          <input
            id={`preset-field-${fieldKey}`}
            type="number"
            data-flint-input="true"
            min={field.min}
            max={field.max}
            step={field.step ?? 1}
            value={Number(value ?? 0)}
            onChange={(e) => {
              const raw = Number(e.target.value);
              if (Number.isNaN(raw)) return;
              onChange(raw);
            }}
            className="w-20 border border-[var(--border)] bg-[var(--bg-input)] px-2 py-[3px] text-[11px] tabular-nums text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        )}
        {field.type === "boolean" && (
          <button
            role="switch"
            aria-checked={Boolean(value)}
            onClick={() => onChange(!Boolean(value))}
            className="text-[11px] uppercase tracking-[0.1em]"
            style={{
              color: value ? "var(--accent)" : "var(--text-muted)",
            }}
          >
            [{value ? "ON" : "OFF"}]
          </button>
        )}
        {field.type === "string" && (
          <input
            id={`preset-field-${fieldKey}`}
            type="text"
            data-flint-input="true"
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
            className="w-full max-w-xs border border-[var(--border)] bg-[var(--bg-input)] px-2 py-[3px] text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        )}
        {field.type === "select" && field.options && (
          <FlintSelect
            ariaLabel={field.label}
            value={String(value ?? field.options[0] ?? "")}
            options={field.options.map((opt) => ({ value: opt, label: opt }))}
            onChange={(v) => onChange(v)}
          />
        )}
      </div>
    </div>
  );
}
