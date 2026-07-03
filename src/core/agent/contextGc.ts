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

  // Anything before the most recent turn is fully collected.
  if (beforeLastTurn) return stub(r);

  // Within the last turn, only file-content is deduped across repeated opens.
  if (r.gcClass !== 'file-content') return r;

  const paths = r.paths ?? [];
  if (paths.length === 0) return r;

  const seenCount = paths.reduce((n, p) => (seenPaths.has(p) ? n + 1 : n), 0);

  let result = r;
  if (seenCount === paths.length) {
    // Every path already appeared in a newer result — the whole payload is stale.
    result = stub(r);
  } else if (seenCount > 0) {
    // Partial overlap: some paths were re-opened more recently, others weren't.
    // Stub only the already-seen files' sections; keep the fresh ones so we
    // never drop a path that has no newer copy. The tool result message itself
    // is preserved (never dropped) so tool_call/tool_result pairing holds.
    const rewritten = stubSeenSections(r.content, seenPaths);
    if (rewritten !== null) result = { ...r, content: rewritten };
  }

  // Record every path this result covers so older copies get collected. Paths
  // already seen (a newer copy exists) stay owned by that newer copy.
  for (const p of paths) seenPaths.add(p);
  return result;
}

/**
 * Rewrite an `open_files` payload, replacing the sections whose path is already
 * seen (a newer copy exists) with the stub, and keeping the rest verbatim.
 *
 * The payload is `===== <path> =====\n<numbered body>` sections joined by a
 * blank line; numbered bodies never contain a blank line, so splitting on the
 * blank-line separator recovers the sections. Returns `null` if the payload is
 * not in the expected shape, so the caller can leave it untouched.
 */
function stubSeenSections(content: string, seenPaths: Set<string>): string | null {
  const sections = content.split('\n\n');
  let matchedAny = false;
  const rewritten = sections.map((section) => {
    const nl = section.indexOf('\n');
    const header = nl === -1 ? section : section.slice(0, nl);
    const m = /^===== (.+?) =====$/.exec(header);
    if (!m) return section;
    matchedAny = true;
    return seenPaths.has(m[1]) ? `${header}\n${STUB}` : section;
  });
  return matchedAny ? rewritten.join('\n\n') : null;
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
