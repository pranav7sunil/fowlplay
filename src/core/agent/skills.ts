/**
 * Skills — reusable, model-invoked instruction docs.
 *
 * A skill is a markdown file (bundled with FowlPlay or dropped into a workspace
 * under `.fowlplay/skills/*.md`). Skills are LAZY: only their name + one-line
 * description are ever injected into a system prompt (see {@link formatSkillCatalog}).
 * The model loads a skill's full body on demand via the `load_skill` tool — which
 * keeps FowlPlay's context-GC philosophy intact (no always-on instruction dump).
 *
 * Pure TypeScript — no `vscode`, no filesystem. The extension discovers the raw
 * markdown and calls {@link parseSkill}; this module never touches disk.
 */

import type { Skill, SkillMeta } from '../../shared/types';

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a skill from its filename + raw markdown.
 *
 *  - name:        YAML frontmatter `name:` → first `# heading` → filename (sans path/ext)
 *  - description: YAML frontmatter `description:` → first non-heading, non-empty body line
 *  - body:        the markdown with any leading frontmatter stripped
 */
export function parseSkill(filename: string, raw: string): Skill {
  const { frontmatter, body } = splitFrontmatter(raw ?? '');

  const fmName = frontmatter.name?.trim();
  const fmDesc = frontmatter.description?.trim();

  const baseName = filename
    .replace(/\\/g, '/')
    .replace(/^.*\//, '')
    .replace(/\.md$/i, '')
    .trim();

  const name = firstNonEmpty(fmName, firstHeading(body), baseName) || 'skill';
  const description = firstNonEmpty(fmDesc, firstNonHeadingLine(body)) || '';

  return { name, description, body: body.trim() };
}

/** Split a leading `---` frontmatter block (if any). Values are trimmed + de-quoted. */
function splitFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const text = raw.replace(/^﻿/, '');
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
  if (!m) return { frontmatter: {}, body: text };

  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key) fm[key] = value;
  }
  return { frontmatter: fm, body: text.slice(m[0].length) };
}

function firstHeading(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line.trim());
    if (m) return m[1].trim();
  }
  return undefined;
}

function firstNonHeadingLine(body: string): string | undefined {
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    return t;
  }
  return undefined;
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const v of values) if (v && v.trim()) return v.trim();
  return undefined;
}

// ---------------------------------------------------------------------------
// Catalog formatting
// ---------------------------------------------------------------------------

/**
 * Format a compact catalog block for injection into a system prompt: one line per
 * skill (name + description) plus an instruction to call `load_skill` before relying
 * on a skill. Returns an empty string when there are no skills (so callers can
 * inject unconditionally without leaking an empty header).
 */
export function formatSkillCatalog(metas: SkillMeta[]): string {
  if (metas.length === 0) return '';
  const lines = metas.map((m) => (m.description ? `- ${m.name}: ${m.description}` : `- ${m.name}`));
  return `AVAILABLE SKILLS
Reusable instruction docs are available but NOT yet loaded. When a task matches one,
call the \`load_skill\` tool with its exact name to load the full instructions BEFORE you
rely on it — do not guess a skill's contents.

${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// Bundled default skills
// ---------------------------------------------------------------------------

const COMMIT_MESSAGE_SKILL = `---
name: commit-message
description: Write a clear, conventional commit message for a staged changeset.
---

# Commit message

Write a single-line commit subject that describes the *intent* of the change, then an
optional body for the *why*.

- Subject: imperative mood, <= 72 chars, no trailing period (e.g. "Add retry to fetch").
- Prefer a Conventional Commits type prefix when it fits: \`feat:\`, \`fix:\`, \`refactor:\`,
  \`test:\`, \`docs:\`, \`chore:\`. Add a scope in parentheses when it clarifies (e.g.
  \`fix(auth): reject expired tokens\`).
- Body (optional, wrapped at ~72 cols): explain *why* the change was made and any
  consequences a reviewer should know. Skip it for trivial changes.
- Describe what the diff actually does — never invent changes that are not staged.`;

const TEST_WRITING_SKILL = `---
name: test-writing
description: Write focused, deterministic tests that pin the behavior a change introduces.
---

# Test writing

Add tests that would fail before the change and pass after it.

- Cover the behavior the acceptance criteria describe, not the implementation details.
- One clear assertion of intent per test; name the test after the behavior it proves.
- Include the important edge cases: empty input, error/failure paths, and boundaries.
- Keep tests deterministic — no real network, clock, or filesystem unless injected/faked;
  match the surrounding suite's framework and style rather than introducing a new one.
- Prefer small, readable fixtures over large opaque ones.`;

/** Raw markdown for each bundled skill, keyed by a synthetic filename. */
export const BUNDLED_SKILL_SOURCES: Record<string, string> = {
  'commit-message.md': COMMIT_MESSAGE_SKILL,
  'test-writing.md': TEST_WRITING_SKILL,
};

/**
 * Parsed bundled skills, so the feature is demoable with zero workspace setup.
 * Workspace skills (`.fowlplay/skills/*.md`) override these by name.
 */
export const BUNDLED_SKILLS: Skill[] = Object.entries(BUNDLED_SKILL_SOURCES).map(([file, raw]) =>
  parseSkill(file, raw),
);
