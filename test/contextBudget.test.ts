/**
 * Context-budget unit tests — the pure token estimator, diff fitting, and wire
 * history trimming that back FowlPlay's hard context-window management.
 */

import { describe, expect, it } from 'vitest';
import type { WireMessage } from '../src/core/providers/adapter';
import {
  estimateTokens,
  fitDiffToBudget,
  trimWireToBudget,
  wireTokens,
  WIRE_TRIM_NOTE,
} from '../src/core/agent/contextBudget';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A file block with `n` hunks; `pad` pads each changed line to grow its size. */
function fileBlock(name: string, hunks: number, pad = 0): string {
  const lines = [`--- a/${name}`, `+++ b/${name}`];
  const filler = 'x'.repeat(pad);
  for (let h = 0; h < hunks; h += 1) {
    lines.push(`@@ -${h * 10 + 1},1 +${h * 10 + 1},1 @@`);
    lines.push(`-old ${h} ${filler}`);
    lines.push(`+new ${h} ${filler}`);
  }
  return lines.join('\n');
}

function countHunks(text: string): number {
  return text.split('\n').filter((l) => l.startsWith('@@')).length;
}

const u = (text: string): WireMessage => ({ role: 'user', content: [{ type: 'text', text }] });
const a = (text: string): WireMessage => ({ role: 'assistant', content: [{ type: 'text', text }] });
const noteMsg: WireMessage = { role: 'user', content: [{ type: 'text', text: WIRE_TRIM_NOTE }] };

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe('estimateTokens', () => {
  it('is chars/4, rounded up, cheap', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2); // ceil(5/4)
    expect(estimateTokens('x'.repeat(400))).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// fitDiffToBudget
// ---------------------------------------------------------------------------

describe('fitDiffToBudget', () => {
  it('passes a fitting diff through as a single, unchanged chunk', () => {
    const diff = '--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b';
    const r = fitDiffToBudget(diff, 10_000);
    expect(r.chunks).toEqual([diff]);
    expect(r.truncated).toBe(false);
  });

  it('passes an empty diff through as a single chunk', () => {
    expect(fitDiffToBudget('', 100)).toEqual({ chunks: [''], truncated: false });
  });

  it('packs whole files at file boundaries into as few chunks as fit', () => {
    const f1 = fileBlock('f1.ts', 1);
    const f2 = fileBlock('f2.ts', 1);
    const f3 = fileBlock('f3.ts', 1);
    const diff = [f1, f2, f3].join('\n');
    // A budget that holds two files together but not all three.
    const budget = estimateTokens(`${f1}\n${f2}`);

    const r = fitDiffToBudget(diff, budget);
    expect(r.truncated).toBe(false);
    expect(r.chunks).toEqual([`${f1}\n${f2}`, f3]);
    // Every chunk starts at a real file boundary and fits the budget.
    for (const c of r.chunks) {
      expect(c.startsWith('--- a/')).toBe(true);
      expect(estimateTokens(c)).toBeLessThanOrEqual(budget);
    }
  });

  it('truncates a single oversized file, keeping leading hunks + a marker', () => {
    const big = fileBlock('big.ts', 10, 40);
    const budget = estimateTokens(fileBlock('big.ts', 3, 40));

    const r = fitDiffToBudget(big, budget);
    expect(r.truncated).toBe(true);
    expect(r.chunks).toHaveLength(1);
    expect(r.chunks[0]).toContain('more hunk(s) not shown');
    // Some but not all hunks survive.
    const kept = countHunks(r.chunks[0]);
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(10);
  });

  it('caps at 4 chunks and folds the overflow into the last chunk’s marker', () => {
    const files = Array.from({ length: 6 }, (_, i) => fileBlock(`f${i}.ts`, 1, 30));
    const diff = files.join('\n');
    // A budget that holds exactly one file per chunk → 6 chunks before the cap.
    const budget = estimateTokens(files[0]);

    const r = fitDiffToBudget(diff, budget);
    expect(r.chunks).toHaveLength(4);
    expect(r.truncated).toBe(true);
    expect(r.chunks[3]).toContain('more hunk(s) not shown');
    // The two overflow files (1 hunk each) are reported in the marker.
    expect(r.chunks[3]).toContain('2 more hunk(s)');
  });
});

// ---------------------------------------------------------------------------
// trimWireToBudget
// ---------------------------------------------------------------------------

describe('trimWireToBudget', () => {
  const P = 'x'.repeat(400); // ~100 tokens of padding per message

  it('returns empty / fitting histories untouched with dropped 0', () => {
    expect(trimWireToBudget([], 100)).toEqual({ messages: [], dropped: 0 });
    const small = [u('hi'), a('hello there')];
    expect(trimWireToBudget(small, 10_000)).toEqual({ messages: small, dropped: 0 });
  });

  it('drops the oldest whole turn first and prepends the synthetic note once', () => {
    const msgs = [u(`u1${P}`), a(`a1${P}`), u(`u2${P}`), a(`a2${P}`), u(`u3${P}`), a(`a3${P}`)];
    // Budget that fits (note + turns 2 & 3) but not turn 1 as well.
    const budget = wireTokens([noteMsg]) + wireTokens(msgs.slice(2));

    const r = trimWireToBudget(msgs, budget);
    expect(r.dropped).toBe(2); // turn 1 = 2 messages
    expect(r.messages[0]).toEqual(noteMsg);
    expect(r.messages.slice(1)).toEqual(msgs.slice(2)); // turns 2 & 3 intact
    // The note appears exactly once.
    const noteCount = r.messages.filter(
      (m) => m.role === 'user' && m.content.some((p) => p.type === 'text' && p.text === WIRE_TRIM_NOTE),
    ).length;
    expect(noteCount).toBe(1);
    // Turn 1's content is gone.
    expect(r.messages.some((m) => m.role === 'user' && m.content.some((p) => p.type === 'text' && p.text.startsWith('u1')))).toBe(false);
  });

  it('never drops the newest turn, even when it alone exceeds the budget', () => {
    const msgs = [u(`u1${P}`), a(`a1${P}`), u(`u2${P}`), a(`a2${P}`), u(`u3${P}`), a(`a3${P}`)];
    const r = trimWireToBudget(msgs, 1); // impossibly small

    // Every earlier turn dropped, but the newest turn survives (with the note).
    expect(r.messages[0]).toEqual(noteMsg);
    expect(r.messages.slice(1)).toEqual(msgs.slice(4));
    expect(r.dropped).toBe(4);
    // It is returned anyway even though it still overruns the budget.
    expect(wireTokens(r.messages)).toBeGreaterThan(1);
  });

  it('returns a single oversized turn as-is (no note, dropped 0)', () => {
    const one = [u('x'.repeat(4000))]; // ~1000 tokens, one turn
    const r = trimWireToBudget(one, 10);
    expect(r.dropped).toBe(0);
    expect(r.messages).toEqual(one);
  });
});
