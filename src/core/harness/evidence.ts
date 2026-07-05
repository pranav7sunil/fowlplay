/**
 * Coop harness — gate cards & evidence.
 *
 * Two responsibilities:
 *  1. Build and transition {@link GateCard}s (the evidence-based-delivery records the
 *     UI renders for every pipeline stage).
 *  2. Parse the structured verdicts emitted by role-prompted model calls. The parser is
 *     deliberately *lenient on shape* but *strict on safety*: when a verdict cannot be
 *     understood it defaults to `reject` (fail-safe) — it must never fail open into an
 *     approval.
 *
 * Pure TypeScript. No `vscode`, no Node built-ins.
 */

import type { GateCard, GateStatus, TokenUsage } from '../../shared/types';

// ---------------------------------------------------------------------------
// Gate cards
// ---------------------------------------------------------------------------

/** The full set of card owners: the four Coop roles plus the two synthetic gates. */
export type GateCardRole = GateCard['role'];

export interface GateCardInit {
  role: GateCardRole;
  title: string;
  /** Defaults to `'running'` — cards are created when a stage starts. */
  status?: GateStatus;
  evidence?: string;
  acceptanceCriteria?: string[];
  findings?: string[];
  attempt?: number;
  /** Display label of the model that ran this role. */
  modelLabel?: string;
  /** Workspace-relative entry point the changeset can be previewed from, when one was found. */
  previewPath?: string;
}

/**
 * Create a gate card in (by default) its `running` state. The `id` is supplied by the
 * caller so the same logical card keeps a stable identity across transitions — the UI
 * updates the existing card rather than appending a new one.
 */
export function createCard(id: string, init: GateCardInit): GateCard {
  const card: GateCard = {
    id,
    role: init.role,
    title: init.title,
    status: init.status ?? 'running',
    evidence: init.evidence ?? '',
  };
  if (init.acceptanceCriteria) card.acceptanceCriteria = init.acceptanceCriteria;
  if (init.findings) card.findings = init.findings;
  if (init.attempt !== undefined) card.attempt = init.attempt;
  if (init.modelLabel) card.modelLabel = init.modelLabel;
  if (init.previewPath) card.previewPath = init.previewPath;
  return card;
}

/**
 * Return a new card that is the given card moved to `status`, with optional field
 * patches merged in. Immutable: the input is not mutated, so callers can keep a history
 * of snapshots if they want. `id` and `role` are fixed.
 */
export function transition(
  card: GateCard,
  status: GateStatus,
  patch: Partial<Omit<GateCard, 'id' | 'role'>> = {},
): GateCard {
  return { ...card, ...patch, status, id: card.id, role: card.role };
}

// ---------------------------------------------------------------------------
// Markdown evidence assembly
// ---------------------------------------------------------------------------

/** Render a bullet list; empty input yields an italic "none" placeholder. */
export function bulletList(items: readonly string[], emptyLabel = '_none_'): string {
  const clean = items.map((i) => i.trim()).filter(Boolean);
  if (clean.length === 0) return emptyLabel;
  return clean.map((i) => `- ${i}`).join('\n');
}

/** Render a numbered list; empty input yields an italic "none" placeholder. */
export function numberedList(items: readonly string[], emptyLabel = '_none_'): string {
  const clean = items.map((i) => i.trim()).filter(Boolean);
  if (clean.length === 0) return emptyLabel;
  return clean.map((i, n) => `${n + 1}. ${i}`).join('\n');
}

export interface ChangeSummary {
  filesChanged: number;
  additions: number;
  deletions: number;
}

/** One-line markdown summary of a staged changeset. */
export function renderChangeSummary(s: ChangeSummary): string {
  const files = s.filesChanged === 1 ? '1 file' : `${s.filesChanged} files`;
  return `${files} changed · +${s.additions} / −${s.deletions}`;
}

/** Assemble a section-titled markdown block, skipping empty sections. */
export function section(title: string, body: string): string {
  const b = body.trim();
  if (!b) return '';
  return `**${title}**\n\n${b}`;
}

/** Join markdown blocks, dropping empties, with blank-line separators. */
export function joinSections(...blocks: string[]): string {
  return blocks.map((b) => b.trim()).filter(Boolean).join('\n\n');
}

// ---------------------------------------------------------------------------
// Verdict parsing
// ---------------------------------------------------------------------------

export type Verdict = 'approve' | 'reject' | 'block';

export interface ParsedVerdict {
  verdict: Verdict;
  findings: string[];
  evidence: string;
}

/** Cap raw model text stored in a card so a runaway response can't bloat the transcript. */
const MAX_EVIDENCE = 4000;

/**
 * Parse a role verdict. The model is asked for a fenced JSON block
 * `{verdict, findings[], evidence}` but weak/local models are sloppy, so we tolerate:
 *  - surrounding prose (extract the JSON object from anywhere in the text),
 *  - missing/mismatched code fences,
 *  - single-quoted JSON and trailing commas,
 *  - a plain-text `APPROVE` / `REJECT` / `BLOCK` first line as a fallback.
 *
 * When nothing usable can be extracted we return `reject` with a diagnostic finding —
 * never `approve`. Safety is not left to chance.
 */
export function parseVerdict(text: string): ParsedVerdict {
  const raw = (text ?? '').toString();

  const obj = extractJsonObject(raw);
  if (obj) {
    const verdict = normalizeVerdict(
      obj.verdict ?? obj.decision ?? obj.result ?? obj.status ?? obj.outcome,
    );
    if (verdict) {
      const findings = toStringList(obj.findings ?? obj.issues ?? obj.problems ?? obj.concerns);
      const evidence = firstString(obj.evidence, obj.reason, obj.rationale, obj.summary);
      return { verdict, findings, evidence: clip(evidence) };
    }
  }

  // Fallback: a leading APPROVE / REJECT / BLOCK keyword.
  const fb = fallbackVerdict(raw);
  if (fb) {
    return { verdict: fb, findings: [], evidence: clip(raw) };
  }

  // Hopeless — fail safe.
  return {
    verdict: 'reject',
    findings: ['could not parse verdict'],
    evidence: clip(raw),
  };
}

// ---------------------------------------------------------------------------
// Lenient JSON extraction (shared with roles.ts's parseScout)
// ---------------------------------------------------------------------------

/**
 * Pull the first parseable JSON object out of arbitrary model text. Tries fenced code
 * blocks first, then the widest `{ … }` span, applying quote/trailing-comma repairs.
 * Returns `undefined` if no object can be recovered.
 */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  for (const candidate of jsonCandidates(text ?? '')) {
    const parsed = looseParse(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

/** Coerce an unknown value into a trimmed, non-empty string array. */
export function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => (typeof v === 'string' ? v : v == null ? '' : String(v)))
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    // Allow a newline- or semicolon-separated single string.
    return value
      .split(/\n|;/)
      .map((v) => v.trim())
      .filter(Boolean);
  }
  return [];
}

function jsonCandidates(text: string): string[] {
  const out: string[] = [];
  // Fenced blocks: ```json … ``` (language tag optional).
  const fence = /```(?:json5?|jsonc)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const inner = m[1].trim();
    if (inner) out.push(inner);
  }
  // Widest brace span anywhere in the text.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) out.push(text.slice(first, last + 1));
  return out;
}

function looseParse(raw: string): Record<string, unknown> | undefined {
  const attempts = [
    raw,
    stripTrailingCommas(raw),
    normalizeQuotes(raw),
    stripTrailingCommas(normalizeQuotes(raw)),
  ];
  for (const attempt of attempts) {
    try {
      const parsed: unknown = JSON.parse(attempt);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try the next repair
    }
  }
  return undefined;
}

/** Convert single-quoted JSON to double-quoted. Best-effort; failures fall through. */
function normalizeQuotes(s: string): string {
  // Only rewrite when there are single but effectively no double quotes acting as
  // delimiters — avoids clobbering apostrophes inside a correctly double-quoted string.
  if (s.includes('"')) return s;
  return s.replace(/'/g, '"');
}

function stripTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, '$1');
}

function normalizeVerdict(value: unknown): Verdict | undefined {
  if (typeof value !== 'string') return undefined;
  const s = value.trim().toLowerCase();
  if (!s) return undefined;
  if (/^(appr|pass|ok\b|okay|lgtm|accept|yes\b|👍)/.test(s)) return 'approve';
  if (/^(block|halt|stop|freeze)/.test(s)) return 'block';
  if (/^(rej|fail|deny|denied|changes|request.?changes|no\b|nope)/.test(s)) return 'reject';
  return undefined;
}

/** Inspect only the first meaningful line for a bare verdict keyword. */
function fallbackVerdict(text: string): Verdict | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return undefined;

  // Primary: first meaningful line's leading word.
  const firstWord = lines[0].replace(/[^a-zA-Z]+/g, ' ').trim().split(/\s+/)[0];
  const v = normalizeVerdict(firstWord);
  if (v) return v;

  // Secondary: a line that *is* a verdict keyword (kept strict to avoid fail-open).
  for (const line of lines) {
    if (/^approve[d]?\b[.! ]*$/i.test(line)) return 'approve';
    if (/^(reject|rejected|fail|failed)\b[.! ]*$/i.test(line)) return 'reject';
    if (/^block(ed)?\b[.! ]*$/i.test(line)) return 'block';
  }
  return undefined;
}

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function clip(s: string): string {
  const t = s.trim();
  return t.length > MAX_EVIDENCE ? `${t.slice(0, MAX_EVIDENCE)}…` : t;
}
