/**
 * Precise find/replace application for the edit tool.
 *
 * Weak/local models often reproduce the target text imperfectly (indentation,
 * trailing whitespace, collapsed runs). To stay reliable we try a ladder of
 * progressively looser matchers:
 *
 *   1. exact substring
 *   2. whitespace-normalized, line-trimmed match
 *   3. anchored fuzzy: first + last lines match exactly, interior tolerant of
 *      whitespace-only differences
 *
 * When `all` is false and more than one match is found, we fail with the count
 * so the model can disambiguate. On total failure we attach a "nearest miss":
 * the best-scoring window of the file, so the model can self-correct next round.
 */

export type FindReplaceResult =
  | { ok: true; content: string }
  | { ok: false; reason: string; nearestMiss?: string };

export function applyFindReplace(
  content: string,
  find: string,
  replace: string,
  all: boolean,
): FindReplaceResult {
  if (find.length === 0) {
    return { ok: false, reason: 'find text is empty' };
  }

  // --- 1. exact substring --------------------------------------------------
  const exact = indexOfAll(content, find);
  if (exact.length > 0) {
    if (!all && exact.length > 1) {
      return {
        ok: false,
        reason: `found ${exact.length} exact matches; set all:true or make find more specific`,
      };
    }
    return { ok: true, content: replaceRanges(content, exact.map((start) => ({ start, end: start + find.length })), replace, all) };
  }

  const contentLines = content.split('\n');
  const findLines = find.split('\n');

  // --- 2. whitespace-normalized, line-trimmed match ------------------------
  const trimmedWindows = findLineWindows(contentLines, findLines, (line) => line.trim());
  if (trimmedWindows.length > 0) {
    if (!all && trimmedWindows.length > 1) {
      return {
        ok: false,
        reason: `found ${trimmedWindows.length} whitespace-insensitive matches; set all:true or make find more specific`,
      };
    }
    return { ok: true, content: replaceLineWindows(contentLines, trimmedWindows, replace, all) };
  }

  // --- 3. anchored fuzzy match --------------------------------------------
  const fuzzyWindows = findAnchoredWindows(contentLines, findLines);
  if (fuzzyWindows.length > 0) {
    if (!all && fuzzyWindows.length > 1) {
      return {
        ok: false,
        reason: `found ${fuzzyWindows.length} anchored fuzzy matches; set all:true or make find more specific`,
      };
    }
    return { ok: true, content: replaceLineWindows(contentLines, fuzzyWindows, replace, all) };
  }

  // --- failure with nearest miss ------------------------------------------
  const miss = bestScoringWindow(contentLines, findLines);
  return {
    ok: false,
    reason: 'no match found for the given text',
    ...(miss ? { nearestMiss: miss } : {}),
  };
}

// ---------------------------------------------------------------------------
// Exact substring helpers
// ---------------------------------------------------------------------------

function indexOfAll(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + needle.length; // non-overlapping
  }
  return out;
}

interface CharRange {
  start: number;
  end: number;
}

function replaceRanges(
  content: string,
  ranges: CharRange[],
  replace: string,
  all: boolean,
): string {
  const used = all ? ranges : ranges.slice(0, 1);
  let out = '';
  let cursor = 0;
  for (const r of used) {
    out += content.slice(cursor, r.start) + replace;
    cursor = r.end;
  }
  out += content.slice(cursor);
  return out;
}

// ---------------------------------------------------------------------------
// Line-window matching (approaches 2 & 3)
// ---------------------------------------------------------------------------

interface LineWindow {
  start: number; // inclusive line index
  end: number; // exclusive line index
}

/** Find non-overlapping windows where each line matches under `normalize`. */
function findLineWindows(
  contentLines: string[],
  findLines: string[],
  normalize: (line: string) => string,
): LineWindow[] {
  const n = findLines.length;
  if (n === 0) return [];
  const normFind = findLines.map(normalize);
  const windows: LineWindow[] = [];
  for (let i = 0; i + n <= contentLines.length; i += 1) {
    let match = true;
    for (let j = 0; j < n; j += 1) {
      if (normalize(contentLines[i + j]) !== normFind[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      windows.push({ start: i, end: i + n });
      i += n - 1; // skip past this window to keep matches non-overlapping
    }
  }
  return windows;
}

/**
 * Anchored fuzzy: first and last lines must match exactly (trimmed), interior
 * lines match ignoring all whitespace. Requires at least 2 find lines to have
 * meaningful anchors.
 */
function findAnchoredWindows(contentLines: string[], findLines: string[]): LineWindow[] {
  const n = findLines.length;
  if (n < 2) return [];
  const firstAnchor = findLines[0].trim();
  const lastAnchor = findLines[n - 1].trim();
  const interiorStripped = findLines.slice(1, n - 1).map(stripWs);

  const windows: LineWindow[] = [];
  for (let i = 0; i + n <= contentLines.length; i += 1) {
    if (contentLines[i].trim() !== firstAnchor) continue;
    if (contentLines[i + n - 1].trim() !== lastAnchor) continue;
    let interiorOk = true;
    for (let j = 1; j < n - 1; j += 1) {
      if (stripWs(contentLines[i + j]) !== interiorStripped[j - 1]) {
        interiorOk = false;
        break;
      }
    }
    if (interiorOk) {
      windows.push({ start: i, end: i + n });
      i += n - 1;
    }
  }
  return windows;
}

function replaceLineWindows(
  contentLines: string[],
  windows: LineWindow[],
  replace: string,
  all: boolean,
): string {
  const used = all ? windows : windows.slice(0, 1);
  const replaceLines = replace.split('\n');
  const out: string[] = [];
  let cursor = 0;
  for (const w of used) {
    for (let i = cursor; i < w.start; i += 1) out.push(contentLines[i]);
    out.push(...replaceLines);
    cursor = w.end;
  }
  for (let i = cursor; i < contentLines.length; i += 1) out.push(contentLines[i]);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Nearest-miss scoring
// ---------------------------------------------------------------------------

/**
 * Return the best-scoring window (by normalized line overlap) as original text,
 * so the model can see what the file actually contains near its intended target.
 */
function bestScoringWindow(contentLines: string[], findLines: string[]): string | undefined {
  const n = Math.max(1, findLines.length);
  if (contentLines.length === 0) return undefined;
  const findSet = new Set(findLines.map(stripWs).filter((s) => s.length > 0));
  if (findSet.size === 0) return undefined;

  let bestScore = 0;
  let bestStart = 0;
  const limit = Math.max(1, contentLines.length - n + 1);
  for (let i = 0; i < limit; i += 1) {
    let score = 0;
    for (let j = 0; j < n && i + j < contentLines.length; j += 1) {
      if (findSet.has(stripWs(contentLines[i + j]))) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }
  if (bestScore === 0) return undefined;
  const end = Math.min(contentLines.length, bestStart + n);
  return contentLines.slice(bestStart, end).join('\n');
}

function stripWs(line: string): string {
  return line.replace(/\s+/g, '');
}
