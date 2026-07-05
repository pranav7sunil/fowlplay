/**
 * Deterministic file-reference extraction for chat prompts.
 *
 * The field problem: a coop prompt like "implement auraringprd.md" only reached the
 * roles as bare text — whether the referenced file was ever read depended on a small
 * model deciding to call a tool. This module lets the HOST resolve file references up
 * front and hand the content straight into the pipeline, so every role sees it.
 *
 * Two flavors of reference are recognized:
 *   - explicit `@<path>` mentions — the user (or the composer's `@` autocomplete) marked
 *     it, so a miss is worth a warning.
 *   - bare, conservative path-looking tokens ("auraringprd.md", "src/foo.ts") — recognized
 *     leniently; a candidate that does not resolve on disk is silently treated as prose.
 *
 * PURE TypeScript — no `vscode`, no Node built-ins, no network. Fully unit-testable
 * (see test/fileMentions.test.ts). The host does the actual filesystem reads and toasts.
 */

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Known text-ish file extensions a bare token may end in to count as a path. */
const TEXT_EXTS = [
  'md', 'txt', 'json', 'ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'java',
  'c', 'h', 'cpp', 'css', 'html', 'yml', 'yaml', 'toml', 'sh',
];
const EXT_RE = new RegExp(`\\.(?:${TEXT_EXTS.join('|')})$`, 'i');

/** Strip wrapping punctuation a token may have picked up from surrounding prose. */
function stripPunct(token: string): string {
  return token.replace(/^[([{'"`]+/, '').replace(/[).,;:!?\]}'"`]+$/, '');
}

/** Strip trailing sentence punctuation from an explicit `@`-path capture (`@foo.md.`). */
function stripTrailing(path: string): string {
  return path.replace(/[.]+$/, '');
}

export interface FileMentions {
  /** `@<path>` mentions, the leading `@` stripped, in first-seen order (deduped). */
  explicit: string[];
  /** Conservative bare path-looking tokens, not already an explicit mention. */
  bare: string[];
}

/**
 * Extract file references from prompt text.
 *
 * explicit: `@<path>` where the `@` sits at a token start (string start or after
 * whitespace/open bracket) and the path (`[\w./-]+`) contains at least one `.` or `/`.
 * The `@` is only a marker and is stripped. Requiring a token boundary keeps
 * email-ish `user@host.com` from registering `@host.com`.
 *
 * bare: whitespace-split tokens that look like a path but carry no `@` marker —
 * either containing a `/` or ending in a {@link TEXT_EXTS known text extension}.
 * Guards keep prose out: URL-scheme tokens (`x://…`) are skipped, tokens must be
 * ≥4 chars, must contain a letter, and an extension match additionally requires a
 * letter before the extension dot (so `3.6`, `v1.2.3`, `qwen3.6-35b-moe` never match).
 * Anything already captured as explicit is excluded. Order preserved, deduped.
 */
export function extractFileMentions(text: string): FileMentions {
  const src = text ?? '';

  const explicit: string[] = [];
  const explicitSeen = new Set<string>();
  const explicitRe = /(?:^|[\s([{'"`])@([\w./-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = explicitRe.exec(src)) !== null) {
    const path = stripTrailing(m[1]);
    if (!path || !/[./]/.test(path)) continue; // must look like a path, not "@here"
    if (!explicitSeen.has(path)) {
      explicitSeen.add(path);
      explicit.push(path);
    }
  }

  const bare: string[] = [];
  const bareSeen = new Set<string>();
  for (const raw of src.split(/\s+/)) {
    const t = stripPunct(raw);
    if (!t) continue;
    if (t.includes('@')) continue; // explicit mention or an email — not bare
    if (t.includes('://')) continue; // URL, not a workspace path
    if (t.length < 4) continue;
    if (!/[a-zA-Z]/.test(t)) continue; // pure numbers/versions are not paths
    const hasSlash = t.includes('/');
    const extMatch = EXT_RE.test(t);
    if (!hasSlash && !extMatch) continue;
    if (extMatch && !hasSlash) {
      // Require a letter before the extension dot so "3.6"/"v1.2.3" (no letter in
      // the stem) never qualify even if the tail coincidentally reads as an ext.
      const stem = t.replace(EXT_RE, '');
      if (!/[a-zA-Z]/.test(stem)) continue;
    }
    if (explicitSeen.has(t) || bareSeen.has(t)) continue;
    bareSeen.add(t);
    bare.push(t);
  }

  return { explicit, bare };
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/**
 * Wrap arbitrary content in a fenced code block whose backtick run is longer than any
 * run inside the content, so a file that itself contains ``` cannot break out of the
 * fence (which would corrupt the reference / open a prompt-injection seam). Mirrors the
 * helper session.ts uses for pinned selections and attachments.
 */
export function fencedBlock(info: string, content: string): string {
  let longest = 0;
  for (const run of content.matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${content}\n${fence}`;
}

/**
 * Append one fenced block per resolved file to the prompt text. Each block is:
 *   <blank line>
 *   Referenced file <path>:
 *   <backtick-safe fence>
 *   <content>
 *   <fence>
 * The original text is returned unchanged when `files` is empty.
 */
export function expandFileMentions(text: string, files: { path: string; content: string }[]): string {
  let out = text ?? '';
  for (const f of files) {
    out += `\n\nReferenced file ${f.path}:\n${fencedBlock('', f.content)}`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Capping
// ---------------------------------------------------------------------------

/** Marker appended when a referenced file is truncated to fit the model's window. */
export const FILE_TRUNCATION_MARKER = "\n[... file truncated to fit the model's context window]";

/**
 * Keep the head of a file up to `maxChars`, appending {@link FILE_TRUNCATION_MARKER}
 * when it overruns. Returns the (possibly truncated) content and whether it was cut.
 */
export function capFileContent(content: string, maxChars: number): { content: string; truncated: boolean } {
  const src = content ?? '';
  if (src.length <= maxChars) return { content: src, truncated: false };
  const head = src.slice(0, Math.max(0, maxChars));
  return { content: head + FILE_TRUNCATION_MARKER, truncated: true };
}
