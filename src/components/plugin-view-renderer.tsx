/**
 * [C-1] Declarative render spec interpreter.
 *
 * Plugins describe rich UI as a JSON tree of widgets — text, charts, lists,
 * tables, buttons — and the host renders them via this component using
 * Recharts and its own React tree. The plugin never touches the DOM, never
 * executes React inside the sandbox, and never gets `dangerouslySetInnerHTML`
 * — every leaf is React text content with safe defaults.
 *
 * Defensive layer (plugins are untrusted):
 *   - Unknown widget types render nothing and warn once per (plugin, type).
 *   - Recursion depth is hard-capped (MAX_DEPTH).
 *   - String fields are truncated to MAX_STRING_LEN.
 *   - Array lengths > MAX_ARRAY_LEN are truncated and warned.
 *   - All colors come from CSS variables in src/index.css. No hex literals.
 *   - Wrapped in FlintErrorBoundary so a malformed spec cannot white-screen.
 */
import { type CSSProperties, type ReactNode } from "react";
import { chartColors } from "../lib/chart-colors";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { FlintErrorBoundary } from "./error-boundary";
import { usePlugins } from "./plugin-host";

// ---- Spec types ------------------------------------------------------------

export interface BaseWidget {
  type: string;
  /** Optional CSS variable color hint for widgets that need one. */
  color?: string;
}

export interface ContainerSpec extends BaseWidget {
  type: "container";
  direction?: "row" | "column";
  gap?: number;
  align?: "start" | "center" | "end" | "stretch";
  justify?: "start" | "center" | "end" | "between";
  padding?: number;
  children?: WidgetSpec[];
}

export type TextStyle =
  | "heading"
  | "label"
  | "muted"
  | "accent"
  | "mono"
  | "body";

export interface TextSpec extends BaseWidget {
  type: "text";
  value: string;
  style?: TextStyle;
}

export interface StatSpec {
  label: string;
  value: string | number;
  unit?: string;
}

export interface StatWidgetSpec extends BaseWidget, StatSpec {
  type: "stat";
}

export interface StatRowSpec extends BaseWidget {
  type: "stat-row";
  stats: StatSpec[];
}

export interface BarChartSpec extends BaseWidget {
  type: "bar-chart";
  data: { label: string; value: number }[];
  height?: number;
}

export interface LineChartSpec extends BaseWidget {
  type: "line-chart";
  data: { label: string; value: number }[];
  height?: number;
}

export interface HeatmapSpec extends BaseWidget {
  type: "heatmap";
  data: { date: string; value: number }[];
}

export interface TableSpec extends BaseWidget {
  type: "table";
  columns: string[];
  rows: (string | number)[][];
}

export interface ListItemSpec {
  primary: string;
  secondary?: string;
  icon?: string;
}

export interface ListSpec extends BaseWidget {
  type: "list";
  items: ListItemSpec[];
}

export interface ProgressSpec extends BaseWidget {
  type: "progress";
  value: number;
  max: number;
  label?: string;
}

export interface ButtonSpec extends BaseWidget {
  type: "button";
  label: string;
  commandId: string;
}

export interface DividerSpec extends BaseWidget {
  type: "divider";
}

export interface SpacerSpec extends BaseWidget {
  type: "spacer";
  size?: number;
}

export type WidgetSpec =
  | ContainerSpec
  | TextSpec
  | StatWidgetSpec
  | StatRowSpec
  | BarChartSpec
  | LineChartSpec
  | HeatmapSpec
  | TableSpec
  | ListSpec
  | ProgressSpec
  | ButtonSpec
  | DividerSpec
  | SpacerSpec;

export type RenderSpec = WidgetSpec;

// ---- Defensive caps --------------------------------------------------------

const MAX_DEPTH = 10;
const MAX_STRING_LEN = 5000;
const MAX_ARRAY_LEN = 1000;

// One warn-per-(plugin, key) so a misfiring plugin doesn't spam the console.
const warnSeen = new Set<string>();
function warnOnce(pluginId: string, key: string, msg: string): void {
  const id = `${pluginId}::${key}`;
  if (warnSeen.has(id)) return;
  warnSeen.add(id);
  console.warn(`[plugin-view ${pluginId}] ${msg}`);
}

// Called from plugin-host tearDown so a reloaded plugin can re-emit warnings
// it had already emitted in the previous lifecycle.
export function clearPluginWarnings(pluginId: string): void {
  const prefix = `${pluginId}::`;
  for (const id of warnSeen) {
    if (id.startsWith(prefix)) warnSeen.delete(id);
  }
}

function truncateString(s: unknown, fallback = ""): string {
  if (typeof s !== "string") return fallback;
  if (s.length <= MAX_STRING_LEN) return s;
  return s.slice(0, MAX_STRING_LEN);
}

function truncateArray<T>(
  arr: T[] | undefined,
  pluginId: string,
  key: string,
): T[] {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= MAX_ARRAY_LEN) return arr;
  warnOnce(
    pluginId,
    `array-trunc:${key}`,
    `array "${key}" length ${arr.length} exceeds ${MAX_ARRAY_LEN} — truncated`,
  );
  return arr.slice(0, MAX_ARRAY_LEN);
}

// ---- Renderer --------------------------------------------------------------

interface Props {
  spec: RenderSpec | null;
  pluginId: string;
}

export function PluginViewRenderer({ spec, pluginId }: Props) {
  if (!spec) {
    return (
      <div className="p-3 text-[11px] text-[var(--text-muted)]">
        plugin returned no view
      </div>
    );
  }
  return (
    <FlintErrorBoundary label={`plugin-view-${pluginId}`}>
      <div className="px-3 py-3 text-[12px] text-[var(--text-primary)]">
        <Render node={spec} pluginId={pluginId} depth={0} />
      </div>
    </FlintErrorBoundary>
  );
}

function Render({
  node,
  pluginId,
  depth,
}: {
  node: WidgetSpec | null | undefined;
  pluginId: string;
  depth: number;
}): JSX.Element | null {
  if (node == null || typeof node !== "object") return null;
  if (depth > MAX_DEPTH) {
    return (
      <div className="text-[10px] uppercase tracking-[0.18em] text-[var(--status-error)]">
        [render spec: depth exceeded]
      </div>
    );
  }

  const type = (node as BaseWidget).type;
  switch (type) {
    case "container":
      return (
        <ContainerView
          node={node as ContainerSpec}
          pluginId={pluginId}
          depth={depth}
        />
      );
    case "text":
      return <TextView node={node as TextSpec} />;
    case "stat":
      return <StatView node={node as StatWidgetSpec} />;
    case "stat-row":
      return (
        <StatRowView node={node as StatRowSpec} pluginId={pluginId} />
      );
    case "bar-chart":
      return (
        <BarChartView node={node as BarChartSpec} pluginId={pluginId} />
      );
    case "line-chart":
      return (
        <LineChartView node={node as LineChartSpec} pluginId={pluginId} />
      );
    case "heatmap":
      return (
        <HeatmapView node={node as HeatmapSpec} pluginId={pluginId} />
      );
    case "table":
      return (
        <TableView node={node as TableSpec} pluginId={pluginId} />
      );
    case "list":
      return <ListView node={node as ListSpec} pluginId={pluginId} />;
    case "progress":
      return <ProgressView node={node as ProgressSpec} />;
    case "button":
      return <ButtonView node={node as ButtonSpec} />;
    case "divider":
      return <Divider />;
    case "spacer":
      return <Spacer node={node as SpacerSpec} />;
    default: {
      warnOnce(
        pluginId,
        `unknown-type:${type}`,
        `unknown widget type "${type}" — rendering nothing`,
      );
      return null;
    }
  }
}

// ---- Widget implementations ------------------------------------------------

function ContainerView({
  node,
  pluginId,
  depth,
}: {
  node: ContainerSpec;
  pluginId: string;
  depth: number;
}) {
  const direction = node.direction === "row" ? "row" : "column";
  const gap = clampNumber(node.gap, 0, 64, 8);
  const padding = clampNumber(node.padding, 0, 32, 0);
  const style: CSSProperties = {
    display: "flex",
    flexDirection: direction,
    gap: `${gap}px`,
    padding: padding ? `${padding}px` : undefined,
    alignItems: alignToCss(node.align),
    justifyContent: justifyToCss(node.justify),
    minWidth: 0,
  };
  const children = truncateArray(node.children, pluginId, "container.children");
  return (
    <div style={style}>
      {children.map((child, idx) => (
        <Render
          key={idx}
          node={child}
          pluginId={pluginId}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

function alignToCss(a?: ContainerSpec["align"]): CSSProperties["alignItems"] {
  switch (a) {
    case "start":
      return "flex-start";
    case "center":
      return "center";
    case "end":
      return "flex-end";
    case "stretch":
      return "stretch";
    default:
      return undefined;
  }
}

function justifyToCss(
  j?: ContainerSpec["justify"],
): CSSProperties["justifyContent"] {
  switch (j) {
    case "start":
      return "flex-start";
    case "center":
      return "center";
    case "end":
      return "flex-end";
    case "between":
      return "space-between";
    default:
      return undefined;
  }
}

function TextView({ node }: { node: TextSpec }) {
  const value = truncateString(node.value);
  const style = node.style ?? "body";
  const styles: Record<TextStyle, CSSProperties> = {
    heading: {
      fontSize: 14,
      fontWeight: 600,
      color: "var(--text-bright)",
      letterSpacing: "0.04em",
      textTransform: "uppercase" as CSSProperties["textTransform"],
    },
    label: {
      fontSize: 10,
      color: "var(--text-muted)",
      textTransform: "uppercase" as CSSProperties["textTransform"],
      letterSpacing: "0.18em",
    },
    muted: {
      fontSize: 11,
      color: "var(--text-muted)",
    },
    accent: {
      fontSize: 12,
      color: "var(--accent)",
    },
    mono: {
      fontSize: 11,
      color: "var(--text-secondary)",
      fontVariantNumeric: "tabular-nums",
    },
    body: {
      fontSize: 12,
      color: "var(--text-primary)",
      lineHeight: 1.5,
    },
  };
  return <div style={styles[style] ?? styles.body}>{value}</div>;
}

function StatView({ node }: { node: StatWidgetSpec }) {
  const label = truncateString(node.label);
  const value =
    typeof node.value === "number" || typeof node.value === "string"
      ? String(node.value)
      : "—";
  const unit = node.unit ? truncateString(node.unit) : "";
  return (
    <div className="flex flex-col gap-[2px] py-1">
      <div
        className="text-[9px] uppercase tracking-[0.18em]"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </div>
      <div className="flex items-baseline gap-1">
        <span
          className="tabular-nums"
          style={{
            fontSize: 18,
            fontWeight: 500,
            color: "var(--text-bright)",
          }}
        >
          {truncateString(value, "—")}
        </span>
        {unit && (
          <span
            className="text-[10px] uppercase tracking-[0.14em]"
            style={{ color: "var(--text-secondary)" }}
          >
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}

function StatRowView({
  node,
  pluginId,
}: {
  node: StatRowSpec;
  pluginId: string;
}) {
  const stats = truncateArray(node.stats, pluginId, "stat-row.stats");
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2">
      {stats.map((s, idx) => (
        <StatView
          key={idx}
          node={{ type: "stat", ...s }}
        />
      ))}
    </div>
  );
}

function BarChartView({
  node,
  pluginId,
}: {
  node: BarChartSpec;
  pluginId: string;
}) {
  const colors = chartColors();
  const data = truncateArray(node.data, pluginId, "bar-chart.data").map(
    (d) => ({
      label: truncateString(d.label, ""),
      value: typeof d.value === "number" && Number.isFinite(d.value) ? d.value : 0,
    }),
  );
  const height = clampNumber(node.height, 80, 600, 200);
  if (data.length === 0) {
    return <EmptyChartHint label="no data" />;
  }
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data}>
          <CartesianGrid stroke={colors.border} strokeDasharray="2 4" />
          <XAxis
            dataKey="label"
            stroke={colors.muted}
            tick={{ fontSize: 10, fill: colors.muted }}
          />
          <YAxis
            stroke={colors.muted}
            tick={{ fontSize: 10, fill: colors.muted }}
          />
          <Tooltip
            cursor={{ fill: colors.borderFocus }}
            contentStyle={{
              background: colors.bgElevated,
              border: `1px solid ${colors.borderFocus}`,
              borderRadius: 0,
              fontSize: 11,
              color: colors.textBright,
            }}
            labelStyle={{ color: colors.muted }}
          />
          <Bar dataKey="value" fill={colors.accent} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function LineChartView({
  node,
  pluginId,
}: {
  node: LineChartSpec;
  pluginId: string;
}) {
  const colors = chartColors();
  const data = truncateArray(node.data, pluginId, "line-chart.data").map(
    (d) => ({
      label: truncateString(d.label, ""),
      value: typeof d.value === "number" && Number.isFinite(d.value) ? d.value : 0,
    }),
  );
  const height = clampNumber(node.height, 80, 600, 200);
  if (data.length === 0) {
    return <EmptyChartHint label="no data" />;
  }
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <CartesianGrid stroke={colors.border} strokeDasharray="2 4" />
          <XAxis
            dataKey="label"
            stroke={colors.muted}
            tick={{ fontSize: 10, fill: colors.muted }}
          />
          <YAxis
            stroke={colors.muted}
            tick={{ fontSize: 10, fill: colors.muted }}
          />
          <Tooltip
            cursor={{ stroke: colors.borderFocus }}
            contentStyle={{
              background: colors.bgElevated,
              border: `1px solid ${colors.borderFocus}`,
              borderRadius: 0,
              fontSize: 11,
              color: colors.textBright,
            }}
            labelStyle={{ color: colors.muted }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke={colors.accent}
            strokeWidth={1.5}
            dot={{ r: 2, fill: colors.accent }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function HeatmapView({
  node,
  pluginId,
}: {
  node: HeatmapSpec;
  pluginId: string;
}) {
  const data = truncateArray(node.data, pluginId, "heatmap.data");
  const max = data.reduce(
    (m, d) => (typeof d.value === "number" && d.value > m ? d.value : m),
    0,
  );
  if (data.length === 0) {
    return <EmptyChartHint label="no data" />;
  }
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(12px, 1fr))",
        gap: 2,
        maxWidth: 480,
      }}
    >
      {data.map((d, idx) => {
        const v = typeof d.value === "number" ? d.value : 0;
        const ratio = max > 0 ? Math.min(1, v / max) : 0;
        const bg = ramp(ratio);
        return (
          <div
            key={idx}
            title={`${truncateString(d.date)} · ${v}`}
            style={{
              width: "100%",
              aspectRatio: "1 / 1",
              background: bg,
              minWidth: 8,
              minHeight: 8,
            }}
          />
        );
      })}
    </div>
  );
}

function ramp(ratio: number): string {
  if (ratio <= 0) return "var(--bg-elevated)";
  if (ratio < 0.25) return "var(--accent-25)";
  if (ratio < 0.5) return "var(--accent-45)";
  if (ratio < 0.75) return "var(--accent-65)";
  return "var(--accent)";
}

function TableView({
  node,
  pluginId,
}: {
  node: TableSpec;
  pluginId: string;
}) {
  const columns = truncateArray(node.columns, pluginId, "table.columns").map(
    (c) => truncateString(c, ""),
  );
  const rows = truncateArray(node.rows, pluginId, "table.rows");
  return (
    <div className="overflow-x-auto">
      <table
        className="w-full text-[11px]"
        style={{
          borderCollapse: "collapse",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <thead>
          <tr>
            {columns.map((c, idx) => (
              <th
                key={idx}
                className="border-b border-[var(--border)] px-2 py-1 text-left text-[9px] uppercase tracking-[0.16em]"
                style={{ color: "var(--text-muted)" }}
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIdx) => {
            const cells = Array.isArray(row) ? row : [];
            return (
              <tr key={rowIdx}>
                {cells.slice(0, columns.length).map((cell, cellIdx) => (
                  <td
                    key={cellIdx}
                    className="border-b border-[var(--border-subtle)] px-2 py-1"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {typeof cell === "number"
                      ? String(cell)
                      : truncateString(cell as unknown as string, "")}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ListView({
  node,
  pluginId,
}: {
  node: ListSpec;
  pluginId: string;
}) {
  const items = truncateArray(node.items, pluginId, "list.items");
  return (
    <ul className="flex flex-col">
      {items.map((item, idx) => (
        <li
          key={idx}
          className="flex items-start gap-2 border-b border-[var(--border-subtle)] px-2 py-1 text-[11px]"
        >
          {item.icon && (
            <span
              aria-hidden
              className="shrink-0 text-[var(--text-muted)]"
              style={{ width: 14, lineHeight: "16px" }}
            >
              {truncateString(item.icon, "·")}
            </span>
          )}
          <div className="flex min-w-0 flex-col">
            <span
              className="truncate"
              style={{ color: "var(--text-primary)" }}
            >
              {truncateString(item.primary, "")}
            </span>
            {item.secondary && (
              <span
                className="truncate text-[10px]"
                style={{ color: "var(--text-muted)" }}
              >
                {truncateString(item.secondary, "")}
              </span>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function ProgressView({ node }: { node: ProgressSpec }) {
  const max =
    typeof node.max === "number" && node.max > 0 ? node.max : 1;
  const value =
    typeof node.value === "number" && node.value >= 0 ? node.value : 0;
  const ratio = Math.min(1, value / max);
  const label = node.label ? truncateString(node.label, "") : null;
  return (
    <div className="flex flex-col gap-1 py-1">
      {label && (
        <div className="flex items-baseline justify-between text-[10px]">
          <span style={{ color: "var(--text-muted)" }}>{label}</span>
          <span
            className="tabular-nums"
            style={{ color: "var(--text-secondary)" }}
          >
            {Math.round(ratio * 100)}%
          </span>
        </div>
      )}
      <div
        style={{
          height: 4,
          background: "var(--bg-elevated)",
          width: "100%",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.round(ratio * 100)}%`,
            background: "var(--accent)",
            transition: "width 200ms ease-out",
          }}
        />
      </div>
    </div>
  );
}

function ButtonView({ node }: { node: ButtonSpec }) {
  const label = truncateString(node.label, "button");
  const commandId = truncateString(node.commandId, "");
  const { executeCommand } = usePlugins();
  const onClick = () => {
    if (!commandId) return;
    void executeCommand(commandId, "plugin-view");
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-[3px] text-[10px] uppercase tracking-[0.18em] text-[var(--text-secondary)] transition-colors duration-100 ease-out hover:border-[var(--accent)] hover:text-[var(--accent)]"
    >
      [{label}]
    </button>
  );
}

function Divider() {
  return (
    <div
      className="my-1 w-full"
      style={{ height: 1, background: "var(--border)" }}
    />
  );
}

function Spacer({ node }: { node: SpacerSpec }) {
  const size = clampNumber(node.size, 0, 64, 8);
  return <div style={{ height: size, width: size }} />;
}

function EmptyChartHint({ label }: { label: string }) {
  return (
    <div
      className="px-2 py-3 text-[10px] uppercase tracking-[0.18em]"
      style={{ color: "var(--text-muted)" }}
    >
      # {label}
    </div>
  );
}

// ---- Helpers ---------------------------------------------------------------

function clampNumber(
  v: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, v));
}


// ReactNode export so the file is recognised as a module if any consumer
// imports React types separately.
export type { ReactNode };
