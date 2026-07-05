/**
 * Unit tests for deterministic file-reference extraction/expansion (src/core/agent/fileMentions).
 * Pure module — no host, no fs — so these pin the detection grammar and the fencing.
 */

import { describe, expect, it } from 'vitest';
import {
  capFileContent,
  expandFileMentions,
  extractFileMentions,
  FILE_TRUNCATION_MARKER,
} from '../src/core/agent/fileMentions';

describe('extractFileMentions — explicit @ mentions', () => {
  it('captures @<path> tokens and strips the marker', () => {
    const { explicit } = extractFileMentions('please read @src/auth/login.ts and @notes.md');
    expect(explicit).toEqual(['src/auth/login.ts', 'notes.md']);
  });

  it('requires a . or / in the path (bare @word is not a file)', () => {
    const { explicit } = extractFileMentions('@here @team look at @docs/spec.md');
    expect(explicit).toEqual(['docs/spec.md']);
  });

  it('strips trailing sentence punctuation from the capture', () => {
    const { explicit } = extractFileMentions('open @auraringprd.md.');
    expect(explicit).toEqual(['auraringprd.md']);
  });

  it('does not fire on an email address mid-token', () => {
    const { explicit, bare } = extractFileMentions('mail me at pranav@example.com about it');
    expect(explicit).toEqual([]);
    // "pranav@example.com" contains '@' so it is not a bare candidate either.
    expect(bare).toEqual([]);
  });

  it('dedupes explicit mentions, preserving first-seen order', () => {
    const { explicit } = extractFileMentions('@a.md then @b.ts then @a.md again');
    expect(explicit).toEqual(['a.md', 'b.ts']);
  });
});

describe('extractFileMentions — bare detection positives', () => {
  it('detects a bare filename with a known text extension', () => {
    expect(extractFileMentions('implement auraringprd.md').bare).toEqual(['auraringprd.md']);
  });

  it('detects a slash path even without an extension', () => {
    expect(extractFileMentions('look in src/foo.ts and lib/util').bare).toEqual(['src/foo.ts', 'lib/util']);
  });

  it('detects an uppercase doc path', () => {
    expect(extractFileMentions('see docs/USER_MANUAL.md for details').bare).toEqual(['docs/USER_MANUAL.md']);
  });
});

describe('extractFileMentions — bare detection negatives', () => {
  it('does not match a plain decimal number', () => {
    expect(extractFileMentions('bump to 3.6 today').bare).toEqual([]);
  });

  it('does not match a semver-ish version', () => {
    expect(extractFileMentions('upgrade to v1.2.3 please').bare).toEqual([]);
  });

  it('does not match a model name with a dot but no known extension', () => {
    expect(extractFileMentions('run Qwen3.6-35B-MoE on it').bare).toEqual([]);
  });

  it('does not match a URL (scheme skipped even though it ends in .md)', () => {
    expect(extractFileMentions('fetch https://x.com/a.md now').bare).toEqual([]);
  });

  it('does not match "e.g." prose abbreviations', () => {
    expect(extractFileMentions('e.g. do the thing').bare).toEqual([]);
  });

  it('excludes a bare token that is already an explicit mention', () => {
    const { explicit, bare } = extractFileMentions('@foo.md and foo.md');
    expect(explicit).toEqual(['foo.md']);
    expect(bare).toEqual([]);
  });
});

describe('expandFileMentions — backtick-safe fencing', () => {
  it('appends a labelled fenced block per file', () => {
    const out = expandFileMentions('do it', [{ path: 'a.md', content: 'hello' }]);
    expect(out).toContain('do it');
    expect(out).toContain('Referenced file a.md:');
    expect(out).toContain('```\nhello\n```');
  });

  it('content containing ``` cannot break out of the fence', () => {
    const content = 'text\n```ts\nconst x = 1;\n```\nmore';
    const out = expandFileMentions('please', [{ path: 'r.md', content }]);
    // The wrapper fence must be longer than the inner triple-fence.
    expect(out).toContain('````');
    const first = out.indexOf('````');
    const last = out.lastIndexOf('````');
    expect(last).toBeGreaterThan(first);
    // The inner triple-fence and the file body sit between the outer 4-backtick runs.
    expect(out.slice(first, last)).toContain('```ts');
    expect(out.slice(first, last)).toContain('const x = 1;');
  });

  it('returns the text unchanged when there are no files', () => {
    expect(expandFileMentions('nothing here', [])).toBe('nothing here');
  });
});

describe('capFileContent', () => {
  it('leaves content under the cap untouched', () => {
    const r = capFileContent('short', 100);
    expect(r).toEqual({ content: 'short', truncated: false });
  });

  it('truncates to the head plus a marker when over the cap', () => {
    const r = capFileContent('x'.repeat(50), 10);
    expect(r.truncated).toBe(true);
    expect(r.content.startsWith('x'.repeat(10))).toBe(true);
    expect(r.content).toContain(FILE_TRUNCATION_MARKER.trim());
    expect(r.content).not.toContain('x'.repeat(11));
  });
});
