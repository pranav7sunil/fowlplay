/**
 * Deterministic chat-mention parsing for per-role model directives.
 *
 * A user can steer which model runs which Coop role in plain prose — e.g.
 * "qwen to orchestrate", "build with glm", "use fable for review", or a
 * role-less "use qwen" / "switch to qwen" that sets the conversation model.
 *
 * This module is a PURE, conservative recognizer: no `vscode`, no network, no
 * fuzzy AI. The grammar is intentionally narrow — it is better to miss a
 * directive than to false-positive on ordinary prose like
 * "we should build the parser with care". Recognition and model matching are
 * split so the host can toast on 0 matches and disambiguate on >1.
 *
 * Fully unit-testable (see test/modelMentions.test.ts).
 */

import type { CoopRole, ModelRef, ProviderConfig } from '../../shared/types';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

/** The target of a mention: a specific Coop role, or the whole conversation. */
export type MentionRole = CoopRole | 'conversation';

export interface Mention {
  role: MentionRole;
  /** The captured model-name query (1–3 short tokens), verbatim from the text. */
  query: string;
}

export interface ModelMatch {
  providerId: string;
  modelId: string;
  /** Human label (displayName or id) for pickers / confirmations. */
  label: string;
}

// ---------------------------------------------------------------------------
// Grammar tables (case-insensitive throughout)
// ---------------------------------------------------------------------------

/** Verbs that name a role when used as an action ("<name> to <verb>"). */
const VERB_TO_ROLE: Record<string, CoopRole> = {
  build: 'builder', builds: 'builder', building: 'builder', implement: 'builder',
  plan: 'scout', plans: 'scout', planning: 'scout', orchestrate: 'scout', orchestrates: 'scout', scout: 'scout',
  review: 'inspector', reviews: 'inspector', reviewing: 'inspector', inspect: 'inspector', qa: 'inspector',
  security: 'sentry', sentry: 'sentry', audit: 'sentry',
};

/** Role-nouns used in "<name> for <role-noun>". */
const NOUN_TO_ROLE: Record<string, CoopRole> = {
  building: 'builder', implementation: 'builder',
  planning: 'scout', orchestration: 'scout',
  review: 'inspector', qa: 'inspector', inspection: 'inspector',
  security: 'sentry', audit: 'sentry',
};

/**
 * Role-person nouns for copula/predicate phrasing: "<name> should be the
 * builder", "<name> is the reviewer", "make <name> the auditor", "builder: <name>".
 * `foreman` maps to scout because the Foreman shares the Scout's model resolution.
 */
const PERSON_TO_ROLE: Record<string, CoopRole> = {
  builder: 'builder', implementer: 'builder', developer: 'builder',
  orchestrator: 'scout', planner: 'scout', scout: 'scout', foreman: 'scout',
  reviewer: 'inspector', inspector: 'inspector', qa: 'inspector',
  auditor: 'sentry', sentry: 'sentry',
};

/**
 * Structural connectives that must never be captured as part of a model name.
 * Combined with the verb/noun vocabulary, these bound the `<name>` capture so a
 * directive cannot swallow the next clause ("qwen to orchestrate and glm to
 * build" stays two mentions, not one).
 */
const CONNECTIVES = ['to', 'with', 'for', 'and', 'or', 'use', 'let', 'switch', 'everything', 'all', 'every', 'please'];

/**
 * Copula/modal glue for predicate phrasing, plus pronouns/articles that must
 * never be mistaken for a model name ("it should be the builder" must not
 * produce a mention with query "it").
 */
const COPULA_WORDS = ['should', 'shall', 'will', 'can', 'must', 'be', 'is', 'as', 'make', 'the', 'our', 'my', 'a', 'an'];
const NAME_STOPWORDS = ['it', 'this', 'that', 'these', 'those', 'he', 'she', 'they', 'we', 'i', 'you', 'who', 'which', 'what', 'there', 'model', 'models'];

const KEYWORDS = new Set<string>([
  ...CONNECTIVES,
  ...COPULA_WORDS,
  ...NAME_STOPWORDS,
  ...Object.keys(VERB_TO_ROLE),
  ...Object.keys(NOUN_TO_ROLE),
  ...Object.keys(PERSON_TO_ROLE),
]);

function isKeyword(token: string): boolean {
  return KEYWORDS.has(token.toLowerCase());
}

/** Alternation of tokens, longest-first so e.g. "reviewing" beats "review". */
function alternation(tokens: string[]): string {
  return [...tokens]
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
}

const VERB_ALT = alternation(Object.keys(VERB_TO_ROLE));
const NOUN_ALT = alternation(Object.keys(NOUN_TO_ROLE));
const PERSON_ALT = alternation(Object.keys(PERSON_TO_ROLE));
const KW_ALT = alternation([...KEYWORDS]);

// Conjunction chains: "orchestrate and build", "review, audit and security".
// A chain is a first verb/noun plus zero or more ("and"/comma)-joined ones, so
// "qwen to orchestrate and build" assigns BOTH roles. The joined token must
// itself be a verb/noun — "qwen to orchestrate and glm to build" does NOT chain
// ("glm" is a name), leaving the second clause for its own pattern.
const CHAIN_JOIN = `(?:[ \\t]*,[ \\t]*(?:and[ \\t]+)?|[ \\t]+and[ \\t]+)`;
const VERB_CHAIN = `(${VERB_ALT})((?:${CHAIN_JOIN}(?:${VERB_ALT})\\b)*)`;
const NOUN_CHAIN = `(${NOUN_ALT})((?:${CHAIN_JOIN}(?:${NOUN_ALT})\\b)*)`;
const PERSON_CHAIN = `(${PERSON_ALT})((?:${CHAIN_JOIN}(?:the[ \\t]+)?(?:${PERSON_ALT})\\b)*)`;
// Copula glue: "should be the", "will be our", "is the", "as", "as the" …
const COPULA = `(?:(?:should|shall|will|can|must)[ \\t]+(?:be[ \\t]+)?|is[ \\t]+|as[ \\t]+)(?:the[ \\t]+|our[ \\t]+|my[ \\t]+|a[ \\t]+|an[ \\t]+)?`;

/** Expand a matched chain (first token + joined tail) into its role list, deduped in order. */
function chainRoles(table: Record<string, CoopRole>, first: string, tail: string): CoopRole[] {
  const words = [first, ...(tail ?? '').split(/[^a-z0-9]+/i)].filter(Boolean);
  const out: CoopRole[] = [];
  for (const w of words) {
    const role = table[w.toLowerCase()];
    if (role && !out.includes(role)) out.push(role);
  }
  return out;
}

// A single name token: word-ish run that is NOT itself a keyword. The leading
// `\b` (only on the first token) prevents starting inside another word — e.g.
// backtracking into "and" to capture "nd".
const NAME_TOKEN = `(?!(?:${KW_ALT})\\b)[A-Za-z0-9][\\w.:/-]*`;
// A name: 1–3 such tokens, anchored at a word boundary.
const NAME = `(\\b${NAME_TOKEN}(?:[ \\t]+${NAME_TOKEN}){0,2})`;
// Optional trailing "for everything / all / every role" on a role-less directive.
const FOR_ALL = `(?:[ \\t]+for[ \\t]+(?:everything|all(?:[ \\t]+roles?)?|every[ \\t]+role))?`;

// ---------------------------------------------------------------------------
// Pattern set (priority order — most specific first)
// ---------------------------------------------------------------------------

interface Pattern {
  re: RegExp;
  /** Produce the mentions for a match (one per chained verb/noun), or null to reject it. */
  make(m: RegExpExecArray): Mention[] | null;
}

const nameQuery = (raw: string): string => {
  const out: string[] = [];
  for (const t of raw.trim().split(/\s+/).filter(Boolean)) {
    if (isKeyword(t) || out.length === 3) break;
    out.push(t);
  }
  return out.join(' ').trim();
};

/** One mention per role in a verb/noun chain, all with the same model query. */
const chainMentions = (query: string, roles: CoopRole[]): Mention[] | null =>
  query && roles.length > 0 ? roles.map((role) => ({ role, query })) : null;

const PATTERNS: Pattern[] = [
  // use <name> to <verb>[ and <verb>…]
  {
    re: new RegExp(`\\buse[ \\t]+${NAME}[ \\t]+to[ \\t]+${VERB_CHAIN}`, 'gi'),
    make: (m) => chainMentions(nameQuery(m[1]), chainRoles(VERB_TO_ROLE, m[2], m[3])),
  },
  // <verb>[ and <verb>…] with <name>   ("build with glm", "review and audit with gemma")
  {
    re: new RegExp(`\\b${VERB_CHAIN}[ \\t]+with[ \\t]+${NAME}`, 'gi'),
    make: (m) => chainMentions(nameQuery(m[3]), chainRoles(VERB_TO_ROLE, m[1], m[2])),
  },
  // let <name> <verb>[ and <verb>…]
  {
    re: new RegExp(`\\blet[ \\t]+${NAME}[ \\t]+${VERB_CHAIN}`, 'gi'),
    make: (m) => chainMentions(nameQuery(m[1]), chainRoles(VERB_TO_ROLE, m[2], m[3])),
  },
  // <name> should/will/is/as [be] [the] <role-person>[ and <role-person>…]
  // ("gemma should be the builder", "qwen is the orchestrator", "glm as reviewer")
  {
    re: new RegExp(`${NAME}[ \\t]+${COPULA}${PERSON_CHAIN}`, 'gi'),
    make: (m) => chainMentions(nameQuery(m[1]), chainRoles(PERSON_TO_ROLE, m[2], m[3])),
  },
  // make <name> [the] <role-person>[ and <role-person>…]   ("make gemma the reviewer")
  {
    re: new RegExp(`\\bmake[ \\t]+${NAME}[ \\t]+(?:the[ \\t]+)?${PERSON_CHAIN}`, 'gi'),
    make: (m) => chainMentions(nameQuery(m[1]), chainRoles(PERSON_TO_ROLE, m[2], m[3])),
  },
  // <role-person>: <name>   ("builder: gemma")
  {
    re: new RegExp(`\\b(${PERSON_ALT})[ \\t]*:[ \\t]*${NAME}`, 'gi'),
    make: (m) => chainMentions(nameQuery(m[2]), chainRoles(PERSON_TO_ROLE, m[1], '')),
  },
  // <name> for <role-noun>[ and <role-noun>…]   ("qwen for review and security")
  {
    re: new RegExp(`${NAME}[ \\t]+for[ \\t]+${NOUN_CHAIN}`, 'gi'),
    make: (m) => chainMentions(nameQuery(m[1]), chainRoles(NOUN_TO_ROLE, m[2], m[3])),
  },
  // <name> to <verb>[ and <verb>…]   ("qwen to orchestrate and build")
  {
    re: new RegExp(`${NAME}[ \\t]+to[ \\t]+${VERB_CHAIN}`, 'gi'),
    make: (m) => chainMentions(nameQuery(m[1]), chainRoles(VERB_TO_ROLE, m[2], m[3])),
  },
  // switch to <name>   (role-less → conversation)
  {
    re: new RegExp(`\\bswitch[ \\t]+to[ \\t]+${NAME}${FOR_ALL}`, 'gi'),
    make: (m) => {
      const q = nameQuery(m[1]);
      return q ? [{ role: 'conversation', query: q }] : null;
    },
  },
  // use <name> [for everything]   (role-less → conversation)
  {
    re: new RegExp(`\\buse[ \\t]+${NAME}${FOR_ALL}`, 'gi'),
    make: (m) => {
      const q = nameQuery(m[1]);
      return q ? [{ role: 'conversation', query: q }] : null;
    },
  },
];

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

interface Span {
  /** All mentions produced by this span — a chained directive yields several. */
  mentions: Mention[];
  start: number;
  end: number;
}

/** Recognize every directive span, higher-priority patterns claiming text first. */
function scan(text: string): Span[] {
  const src = text ?? '';
  const spans: Span[] = [];
  const claimed: boolean[] = new Array(src.length).fill(false);
  const overlaps = (s: number, e: number): boolean => {
    for (let i = s; i < e; i += 1) if (claimed[i]) return true;
    return false;
  };
  for (const { re, make } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (overlaps(start, end)) continue;
      const mentions = make(m);
      if (!mentions || mentions.length === 0) continue;
      for (let i = start; i < end; i += 1) claimed[i] = true;
      spans.push({ mentions, start, end });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/**
 * Parse model-steering directives from a message, in reading order. Conservative:
 * returns [] for ordinary prose that merely contains a verb but no model-name
 * directive shape.
 */
export function parseModelMentions(text: string): Mention[] {
  return scan(text).flatMap((s) => s.mentions);
}

/**
 * Remove recognized directive spans from the text, leaving the "real" request.
 * The host uses the residue to decide whether a message is directive-ONLY (only
 * mentions + whitespace/punctuation remain) and thus should not start a turn.
 * The `mentions` argument is accepted for symmetry but the spans are recomputed
 * from `text` (mentions carry no offsets).
 */
export function stripDirectives(text: string, _mentions?: Mention[]): string {
  const src = text ?? '';
  const spans = scan(src);
  if (spans.length === 0) return src;
  let out = '';
  let cursor = 0;
  for (const s of spans) {
    out += src.slice(cursor, s.start);
    cursor = s.end;
  }
  out += src.slice(cursor);
  return out;
}

/** Conjunctions/fillers that may glue two directives without making a message "real". */
const FILLER = new Set(['and', 'then', 'also', 'plus', 'please', 'or', 'so', 'now']);

/**
 * True when the message is nothing but directives — after stripping the
 * recognized spans, only whitespace, punctuation, and bare conjunctions
 * ("qwen to plan and glm to build") remain.
 */
export function isDirectiveOnly(text: string): boolean {
  const src = text ?? '';
  if (scan(src).length === 0) return false;
  const words = stripDirectives(src)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.every((w) => FILLER.has(w));
}

// ---------------------------------------------------------------------------
// Model matching
// ---------------------------------------------------------------------------

/** Does `q` appear in `s` at the start of a token (start-of-string or after a non-alnum)? */
function tokenStart(s: string, q: string): boolean {
  let from = 0;
  for (;;) {
    const i = s.indexOf(q, from);
    if (i < 0) return false;
    if (i === 0 || !/[a-z0-9]/.test(s[i - 1])) return true;
    from = i + 1;
  }
}

/** Rank a candidate model against a query: 0 exact, 1 token-start, 2 substring, null none. */
function matchRank(q: string, id: string, displayName: string): number | null {
  if (id === q || displayName === q) return 0;
  if (tokenStart(id, q) || tokenStart(displayName, q)) return 1;
  if (id.includes(q) || displayName.includes(q)) return 2;
  return null;
}

/**
 * Find the models best matching a query across every provider's models. Candidates
 * are ranked exact > token-start > substring; all matches at the best rank are
 * returned (so two loaded "qwen" versions both surface), deduped by provider+model.
 */
export function matchModels(query: string, providers: ProviderConfig[]): ModelMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const ranked: Array<ModelMatch & { rank: number }> = [];
  for (const p of providers) {
    for (const m of p.models) {
      const rank = matchRank(q, m.id.toLowerCase(), (m.displayName ?? '').toLowerCase());
      if (rank === null) continue;
      ranked.push({ providerId: p.id, modelId: m.id, label: m.displayName || m.id, rank });
    }
  }
  if (ranked.length === 0) return [];
  const best = Math.min(...ranked.map((c) => c.rank));
  const seen = new Set<string>();
  const out: ModelMatch[] = [];
  for (const c of ranked) {
    if (c.rank !== best) continue;
    const key = `${c.providerId} ${c.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ providerId: c.providerId, modelId: c.modelId, label: c.label });
  }
  return out;
}

/** Convenience: a `ModelMatch` as a `ModelRef`. */
export function toModelRef(match: ModelMatch): ModelRef {
  return { providerId: match.providerId, modelId: match.modelId };
}
