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
    <section className="space-y-3">
      <h3 className="border-b border-[var(--border)] pb-1 text-[11px] uppercase tracking-[0.18em] text-[var(--text-bright)]">
        <span className="text-[var(--text-muted)]">## </span>
        PLUGINS
      </h3>
      <div className="space-y-5 pl-[4px]">
        {plugins.map((plugin) => (
          <PluginRow
            key={plugin.manifest.id}
            plugin={plugin}
            onToggle={(enabled) => setPluginEnabled(plugin.manifest.id, enabled)}
            onConfigPersisted={onConfigPersisted}
          />
        ))}
        {plugins.length === 0 && (
          <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">
            # no plugins discovered. drop a folder into ~/.flint/plugins/.
          </p>
        )}
      </div>
    </section>
  );
}

function PluginRow({
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
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-3">
            <span className="text-[12px] text-[var(--text-bright)]">
              <span className="text-[var(--text-muted)]">[</span>
              {plugin.manifest.id}
              <span className="text-[var(--text-muted)]">]</span>
            </span>
            <span className="text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]">
              {plugin.manifest.type} · v{plugin.manifest.version}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
            {plugin.manifest.description}
          </p>
        </div>
        <TextToggle value={plugin.enabled} onChange={(v) => onToggle(v)} />
      </div>

      {plugin.enabled && hasConfig && (
        <div className="border-l border-[var(--border)] pl-3 pt-1">
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
      <p className="text-[10px] text-[var(--text-muted)]">loading…</p>
    );
  }

  return (
    <div className="space-y-[6px]">
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
        <div className="text-[10px] text-[var(--status-error)]">{error}</div>
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
        className="text-[11px] text-[var(--text-secondary)]"
        htmlFor={`plugin-field-${fieldKey}`}
      >
        <span className="text-[var(--text-muted)]">· </span>
        {field.label.toLowerCase()}
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
            className="w-20 border border-[var(--border)] bg-[var(--bg-input)] px-2 py-[3px] text-[11px] tabular-nums text-[var(--text-primary)] outline-none transition-colors duration-100 ease-out focus:border-[var(--accent)]"
          />
        )}
        {field.type === "boolean" && (
          <TextToggle
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
            className="w-full max-w-xs border border-[var(--border)] bg-[var(--bg-input)] px-2 py-[3px] text-[11px] text-[var(--text-primary)] outline-none transition-colors duration-100 ease-out focus:border-[var(--accent)]"
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
          <span className="text-[9px] uppercase tracking-wider text-[var(--text-muted)]">
            SAVING…
          </span>
        )}
      </div>
    </div>
  );
}

function TextToggle({
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
      className="text-[11px] uppercase tracking-[0.1em] transition-colors duration-100 ease-out"
      style={{
        color: value ? "var(--accent)" : "var(--text-muted)",
      }}
    >
      [{value ? "ON" : "OFF"}]
    </button>
  );
}
