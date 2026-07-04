/**
 * Slash-command catalog + pure filtering/matching logic for the chat composer.
 *
 * Dependency-free (no Preact, no store) so it stays unit-testable. The Preact
 * <SlashMenu> / Composer consume this module to render the popup and dispatch
 * the actual actions; nothing here touches the DOM or the protocol.
 */

/**
 * How a command behaves once chosen:
 *  - 'action'  → run an action immediately, then clear + close the composer.
 *  - 'submenu' → open a second-level picker in the same popup (model/export/skills).
 *  - 'status'  → render an ephemeral local status card; no host round-trip.
 */
export type SlashCommandKind = 'action' | 'submenu' | 'status';

export interface SlashCommand {
  /** Canonical name, without the leading slash (e.g. "clear"). */
  name: string;
  /** Alternate names, without the leading slash (e.g. ["new"]). */
  aliases: string[];
  /** One-line description shown dimmed on the right of the row. */
  description: string;
  kind: SlashCommandKind;
}

/** The full command catalog, in display order. */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'clear', aliases: ['new'], description: 'Start a new conversation', kind: 'action' },
  { name: 'model', aliases: [], description: 'Switch the active model', kind: 'submenu' },
  { name: 'solo', aliases: [], description: 'Direct single-agent mode', kind: 'action' },
  { name: 'coop', aliases: [], description: 'Cooperative pipeline mode', kind: 'action' },
  { name: 'diff', aliases: ['review'], description: 'Review staged changes', kind: 'action' },
  { name: 'fork', aliases: [], description: 'Fork this conversation into a new tab', kind: 'action' },
  { name: 'export', aliases: [], description: 'Copy conversation as Markdown or JSON', kind: 'submenu' },
  { name: 'settings', aliases: [], description: 'Open settings', kind: 'action' },
  { name: 'history', aliases: [], description: 'Browse past conversations', kind: 'action' },
  {
    name: 'status',
    aliases: [],
    description: 'Show session status: model, mode, context usage, tokens',
    kind: 'status',
  },
  { name: 'skills', aliases: [], description: 'Use a skill', kind: 'submenu' },
];

/**
 * Rank of a command against a lowercased query. Lower is better; `null` = no match.
 *   0 = name/alias starts with the query (prefix)
 *   1 = name/alias contains the query (substring)
 *   2 = description contains the query (substring)
 */
function matchRank(cmd: SlashCommand, query: string): number | null {
  const names = [cmd.name, ...cmd.aliases].map((n) => n.toLowerCase());
  if (names.some((n) => n.startsWith(query))) return 0;
  if (names.some((n) => n.includes(query))) return 1;
  if (cmd.description.toLowerCase().includes(query)) return 2;
  return null;
}

/**
 * Filter the command catalog for the current composer input.
 *
 * - Input must begin with '/' (the composer only opens the menu on a leading
 *   slash); anything else returns [].
 * - An empty query (just '/') lists every command in catalog order.
 * - Matching is case-insensitive against name, aliases, and description.
 * - Results are ranked: prefix matches first, then name/alias substrings, then
 *   description substrings; ties keep catalog order (stable).
 * - Input that starts with '/' but matches nothing returns [] (the composer
 *   then sends it as an ordinary prompt).
 */
export function filterCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return [];
  const query = input.slice(1).trim().toLowerCase();
  if (query === '') return [...SLASH_COMMANDS];
  return SLASH_COMMANDS
    .map((cmd, index) => ({ cmd, index, rank: matchRank(cmd, query) }))
    .filter((e): e is { cmd: SlashCommand; index: number; rank: number } => e.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((e) => e.cmd);
}
