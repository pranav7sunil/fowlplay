/**
 * Context garbage collection.
 *
 * FowlPlay manages context by *trimming*, not compacting: conversation text is
 * always preserved, but stale tool-result payloads (file contents, search
 * results) are replaced with a one-line stub once they are no longer part of the
 * most recent turn. Additionally, when the same file is opened multiple times,
 * only the newest copy's content is kept.
 *
 * This keeps the transcript sent to the model lean without losing the shape of
 * the conversation, so the model can re-open anything it still needs.
 */

import type { WireMessage, WireToolResult } from '../providers/adapter';

const STUB = '[content garbage-collected — re-open if needed]';

export function gcHistory(messages: WireMessage[]): WireMessage[] {
  const lastTurnStart = lastUserIndex(messages);
  const seenPaths = new Set<string>();

  // Walk newest → oldest so dedup keeps the most recent copy of each file.
  const out: WireMessage[] = new Array(messages.length);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.role !== 'tool') {
      out[i] = m; // conversation text is never touched
      continue;
    }

    const beforeLastTurn = i < lastTurnStart;
    const results = m.results.map((r) => gcResult(r, beforeLastTurn, seenPaths));
    out[i] = { role: 'tool', results };
  }
  return out;
}

function gcResult(
  r: WireToolResult,
  beforeLastTurn: boolean,
  seenPaths: Set<string>,
): WireToolResult {
  const collectible = r.gcClass === 'file-content' || r.gcClass === 'search-result';
  if (!collectible) return r;

  const paths = r.paths ?? [];
  // A file-content result is a duplicate if every path it covers has already
  // appeared in a newer result.
  const duplicate =
    r.gcClass === 'file-content' && paths.length > 0 && paths.every((p) => seenPaths.has(p));

  if (beforeLastTurn || duplicate) {
    return stub(r);
  }

  // Keeping this one — record its paths so older duplicates get collected.
  if (r.gcClass === 'file-content') {
    for (const p of paths) seenPaths.add(p);
  }
  return r;
}

function stub(r: WireToolResult): WireToolResult {
  const out: WireToolResult = { toolCallId: r.toolCallId, content: STUB };
  if (r.name !== undefined) out.name = r.name;
  if (r.gcClass !== undefined) out.gcClass = r.gcClass;
  if (r.isError !== undefined) out.isError = r.isError;
  return out;
}

/** Index of the last user message (start of the most recent turn); 0 if none. */
function lastUserIndex(messages: WireMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return i;
  }
  return 0;
}
