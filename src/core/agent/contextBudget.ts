/**
 * Context-window budgeting.
 *
 * FowlPlay knows each model's context window (`ModelConfig.contextWindow`) and
 * resolves a model per Coop role. This module turns that knowledge into concrete
 * mechanism, so a big changeset or a long conversation does not overrun a small
 * local model and surface as a raw provider error:
 *
 *  - `estimateTokens` — a cheap chars/4 heuristic (never a real tokenizer).
 *  - `fitDiffToBudget` — split a unified diff at file boundaries and pack whole
 *    files into as few chunks as fit, so a review role (Inspector/Sentry) can run
 *    once per chunk instead of choking on the whole diff.
 *  - `trimWireToBudget` — drop the oldest whole turns from a wire history so the
 *    most recent turn always fits, never touching the newest user message.
 *
 * Pure TypeScript — no `vscode`, no Node built-ins. The caller always passes a
 * budget that is ALREADY net of system-prompt / instruction / response overhead.
 */

import type { WireMessage } from '../providers/adapter';

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

/** Cheap token estimate: ~4 characters per token, rounded up. */
export function estimateTokens(s: string): number {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

/** Small fixed cost charged per tool call / tool result (framing, ids, keys). */
const PART_OVERHEAD = 8;
/** Nominal cost for an inline image part (they never dominate a trim decision). */
const IMAGE_TOKENS = 256;

/** Estimate a single wire message's token footprint. */
function messageTokens(m: WireMessage): number {
  if (m.role === 'tool') {
    return m.results.reduce((n, r) => n + estimateTokens(r.content) + PART_OVERHEAD, 0);
  }
  let sum = 0;
  for (const part of m.content) {
    if (part.type === 'text' || part.type === 'thinking') {
      sum += estimateTokens(part.text);
    } else if (part.type === 'tool_call') {
      sum += estimateTokens(safeJson(part.args)) + PART_OVERHEAD;
    } else if (part.type === 'image') {
      sum += IMAGE_TOKENS;
    }
  }
  return sum;
}

/** Total estimated tokens for a wire history. */
export function wireTokens(messages: WireMessage[]): number {
  let sum = 0;
  for (const m of messages) sum += messageTokens(m);
  return sum;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Diff fitting
// ---------------------------------------------------------------------------

/** Maximum number of chunks a diff is ever split into for chunked review. */
const MAX_CHUNKS = 4;

function truncationMarker(hunks: number): string {
  return `[... diff truncated to fit the model's context window — ${hunks} more hunk(s) not shown]`;
}

/**
 * Split a unified diff to fit a per-call token budget.
 *
 *  - Fits entirely → a single chunk, byte-for-byte unchanged.
 *  - Otherwise split at file boundaries (`--- a/` headers) and greedily pack
 *    whole files into as few chunks as possible, each ≤ budget, capped at
 *    {@link MAX_CHUNKS}.
 *  - A single file bigger than the budget keeps its leading hunks up to budget
 *    and gains a truncation marker; `truncated` becomes true.
 *  - If even {@link MAX_CHUNKS} chunks cannot hold everything, the overflow is
 *    folded into the last chunk's truncation marker rather than emitting more.
 */
export function fitDiffToBudget(
  diff: string,
  budgetTokens: number,
): { chunks: string[]; truncated: boolean } {
  if (estimateTokens(diff) <= budgetTokens) {
    return { chunks: [diff], truncated: false };
  }

  const files = splitDiffByFile(diff);
  let truncated = false;

  // Normalize: any file that alone exceeds the budget is truncated to fit.
  const units: string[] = [];
  for (const file of files) {
    if (estimateTokens(file) <= budgetTokens) {
      units.push(file);
    } else {
      const t = truncateFileToBudget(file, budgetTokens);
      if (t.droppedHunks > 0) truncated = true;
      units.push(t.text);
    }
  }

  // Greedy first-fit packing of whole files into chunks ≤ budget.
  const chunks: string[] = [];
  let current = '';
  for (const unit of units) {
    if (current === '') {
      current = unit;
      continue;
    }
    const combined = `${current}\n${unit}`;
    if (estimateTokens(combined) <= budgetTokens) {
      current = combined;
    } else {
      chunks.push(current);
      current = unit;
    }
  }
  if (current !== '') chunks.push(current);

  // Cap the chunk count: fold overflow into the last kept chunk's marker.
  if (chunks.length > MAX_CHUNKS) {
    const kept = chunks.slice(0, MAX_CHUNKS);
    const overflow = chunks.slice(MAX_CHUNKS);
    const droppedHunks = overflow.reduce((n, c) => n + countHunks(c), 0);
    kept[MAX_CHUNKS - 1] = `${kept[MAX_CHUNKS - 1]}\n${truncationMarker(droppedHunks)}`;
    return { chunks: kept, truncated: true };
  }

  return { chunks, truncated };
}

/** Split a unified diff into per-file blocks, each starting at a `--- a/` header. */
function splitDiffByFile(diff: string): string[] {
  const lines = diff.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.startsWith('--- a/') && current.length > 0) {
      blocks.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks;
}

/** Separate a file block's header (`---`/`+++` lines) from its `@@` hunks. */
function splitFileIntoHunks(fileBlock: string): { header: string; hunks: string[] } {
  const lines = fileBlock.split('\n');
  const header: string[] = [];
  const hunks: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (current) hunks.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    } else {
      header.push(line);
    }
  }
  if (current) hunks.push(current.join('\n'));
  return { header: header.join('\n'), hunks };
}

/** Keep a single file's leading hunks up to budget; append a marker for the rest. */
function truncateFileToBudget(
  fileBlock: string,
  budgetTokens: number,
): { text: string; droppedHunks: number } {
  const { header, hunks } = splitFileIntoHunks(fileBlock);
  const kept: string[] = [];
  for (let i = 0; i < hunks.length; i += 1) {
    const droppedIfStop = hunks.length - (i + 1);
    const marker = droppedIfStop > 0 ? `\n${truncationMarker(droppedIfStop)}` : '';
    const candidate = [header, ...kept, hunks[i]].join('\n');
    if (estimateTokens(candidate + marker) <= budgetTokens) {
      kept.push(hunks[i]);
    } else {
      break;
    }
  }
  const droppedHunks = hunks.length - kept.length;
  if (droppedHunks === 0) return { text: fileBlock, droppedHunks: 0 };
  const text = `${[header, ...kept].join('\n')}\n${truncationMarker(droppedHunks)}`;
  return { text, droppedHunks };
}

function countHunks(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) if (line.startsWith('@@')) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Wire history trimming
// ---------------------------------------------------------------------------

/** The synthetic note prepended once when earlier turns are dropped. */
export const WIRE_TRIM_NOTE = '[earlier conversation trimmed to fit the model\'s context window]';

function trimNoteMessage(): WireMessage {
  return { role: 'user', content: [{ type: 'text', text: WIRE_TRIM_NOTE }] };
}

/**
 * Drop the oldest whole turns from a wire history until it fits the budget.
 *
 * Invariants:
 *  - The newest user message and everything after it are NEVER dropped.
 *  - Turns are dropped oldest-first, in whole units (a user message plus every
 *    message up to the next user message).
 *  - When anything is dropped, a single synthetic user note is prepended.
 *  - If the newest turn alone still exceeds the budget, it is returned anyway
 *    (with the note if earlier turns were dropped) — the caller decides.
 */
export function trimWireToBudget(
  messages: WireMessage[],
  budgetTokens: number,
): { messages: WireMessage[]; dropped: number } {
  if (messages.length === 0) return { messages, dropped: 0 };

  const userIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') userIdx.push(i);
  });
  // No user turns → nothing we can safely drop.
  if (userIdx.length === 0) return { messages, dropped: 0 };

  // Already fits → untouched.
  if (wireTokens(messages) <= budgetTokens) return { messages, dropped: 0 };

  // Drop-unit boundaries: unit 0 covers any leading orphan + the first user
  // turn; each later unit starts at a user message. The final unit (the newest
  // turn) is protected and never dropped.
  const boundaries = [0];
  for (let k = 1; k < userIdx.length; k += 1) boundaries.push(userIdx[k]);

  const noteTokens = messageTokens(trimNoteMessage());
  const tokensFrom = (idx: number): number => {
    let sum = noteTokens;
    for (let i = idx; i < messages.length; i += 1) sum += messageTokens(messages[i]);
    return sum;
  };

  // Advance keepFrom one whole turn at a time until it fits or only the newest
  // turn remains.
  let keepFrom = 0;
  for (let unit = 0; unit < boundaries.length - 1; unit += 1) {
    keepFrom = boundaries[unit + 1];
    if (tokensFrom(keepFrom) <= budgetTokens) break;
  }

  // Nothing could be dropped (single turn) → return untouched.
  if (keepFrom === 0) return { messages, dropped: 0 };

  return { messages: [trimNoteMessage(), ...messages.slice(keepFrom)], dropped: keepFrom };
}
