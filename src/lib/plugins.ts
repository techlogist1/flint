export type PluginType = "default" | "community";

export interface ConfigSchemaField {
  type: "number" | "boolean" | "string" | "select";
  default: unknown;
  label: string;
  min?: number;
  max?: number;
  options?: string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  type: PluginType;
  entry: string;
  ui_slots: string[];
  events: string[];
  config_section?: string | null;
  config_schema: Record<string, ConfigSchemaField>;
  /**
   * If true, this plugin registers itself as a selectable timer mode —
   * appearing in the tray menu, Ctrl+N shortcuts, and the default-mode
   * dropdown. Community plugins can add new modes by setting this.
   */
  timer_mode?: boolean;
}

export interface PluginDescriptor {
  manifest: PluginManifest;
  source: string;
  enabled: boolean;
  builtin: boolean;
}

export type PluginSlot =
  | "sidebar-tab"
  | "settings"
  | "post-session"
  | "status-bar";
