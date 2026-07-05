import { describe, expect, it } from 'vitest';

import { StreamSanitizer } from '../src/core/providers/streamSanitizer';
import type { SanitizedPart } from '../src/core/providers/streamSanitizer';

// --- helpers ---------------------------------------------------------------

/** Feed each delta through a fresh sanitizer, then flush; return all parts. */
function run(deltas: string[]): SanitizedPart[] {
  const s = new StreamSanitizer();
  const parts: SanitizedPart[] = [];
  for (const d of deltas) parts.push(...s.pushText(d));
  parts.push(...s.flush());
  return parts;
}

const textOf = (parts: SanitizedPart[]) =>
  parts.filter((p) => p.kind === 'text').map((p) => p.delta).join('');
const thinkingOf = (parts: SanitizedPart[]) =>
  parts.filter((p) => p.kind === 'thinking').map((p) => p.delta).join('');
/** Concatenation of every part's delta, in order (nothing dropped except markers). */
const allOf = (parts: SanitizedPart[]) => parts.map((p) => p.delta).join('');

// --- Harmony channels ------------------------------------------------------

describe('StreamSanitizer — harmony channels', () => {
  it('routes a named thinking channel to thinking and strips the markers', () => {
    const parts = run(['before <|channel|>analysis reasoning here<|end|> after']);
    expect(textOf(parts)).toBe('before  after');
    expect(thinkingOf(parts)).toBe(' reasoning here');
    expect(allOf(parts)).not.toContain('<|');
  });

  it('strips the exact leaked field fragment `<|channel|>thought <|channel|>`', () => {
    const parts = run(['<|channel|>thought <|channel|>']);
    // Every marker char is gone; nothing resembling a control token leaks.
    expect(allOf(parts)).not.toContain('<|');
    expect(allOf(parts)).not.toContain('channel');
    // The trailing bare channel switched the mode back to text, so following
    // content led by a non-letter delimiter renders as ordinary visible text.
    const s = new StreamSanitizer();
    s.pushText('<|channel|>thought <|channel|>');
    const after = [...s.pushText('\nvisible'), ...s.flush()];
    expect(textOf(after)).toBe('\nvisible');
  });

  it('treats a bare/unknown channel name as a switch back to text', () => {
    const parts = run(['<|channel|>thinking secret<|channel|>weird now visible']);
    // `weird` is not a reasoning channel → back to text.
    expect(thinkingOf(parts)).toBe(' secret');
    expect(textOf(parts)).toBe(' now visible');
  });

  it('honors channel terminators: final, message, end', () => {
    // final
    let parts = run(['<|channel|>thought hidden<|channel|>final shown']);
    expect(thinkingOf(parts)).toBe(' hidden');
    expect(textOf(parts)).toBe(' shown');

    // message
    parts = run(['<|channel|>reflection musing<|message|>answer']);
    expect(thinkingOf(parts)).toBe(' musing');
    expect(textOf(parts)).toBe('answer');

    // end
    parts = run(['<|channel|>thinking musing<|end|>answer']);
    expect(thinkingOf(parts)).toBe(' musing');
    expect(textOf(parts)).toBe('answer');
  });
});

// --- Inline think tags -----------------------------------------------------

describe('StreamSanitizer — think tags', () => {
  it('routes a think-tag pair inside one delta to thinking, tags stripped', () => {
    const parts = run(['a<think>secret</think>b']);
    expect(textOf(parts)).toBe('ab');
    expect(thinkingOf(parts)).toBe('secret');
    expect(allOf(parts)).not.toContain('<think');
  });

  it('handles the <thinking> long form too', () => {
    const parts = run(['x<thinking>deep</thinking>y']);
    expect(textOf(parts)).toBe('xy');
    expect(thinkingOf(parts)).toBe('deep');
  });

  it('recognizes a think tag split across three deltas mid-tag', () => {
    const parts = run(['before<th', 'ink>inner th', 'oughts</thi', 'nk>after']);
    expect(textOf(parts)).toBe('beforeafter');
    expect(thinkingOf(parts)).toBe('inner thoughts');
  });

  it('keeps everything after an unclosed think tag as thinking through flush', () => {
    const parts = run(['visible<think>dangling reasoning with no close']);
    expect(textOf(parts)).toBe('visible');
    expect(thinkingOf(parts)).toBe('dangling reasoning with no close');
  });
});

// --- Orphan control tokens -------------------------------------------------

describe('StreamSanitizer — orphan tokens', () => {
  it('strips standalone control tokens from text', () => {
    const parts = run(['<|im_start|>hello<|im_end|> world<|endoftext|>!']);
    expect(textOf(parts)).toBe('hello world!');
    expect(allOf(parts)).not.toContain('<|');
  });

  it('strips orphan tokens without altering the surrounding mode', () => {
    const parts = run(['<think>a<|constrain|>b</think>c']);
    expect(thinkingOf(parts)).toBe('ab');
    expect(textOf(parts)).toBe('c');
  });
});

// --- Clean passthrough -----------------------------------------------------

describe('StreamSanitizer — clean passthrough', () => {
  it('passes marker-free text through byte-identical (concatenated, in order)', () => {
    const input = 'The quick brown fox.\nSecond line with punctuation: 1 < 2 && 3 > 2.';
    const parts = run([input]);
    expect(textOf(parts)).toBe(input);
    expect(parts.every((p) => p.kind === 'text')).toBe(true);
  });

  it('flushes `<div>` HTML immediately within the same push (not held back)', () => {
    const s = new StreamSanitizer();
    // `<div>` is not a marker prefix beyond the leading `<`, so a single push
    // yields it whole with nothing held back for flush.
    const emitted = s.pushText('a<div class="x">b</div>c');
    expect(textOf(emitted)).toBe('a<div class="x">b</div>c');
    expect(s.flush()).toEqual([]);
  });

  it('emits a mid-line lone `<` immediately; only a trailing `<` is briefly held', () => {
    const mid = new StreamSanitizer();
    expect(textOf(mid.pushText('3 < 5 is true'))).toBe('3 < 5 is true');

    const trailing = new StreamSanitizer();
    const first = trailing.pushText('value <'); // trailing '<' could start a marker
    expect(textOf(first)).toBe('value '); // held back the '<'
    expect(textOf(trailing.flush())).toBe('<'); // released verbatim on flush
  });

  it('preserves byte-identical text across arbitrary delta splits of clean input', () => {
    const input = 'plain text <div> and 2<3 and a</span> tail';
    for (let i = 0; i <= input.length; i++) {
      const parts = run([input.slice(0, i), input.slice(i)]);
      expect(textOf(parts)).toBe(input);
    }
  });
});

// --- Chunk-boundary safety -------------------------------------------------

describe('StreamSanitizer — chunk-boundary safety', () => {
  it('recognizes `<|channel|>` split at every possible boundary position', () => {
    // Reasoning between markers must always land in thinking, visible text intact,
    // no matter where the two-delta split falls.
    const full = 'before<|channel|>thought more<|end|>after';
    for (let i = 0; i <= full.length; i++) {
      const parts = run([full.slice(0, i), full.slice(i)]);
      expect(textOf(parts)).toBe('beforeafter');
      expect(thinkingOf(parts)).toBe(' more');
      expect(allOf(parts)).not.toContain('<|');
    }
  });

  it('recognizes an orphan token split at every boundary position', () => {
    const full = 'x<|im_end|>y';
    for (let i = 0; i <= full.length; i++) {
      const parts = run([full.slice(0, i), full.slice(i)]);
      expect(textOf(parts)).toBe('xy');
      expect(allOf(parts)).not.toContain('<|');
    }
  });

  it('holds a split channel name until the remaining letters arrive', () => {
    // `<|channel|>tho` must not be misread as channel name "tho" (→ text); the
    // rest of "thought" arrives next and correctly opens thinking.
    const parts = run(['<|channel|>tho', 'ught hidden<|end|>shown']);
    expect(thinkingOf(parts)).toBe(' hidden');
    expect(textOf(parts)).toBe('shown');
  });
});
