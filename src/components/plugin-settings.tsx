import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { usePlugins } from "./plugin-host";
import type { ConfigSchemaField, PluginDescriptor } from "../lib/plugins";
import { FlintSelect } from "./select";

interface PluginSettingsSectionProps {
  onConfigPersisted: () => Promise<void> | void;
}

export function PluginSettingsSection({
  onConfigPersisted,
}: PluginSettingsSectionProps) {
  const { plugins, setPluginEnabled } = usePlugins();

  return (
    <div className="space-y-3">
      <h3 className="text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
        Plugins
      </h3>
      <div className="space-y-3">
        {plugins.map((plugin) => (
          <PluginCard
            key={plugin.manifest.id}
            plugin={plugin}
            onToggle={(enabled) =>
              setPluginEnabled(plugin.manifest.id, enabled)
            }
            onConfigPersisted={onConfigPersisted}
          />
        ))}
        {plugins.length === 0 && (
          <p className="rounded border border-dashed border-[var(--border)] bg-[var(--bg-secondary)] p-4 text-xs text-[var(--text-muted)]">
            No plugins discovered. Drop a plugin folder into ~/.flint/plugins/
            and reopen settings.
          </p>
        )}
      </div>
    </div>
  );
}

function PluginCard({
  plugin,
  onToggle,
  onConfigPersisted,
}: {
  plugin: PluginDescriptor;
  onToggle: (enabled: boolean) => Promise<void> | void;
  onConfigPersisted: () => Promise<void> | void;
}) {
  const schemaEntries = Object.entries(plugin.manifest.config_schema);
  const hasConfig = schemaEntries.length > 0;

  return (
    <div className="rounded border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm text-[var(--text-primary)]">
              {plugin.manifest.name}
            </span>
            <span className="rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
              {plugin.manifest.type}
            </span>
            <span className="font-mono text-[10px] text-[var(--text-muted)]">
              v{plugin.manifest.version}
            </span>
          </div>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            {plugin.manifest.description}
          </p>
          <p className="mt-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">
            by {plugin.manifest.author}
          </p>
        </div>
        <ToggleSwitch
          value={plugin.enabled}
          onChange={(v) => onToggle(v)}
        />
      </div>

      {plugin.enabled && hasConfig && (
        <div className="mt-4 border-t border-[var(--border)] pt-3">
          <PluginConfigForm
            pluginId={plugin.manifest.id}
            schema={schemaEntries}
            onConfigPersisted={onConfigPersisted}
          />
        </div>
      )}
    </div>
  );
}

function PluginConfigForm({
  pluginId,
  schema,
  onConfigPersisted,
}: {
  pluginId: string;
  schema: [string, ConfigSchemaField][];
  onConfigPersisted: () => Promise<void> | void;
}) {
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  useEffect(() => {
    let canceled = false;
    (async () => {
      try {
        const cfg = await invoke<Record<string, unknown>>("get_plugin_config", {
          pluginId,
        });
        if (!canceled) setValues(cfg);
      } catch (e) {
        if (!canceled) setError(String(e));
      }
    })();
    return () => {
      canceled = true;
    };
  }, [pluginId]);

  const save = async (key: string, value: unknown) => {
    setPendingKey(key);
    setError(null);
    try {
      await invoke("set_plugin_config", { pluginId, key, value });
      setValues((prev) => (prev ? { ...prev, [key]: value } : prev));
      await onConfigPersisted();
    } catch (e) {
      setError(String(e));
    } finally {
      setPendingKey(null);
    }
  };

  if (values == null) {
    return (
      <p className="text-[11px] text-[var(--text-muted)]">Loading config…</p>
    );
  }

  return (
    <div className="space-y-2">
      {schema.map(([key, field]) => {
        const current = values[key] ?? field.default;
        return (
          <SchemaField
            key={key}
            fieldKey={key}
            field={field}
            value={current}
            pending={pendingKey === key}
            onChange={(v) => save(key, v)}
          />
        );
      })}
      {error && (
        <div className="text-[11px] text-[var(--danger)]">{error}</div>
      )}
    </div>
  );
}

function SchemaField({
  fieldKey,
  field,
  value,
  pending,
  onChange,
}: {
  fieldKey: string;
  field: ConfigSchemaField;
  value: unknown;
  pending: boolean;
  onChange: (v: unknown) => void;
}) {
  // P-H3: number input commits via a 500ms idle debounce instead of every
  // keystroke. The local draft drives the displayed value while typing; when
  // the debounce fires, save runs, the parent's value updates, and the
  // useEffect clears the draft so we fall back to the persisted value.
  const [numberDraft, setNumberDraft] = useState<number | null>(null);
  const numberSaveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (numberSaveTimerRef.current != null) {
        window.clearTimeout(numberSaveTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    // Sync the draft from the parent only while the user is idle. If a save
    // is sitting in the 500ms window, leave the draft alone — otherwise an
    // earlier save resolving would clobber whatever the user just typed.
    if (numberSaveTimerRef.current == null) {
      setNumberDraft(null);
    }
  }, [value]);

  const queueNumberSave = useCallback(
    (raw: number) => {
      setNumberDraft(raw);
      if (numberSaveTimerRef.current != null) {
        window.clearTimeout(numberSaveTimerRef.current);
      }
      numberSaveTimerRef.current = window.setTimeout(() => {
        numberSaveTimerRef.current = null;
        onChange(raw);
      }, 500);
    },
    [onChange],
  );

  const numberDisplay = numberDraft ?? Number(value ?? 0);

  return (
    <div className="grid grid-cols-[200px_1fr] items-center gap-4">
      <label
        className="text-xs text-[var(--text-secondary)]"
        htmlFor={`plugin-field-${fieldKey}`}
      >
        {field.label}
      </label>
      <div className="flex items-center gap-2">
        {field.type === "number" && (
          <input
            id={`plugin-field-${fieldKey}`}
            type="number"
            data-flint-input="true"
            min={field.min}
            max={field.max}
            step={field.step ?? 1}
            value={numberDisplay}
            onChange={(e) => {
              const raw = Number(e.target.value);
              if (Number.isNaN(raw)) return;
              queueNumberSave(raw);
            }}
            className="w-24 rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 font-mono text-xs text-[var(--text-primary)] outline-none transition-colors duration-150 ease-out focus:border-[var(--accent)]"
          />
        )}
        {field.type === "boolean" && (
          <ToggleSwitch
            value={Boolean(value)}
            onChange={(v) => onChange(v)}
          />
        )}
        {field.type === "string" && (
          <input
            id={`plugin-field-${fieldKey}`}
            type="text"
            data-flint-input="true"
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
            className="w-full max-w-xs rounded border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-1 text-xs text-[var(--text-primary)] outline-none transition-colors duration-150 ease-out focus:border-[var(--accent)]"
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
        {pending && (
          <span className="text-[10px] text-[var(--text-muted)]">saving…</span>
        )}
      </div>
    </div>
  );
}

function ToggleSwitch({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`flex h-5 w-9 shrink-0 items-center rounded-full border border-[var(--border)] px-0.5 transition-colors duration-150 ease-out ${
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
  );
}
