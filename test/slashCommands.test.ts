/**
 * Slash-command catalog + filtering tests — leading-slash handling, empty-input
 * listing, name/alias/description matching, prefix-before-substring ranking,
 * and unrecognized input.
 */

import { describe, expect, it } from 'vitest';
import { SLASH_COMMANDS, filterCommands } from '../src/webview/slashCommands';

const names = (cmds: { name: string }[]) => cmds.map((c) => c.name);

describe('SLASH_COMMANDS catalog', () => {
  it('ships the documented commands, each with a description', () => {
    for (const n of ['clear', 'model', 'solo', 'coop', 'diff', 'fork', 'export', 'settings', 'history', 'status', 'skills']) {
      expect(names(SLASH_COMMANDS)).toContain(n);
    }
    for (const c of SLASH_COMMANDS) {
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  it('marks the second-level pickers as submenus and /status as status', () => {
    const byName = Object.fromEntries(SLASH_COMMANDS.map((c) => [c.name, c]));
    expect(byName.model.kind).toBe('submenu');
    expect(byName.export.kind).toBe('submenu');
    expect(byName.skills.kind).toBe('submenu');
    expect(byName.status.kind).toBe('status');
    expect(byName.clear.kind).toBe('action');
  });
});

describe('filterCommands', () => {
  it('returns nothing when the input does not start with a slash', () => {
    expect(filterCommands('')).toEqual([]);
    expect(filterCommands('model')).toEqual([]);
    expect(filterCommands('hello /model')).toEqual([]);
  });

  it('lists every command, in catalog order, for a bare slash', () => {
    expect(names(filterCommands('/'))).toEqual(names(SLASH_COMMANDS));
  });

  it('filters by name prefix, ranking the prefix match first', () => {
    // 'mod' is also a substring of "...mode" in several descriptions, but the
    // /model name-prefix hit must rank first.
    expect(names(filterCommands('/mod'))[0]).toBe('model');
    // 'sk' is unique to /skills.
    expect(names(filterCommands('/sk'))).toEqual(['skills']);
  });

  it('is case-insensitive', () => {
    expect(names(filterCommands('/MODEL'))[0]).toBe('model');
  });

  it('matches aliases, ranking the alias match first', () => {
    // /new is an alias of /clear; /review is an alias of /diff.
    expect(names(filterCommands('/new'))[0]).toBe('clear');
    expect(names(filterCommands('/review'))[0]).toBe('diff');
  });

  it('matches on the description as a substring', () => {
    // "pipeline" only appears in the /coop description.
    expect(names(filterCommands('/pipeline'))).toContain('coop');
    // "past conversations" is only in /history's description.
    expect(names(filterCommands('/past'))).toContain('history');
  });

  it('ranks prefix matches before substring/description matches', () => {
    // "s" is a prefix of solo/settings/status/skills, but also appears inside
    // other names/descriptions — the prefix matches must come first.
    const result = names(filterCommands('/s'));
    const prefixed = ['solo', 'settings', 'status', 'skills'];
    const firstFour = result.slice(0, prefixed.length);
    expect(new Set(firstFour)).toEqual(new Set(prefixed));
    // and prefix hits precede any pure description hit.
    for (const p of prefixed) {
      expect(result.indexOf(p)).toBeLessThan(prefixed.length);
    }
  });

  it('keeps catalog order among equally-ranked matches', () => {
    // All four are name-prefix matches on "s"; catalog order is
    // solo, settings, status, skills.
    expect(names(filterCommands('/s')).slice(0, 4)).toEqual(['solo', 'settings', 'status', 'skills']);
  });

  it('returns empty for an unrecognized command', () => {
    expect(filterCommands('/zzzznope')).toEqual([]);
  });

  it('tolerates surrounding whitespace in the query', () => {
    expect(names(filterCommands('/  model '))[0]).toBe('model');
  });
});
