/**
 * StreamSanitizer — strip leaked chat-template control tokens from streamed
 * `content` deltas and route reasoning-channel text to 'thinking'.
 *
 * Field problem: a misconfigured local server (e.g. LM Studio serving a community
 * QAT build with a wrong/missing chat template) leaks the model's raw channel
 * markers into the `content` stream as plain text — transcripts literally show
 * `<|channel|>thought <|channel|>` fragments between tool calls. Rendered verbatim
 * that junk pollutes verdict-JSON parsing and gate evidence, and reasoning that
 * should be collapsible arrives as visible text.
 *
 * This is a defensive *sanitizer*, not a faithful Harmony decoder. It sits between
 * raw content deltas and the emitted StreamEvents as a tiny state machine:
 *
 *   - Mode is either 'text' or 'thinking'. Recognized markers flip the mode and
 *     are always stripped from the output.
 *   - A holdback buffer keeps a small trailing tail unflushed ONLY while it could
 *     still grow into a marker (a partial `<`, `<|…`, `<th…`, `</th…`). Ordinary
 *     text — including HTML like `<div>` and a lone `<` mid-line — flushes right
 *     away; streaming latency matters. `flush()` releases any held tail verbatim.
 *
 * No vscode, no deps — pure and allocation-light.
 */

export interface SanitizedPart {
  kind: 'text' | 'thinking';
  delta: string;
}

type Mode = 'text' | 'thinking';

/** Harmony channel names that route subsequent content to 'thinking'. */
const THINKING_CHANNELS = new Set(['thought', 'thinking', 'analysis', 'reflection']);

/** Inline think-tag pairs (also strip the tags themselves). */
const THINK_TAGS: Array<{ tag: string; mode: Mode }> = [
  { tag: '<thinking>', mode: 'thinking' },
  { tag: '<think>', mode: 'thinking' },
  { tag: '</thinking>', mode: 'text' },
  { tag: '</think>', mode: 'text' },
];

/** Inner-token shape for orphan control tokens (`im_start`, `endoftext`, …). */
const ORPHAN_INNER_RE = /^[\w/.-]{1,32}$/;

/**
 * Upper bound on the held tail. The longest legitimate marker is well under this
 * (`<|channel|>reflection` = 21 chars, an orphan token ≤ 36); past the cap an
 * unclosed `<|…` is treated as literal text so a stray pipe never wedges output.
 */
const MAX_HOLDBACK = 48;

/**
 * Result of probing the text starting at a `<`:
 *  - consume: a recognized marker; drop `length` chars, optionally flip mode.
 *  - partial: could still grow into a marker — hold the tail (non-final only).
 *  - literal: the leading `<` is ordinary text; emit it and scan past it.
 */
type MarkerMatch =
  | { kind: 'consume'; length: number; setMode?: Mode }
  | { kind: 'partial' }
  | { kind: 'literal' };

export class StreamSanitizer {
  private mode: Mode = 'text';
  private hold = '';

  /** Feed a raw content delta; returns the sanitized parts ready to emit now. */
  pushText(delta: string): SanitizedPart[] {
    return this.process(this.hold + delta, false);
  }

  /** Release any held tail at stream end (a held prefix that never completed). */
  flush(): SanitizedPart[] {
    const parts = this.process(this.hold, true);
    this.hold = '';
    return parts;
  }

  private process(buffer: string, isFinal: boolean): SanitizedPart[] {
    this.hold = '';
    const parts: SanitizedPart[] = [];
    let runStart = 0; // start of the current same-mode text run
    let pos = 0;

    while (pos < buffer.length) {
      const lt = buffer.indexOf('<', pos);
      if (lt === -1) break; // no more markers possible — rest is a plain run

      const m = matchMarker(buffer.slice(lt), isFinal);

      if (m.kind === 'literal') {
        // The '<' is ordinary text; leave it in the run and keep scanning.
        pos = lt + 1;
        continue;
      }

      if (m.kind === 'partial') {
        // Emit up to the '<' and hold the rest until more text (or flush) arrives.
        this.emit(parts, buffer.slice(runStart, lt));
        this.hold = buffer.slice(lt);
        return parts;
      }

      // consume: emit the pre-marker run (in the old mode), then flip + strip.
      this.emit(parts, buffer.slice(runStart, lt));
      if (m.setMode) this.mode = m.setMode;
      pos = lt + m.length;
      runStart = pos;
    }

    this.emit(parts, buffer.slice(runStart));
    return parts;
  }

  /** Append text in the current mode, coalescing with the last same-mode part. */
  private emit(parts: SanitizedPart[], text: string): void {
    if (text.length === 0) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === this.mode) last.delta += text;
    else parts.push({ kind: this.mode, delta: text });
  }
}

/** Probe `s` (guaranteed to start with `<`) for a control marker. */
function matchMarker(s: string, isFinal: boolean): MarkerMatch {
  // --- Pipe tokens: <|channel|>, <|message|>, <|end|>, orphan <|…|> ---------
  if (s.startsWith('<|')) {
    const close = s.indexOf('|>', 2);
    if (close === -1) {
      // No terminator yet: could still complete on the next delta.
      if (!isFinal && s.length <= MAX_HOLDBACK) return { kind: 'partial' };
      return { kind: 'literal' };
    }
    const inner = s.slice(2, close);
    const tokenEnd = close + 2; // index just past `|>`

    if (inner === 'channel') return matchChannel(s, tokenEnd, isFinal);
    // Per spec these terminate a reasoning run back to visible text.
    if (inner === 'message' || inner === 'end') {
      return { kind: 'consume', length: tokenEnd, setMode: 'text' };
    }
    // Any other well-formed control token (im_start, endoftext, return, …) is an
    // orphan: strip it, leave the mode unchanged.
    if (ORPHAN_INNER_RE.test(inner)) return { kind: 'consume', length: tokenEnd };
    // `<|…|>` with an implausible inner (spaces, too long) — treat `<` as literal.
    return { kind: 'literal' };
  }

  // --- Inline think tags ----------------------------------------------------
  for (const { tag, mode } of THINK_TAGS) {
    if (s.startsWith(tag)) return { kind: 'consume', length: tag.length, setMode: mode };
  }
  if (!isFinal) {
    // A partial that could still become a think tag (e.g. '<', '<t', '<th',
    // '</thi'). NOT '<div' — no think tag starts with it, so it flushes.
    for (const { tag } of THINK_TAGS) {
      if (tag.startsWith(s)) return { kind: 'partial' };
    }
  }
  return { kind: 'literal' };
}

/**
 * Classify a `<|channel|>` marker by the channel name that follows it.
 * `tokenEnd` indexes the char just past `<|channel|>`.
 */
function matchChannel(s: string, tokenEnd: number, isFinal: boolean): MarkerMatch {
  const after = s.slice(tokenEnd);
  const named = /^[ \t]*([A-Za-z]+)/.exec(after);
  if (named) {
    const consumedLen = tokenEnd + named[0].length;
    // The name letters run to the end of the buffer — more may follow (a split
    // name like `<|channel|>tho` + `ught`). Hold unless this is the final flush.
    if (!isFinal && consumedLen === s.length) return { kind: 'partial' };
    const name = named[1].toLowerCase();
    const mode: Mode = THINKING_CHANNELS.has(name) ? 'thinking' : 'text';
    return { kind: 'consume', length: consumedLen, setMode: mode };
  }

  // No name letters immediately after the marker.
  const ws = /^[ \t]*/.exec(after)![0];
  if (ws.length === after.length) {
    // Only whitespace so far (possibly empty): a name might still arrive.
    if (!isFinal) return { kind: 'partial' };
    // Stream ended on a bare `<|channel|>` → absent name → back to text.
    return { kind: 'consume', length: tokenEnd + ws.length, setMode: 'text' };
  }
  // Whitespace then a non-letter (e.g. the next marker's `<`): bare channel with
  // an absent name → back to text, consuming the swallowed whitespace too.
  return { kind: 'consume', length: tokenEnd + ws.length, setMode: 'text' };
}
