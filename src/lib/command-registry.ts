/**
 * Command registry — every action in Flint is a named, searchable command.
 *
 * Plugins register commands via `flint.registerCommand()`. The core app
 * registers its own commands at startup (core:start-session, etc). The
 * command palette (Ctrl+P) runs fuzzy search over the registry and executes
 * selected commands, firing a `command:execute` hook as it goes.
 */

export interface FlintCommand {
  /** Format: `plugin_id:action_name` (e.g. `pomodoro:skip-interval`). */
  id: string;
  /** Display name shown in the palette. */
  name: string;
  /** Called when the command is executed. Runs inside safeCallPlugin. */
  callback: () => void | Promise<void>;
  /** Optional unicode icon prefix (consistent with Flint's terminal aesthetic). */
  icon?: string;
  /** Optional default hotkey (informational — palette renders a badge). */
  hotkey?: string;
  /** Optional grouping label shown in the palette. */
  category?: string;
}

export interface RegisteredCommand extends FlintCommand {
  /** Who registered this command — used for auto-cleanup on plugin unload. */
  owner: string;
}

/**
 * Lightweight fuzzy scorer. Consecutive character matches score higher,
 * matches at word boundaries score higher, prefix matches get a big bonus.
 * No external dep needed — the registry is small (dozens, not thousands).
 *
 * Returns `null` if the query cannot be matched at all, or a positive
 * number where larger = better.
 */
export function scoreCommand(
  query: string,
  command: FlintCommand,
): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const name = command.name.toLowerCase();
  const id = command.id.toLowerCase();
  const category = command.category?.toLowerCase() ?? "";

  const nameScore = fuzzyScore(q, name);
  const idScore = fuzzyScore(q, id);
  const catScore = category ? fuzzyScore(q, category) : null;

  const best = [nameScore, idScore, catScore].reduce<number | null>(
    (acc, s) => {
      if (s == null) return acc;
      if (acc == null) return s;
      return Math.max(acc, s);
    },
    null,
  );
  return best;
}

function fuzzyScore(query: string, target: string): number | null {
  if (target.includes(query)) {
    const idx = target.indexOf(query);
    let score = 1000 - idx;
    if (idx === 0) score += 500;
    if (idx > 0 && !/[a-z0-9]/.test(target[idx - 1])) score += 200;
    return score;
  }

  let ti = 0;
  let qi = 0;
  let score = 0;
  let consecutive = 0;
  let lastMatchIdx = -2;

  while (qi < query.length && ti < target.length) {
    if (query[qi] === target[ti]) {
      if (ti === lastMatchIdx + 1) {
        consecutive += 1;
        score += 10 + consecutive * 5;
      } else {
        consecutive = 0;
        score += 5;
      }
      if (ti === 0 || !/[a-z0-9]/.test(target[ti - 1])) score += 8;
      lastMatchIdx = ti;
      qi += 1;
    }
    ti += 1;
  }

  return qi === query.length ? score : null;
}

/**
 * Rank every command by score, ties broken by MRU recency, then by name.
 * Commands that don't match the query at all are filtered out unless the
 * query is empty — then we return everything, MRU-first.
 */
export function searchCommands(
  query: string,
  commands: RegisteredCommand[],
  mru: Map<string, number>,
): RegisteredCommand[] {
  if (!query) {
    return [...commands].sort((a, b) => {
      const am = mru.get(a.id) ?? 0;
      const bm = mru.get(b.id) ?? 0;
      if (am !== bm) return bm - am;
      return a.name.localeCompare(b.name);
    });
  }

  const scored: Array<{ cmd: RegisteredCommand; score: number }> = [];
  for (const cmd of commands) {
    const s = scoreCommand(query, cmd);
    if (s == null) continue;
    const mruBonus = (mru.get(cmd.id) ?? 0) > 0 ? 100 : 0;
    scored.push({ cmd, score: s + mruBonus });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    return a.cmd.name.localeCompare(b.cmd.name);
  });
  return scored.map((s) => s.cmd);
}
