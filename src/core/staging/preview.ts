/**
 * Preview artifact detection — pick the best previewable entry file out of a set
 * of staged ops.
 *
 * Pure and dependency-free (unit-tested in isolation): the ordering decides what
 * the Preview button opens when the human doesn't name a path. HTML wins over SVG
 * wins over Markdown; a page named `index.html` wins over its siblings; shallower
 * paths win over deeper ones; ties break alphabetically. Deleted ops are never
 * previewable.
 */

import type { FileOp } from '../../shared/types';

/** Extensions we know how to preview, most-preferred first. */
const PREVIEW_EXT_PRIORITY = ['.html', '.htm', '.svg', '.md'];

/** The lower-cased extension of a path (including the dot), or '' if none. */
function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/** Basename of a path, lower-cased. */
function baseOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).toLowerCase();
}

/** Depth of a path = number of `/` separators (shallower sorts first). */
function depthOf(path: string): number {
  let n = 0;
  for (const c of path) if (c === '/') n += 1;
  return n;
}

/**
 * Order candidate paths: ext priority, then `index.html`-ish first, then shallower
 * path, then alpha. Paths whose extension isn't previewable are dropped.
 */
export function previewCandidates(paths: string[]): string[] {
  const previewable = paths.filter((p) => PREVIEW_EXT_PRIORITY.includes(extOf(p)));
  return previewable.sort((a, b) => {
    const ea = PREVIEW_EXT_PRIORITY.indexOf(extOf(a));
    const eb = PREVIEW_EXT_PRIORITY.indexOf(extOf(b));
    if (ea !== eb) return ea - eb;
    // Within html candidates, prefer an index page.
    const ia = isIndex(a) ? 0 : 1;
    const ib = isIndex(b) ? 0 : 1;
    if (ia !== ib) return ia - ib;
    const da = depthOf(a);
    const db = depthOf(b);
    if (da !== db) return da - db;
    return a.localeCompare(b);
  });
}

/** Best previewable entry among non-deleted overlay ops, or null. */
export function detectPreviewEntry(ops: FileOp[]): string | null {
  const live = ops.filter((op) => op.kind !== 'delete').map((op) => op.path);
  return previewCandidates(live)[0] ?? null;
}

function isIndex(path: string): boolean {
  const b = baseOf(path);
  return b === 'index.html' || b === 'index.htm';
}
