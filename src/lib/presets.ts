/**
 * Preset — a saved session configuration. Presets are first-class citizens
 * stored as plain JSON files in `~/.flint/presets/{uuid}.json`, consistent
 * with Flint's local-first, file-based architecture.
 *
 * Config overrides are TEMPORARY: they affect the current session only and
 * never touch config.toml. This lets users experiment without fear of
 * breaking their base config.
 */

export interface Preset {
  id: string;
  name: string;
  plugin_id: string;
  config_overrides: Record<string, unknown>;
  tags: string[];
  pinned: boolean;
  sort_order: number;
  created_at: string;
  last_used_at: string | null;
}

export interface PresetDraft {
  name: string;
  plugin_id: string;
  config_overrides: Record<string, unknown>;
  tags: string[];
  pinned: boolean;
}
