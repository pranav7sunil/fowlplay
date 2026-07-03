/**
 * Skills registry tests — parsing (frontmatter / heading / filename fallbacks,
 * description extraction) and catalog formatting.
 */

import { describe, expect, it } from 'vitest';
import {
  BUNDLED_SKILLS,
  formatSkillCatalog,
  parseSkill,
} from '../src/core/agent/skills';

describe('parseSkill', () => {
  it('reads name + description from YAML frontmatter and strips it from the body', () => {
    const raw = `---
name: commit-message
description: Write a good commit message.
---

# Heading in body

Do the thing.`;
    const skill = parseSkill('whatever.md', raw);
    expect(skill.name).toBe('commit-message');
    expect(skill.description).toBe('Write a good commit message.');
    expect(skill.body.startsWith('# Heading in body')).toBe(true);
    expect(skill.body).not.toContain('name:');
  });

  it('de-quotes frontmatter values', () => {
    const raw = `---
name: "quoted-name"
description: 'single quoted'
---
body`;
    const skill = parseSkill('f.md', raw);
    expect(skill.name).toBe('quoted-name');
    expect(skill.description).toBe('single quoted');
  });

  it('falls back to the first heading for the name when no frontmatter', () => {
    const raw = `# My Skill Title

Some intro line describing it.`;
    const skill = parseSkill('some-file.md', raw);
    expect(skill.name).toBe('My Skill Title');
    // Description comes from the first non-heading, non-empty line.
    expect(skill.description).toBe('Some intro line describing it.');
  });

  it('falls back to the filename (sans path + .md) when there is no heading', () => {
    const skill = parseSkill('src/skills/my-cool-skill.md', 'just prose, no heading here');
    expect(skill.name).toBe('my-cool-skill');
    expect(skill.description).toBe('just prose, no heading here');
  });

  it('extracts the description from the first non-heading line, skipping headings', () => {
    const raw = `# Title
## Subtitle

The real description sentence.`;
    const skill = parseSkill('x.md', raw);
    expect(skill.name).toBe('Title');
    expect(skill.description).toBe('The real description sentence.');
  });

  it('tolerates an empty description', () => {
    const skill = parseSkill('empty.md', '# Only A Heading');
    expect(skill.name).toBe('Only A Heading');
    expect(skill.description).toBe('');
  });
});

describe('formatSkillCatalog', () => {
  it('returns an empty string when there are no skills', () => {
    expect(formatSkillCatalog([])).toBe('');
  });

  it('lists each skill and instructs the model to call load_skill', () => {
    const out = formatSkillCatalog([
      { name: 'a', description: 'does a' },
      { name: 'b', description: 'does b' },
    ]);
    expect(out).toContain('load_skill');
    expect(out).toContain('- a: does a');
    expect(out).toContain('- b: does b');
  });
});

describe('bundled skills', () => {
  it('ship at least commit-message and test-writing, each with a description and body', () => {
    const names = BUNDLED_SKILLS.map((s) => s.name);
    expect(names).toContain('commit-message');
    expect(names).toContain('test-writing');
    for (const s of BUNDLED_SKILLS) {
      expect(s.description.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(0);
    }
  });
});
