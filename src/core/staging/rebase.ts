/**
 * Rebase engine — reconcile staged edits with drifted disk content.
 *
 * When disk content changes underneath a staged edit (external editor, another
 * tab applied), the recorded base no longer matches. `detectDrift` reports
 * which files drifted; `rebase` attempts a 3-way merge per drifted file by
 * replaying the overlay's base->staged hunks onto the new disk content using
 * context matching with line-shift tolerance. Files whose hunks cannot be
 * applied cleanly (missing context or overlapping targets) are reported as
 * conflicts for the caller to route to the model.
 */

import type { DiffHunk, RebaseState } from '../../shared/types';
import { computeFileDiff } from '../diff/compute';
import type { DiskReader, StagingOverlay } from './overlay';

/** Any op whose recorded base no longer matches disk is drift. */
export async function detectDrift(overlay: StagingOverlay, disk: DiskReader): Promise<RebaseState> {
  const drifted: string[] = [];
  for (const op of overlay.ops()) {
    const current = await disk.read(op.path);
    if (op.kind === 'create') {
      // A staged create conflicts if the file has since appeared on disk.
      if (current !== null) drifted.push(op.path);
    } else {
      if ((current ?? '') !== op.base) drifted.push(op.path);
    }
  }
  return { needed: drifted.length > 0, conflictedPaths: drifted };
}

/**
 * 3-way rebase. Cleanly-mergeable drifted files are restaged against the new
 * disk content as their base; unmergeable ones are returned as conflicts.
 */
export async function rebase(
  overlay: StagingOverlay,
  disk: DiskReader,
): Promise<{ ok: boolean; conflictedPaths: string[]; merged: Record<string, string> }> {
  const conflictedPaths: string[] = [];
  const merged: Record<string, string> = {};

  for (const op of overlay.ops()) {
    const current = await disk.read(op.path);

    if (op.kind === 'create') {
      if (current !== null) conflictedPaths.push(op.path); // file appeared -> conflict
      continue;
    }

    const currentContent = current ?? '';
    if (currentContent === op.base) continue; // no drift for this file

    if (op.kind === 'delete') {
      // The file we intended to delete changed externally — surface for review.
      conflictedPaths.push(op.path);
      continue;
    }

    // Drifted modify: replay base->staged hunks onto the new disk content.
    const fd = computeFileDiff(op.path, 'modify', op.base, op.staged);
    const result = applyHunksWithFuzz(currentContent, fd.hunks);
    if (result === null) {
      conflictedPaths.push(op.path);
      continue;
    }
    merged[op.path] = result;
    overlay.setOp({ kind: 'modify', path: op.path, base: currentContent, staged: result });
  }

  return { ok: conflictedPaths.length === 0, conflictedPaths, merged };
}

// ---------------------------------------------------------------------------
// Fuzzy hunk application
// ---------------------------------------------------------------------------

interface Repl {
  start: number; // inclusive index into new-content lines
  end: number; // exclusive
  insert: string[];
}

/**
 * Apply base->staged hunks onto `content`. Returns merged content, or null if
 * any hunk cannot be located or two hunks target overlapping regions.
 */
function applyHunksWithFuzz(content: string, hunks: DiffHunk[]): string | null {
  const lines = content.split('\n');
  const repls: Repl[] = [];

  for (const h of hunks) {
    const loc = locate(lines, h);
    if (loc === null) return null;
    for (const r of repls) {
      // Overlap (including a zero-width insert landing inside an edited range).
      if (loc.start < r.end && r.start < loc.end) return null;
      if (loc.start === loc.end && loc.start > r.start && loc.start < r.end) return null;
    }
    repls.push({ start: loc.start, end: loc.end, insert: h.stagedLines });
  }

  repls.sort((a, b) => a.start - b.start);
  const out: string[] = [];
  let cursor = 0;
  for (const r of repls) {
    while (cursor < r.start && cursor < lines.length) {
      out.push(lines[cursor]);
      cursor++;
    }
    out.push(...r.insert);
    cursor = r.end;
  }
  while (cursor < lines.length) {
    out.push(lines[cursor]);
    cursor++;
  }
  return out.join('\n');
}

/** Locate the [start, end) range in `lines` that a hunk's base lines occupy. */
function locate(lines: string[], h: DiffHunk): { start: number; end: number } | null {
  const near = h.baseStart - 1; // expected 0-based position in the old base

  if (h.baseLines.length > 0) {
    // Try progressively looser context around the removed lines.
    const attempts: { pre: string[]; post: string[] }[] = [
      { pre: h.contextBefore, post: h.contextAfter },
      { pre: h.contextBefore, post: [] },
      { pre: [], post: h.contextAfter },
      { pre: [], post: [] },
    ];
    for (const a of attempts) {
      const needle = [...a.pre, ...h.baseLines, ...a.post];
      const s = search(lines, needle, near - a.pre.length);
      if (s >= 0) {
        const midStart = s + a.pre.length;
        return { start: midStart, end: midStart + h.baseLines.length };
      }
    }
    return null;
  }

  // Pure insertion: anchor on surrounding context.
  if (h.contextBefore.length > 0) {
    const s = search(lines, h.contextBefore, near - h.contextBefore.length);
    if (s >= 0) {
      const idx = s + h.contextBefore.length;
      return { start: idx, end: idx };
    }
  }
  if (h.contextAfter.length > 0) {
    const s = search(lines, h.contextAfter, near);
    if (s >= 0) return { start: s, end: s };
  }
  if (h.contextBefore.length === 0 && h.contextAfter.length === 0) {
    // Insert into an effectively empty file.
    const idx = Math.min(Math.max(near, 0), lines.length);
    return { start: idx, end: idx };
  }
  return null;
}

/** Find `needle` as a contiguous run in `hay`, preferring positions near `near`. */
function search(hay: string[], needle: string[], near: number): number {
  if (needle.length === 0) return -1;
  const max = hay.length - needle.length;
  if (max < 0) return -1;
  const clampNear = Math.max(0, Math.min(near, max));
  for (let d = 0; d <= hay.length; d++) {
    const cands = d === 0 ? [clampNear] : [clampNear + d, clampNear - d];
    for (const s of cands) {
      if (s < 0 || s > max) continue;
      if (matchAt(hay, needle, s)) return s;
    }
  }
  return -1;
}

function matchAt(hay: string[], needle: string[], s: number): boolean {
  for (let i = 0; i < needle.length; i++) if (hay[s + i] !== needle[i]) return false;
  return true;
}
