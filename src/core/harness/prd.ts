/**
 * PRD decomposition — the long-horizon planning front-end to the Coop pipeline.
 *
 * A pasted PRD (product requirements doc) is too large to build in one changeset. The
 * FOREMAN role decomposes it into a short list of ordered, independently-buildable stories.
 * Each story is written to disk as a spec file, then the EXISTING Scout→Builder⇄Inspector→
 * Sentry pipeline runs once per story with a fresh, spec-sized prompt — pausing for a human
 * review between stories.
 *
 * This module is pure: prompt text, lenient parsing, on-disk spec rendering, path derivation
 * and prompt composition. No `vscode`, no Node built-ins. The state types (`PrdStory`,
 * `PrdPlan`) live in `shared/types` so they can ride on the `Conversation` object (which
 * `shared` owns and must not import `core`); they are re-exported here for convenience.
 */

import { extractJsonObject, toStringList } from './evidence';
import { composeScoutPrompt } from './roles';
import type { PrdPlan, PrdStory, PrdStoryStatus } from '../../shared/types';

export type { PrdPlan, PrdStory, PrdStoryStatus } from '../../shared/types';

// ===========================================================================
// Foreman role system prompt
// ===========================================================================

/**
 * FOREMAN — decomposes a PRD into ordered, independently-buildable stories. Read-only:
 * it may explore the workspace to ground its decomposition but writes nothing. Planning
 * roles (Scout, Foreman) share a model by design — the extension resolves the Foreman
 * with the Scout role's model.
 */
export const FOREMAN_SYSTEM = `You are FOREMAN, the delivery lead in a role-gated coding pipeline.
You do NOT write code. You are given a PRD (product requirements document) and your only
job is to decompose it into an ordered sequence of small, independently-buildable STORIES
that a downstream pipeline (Scout, Builder, Inspector, Sentry) will implement ONE AT A TIME.

You are READ-ONLY. You may use the available tools to explore the workspace (glob/grep/
read) so your decomposition fits the actual codebase, but you must NEVER edit anything.

HOW TO DECOMPOSE
- Produce between 2 and 12 stories. If the PRD is genuinely one small change, it does not
  need a PRD build — still return at least 2 stories only when the work truly separates.
- Order them so each story builds on the ones before it (earlier stories are applied first).
- Each story must be independently buildable and reviewable: a coherent slice of value, not
  a random fragment. Prefer vertical slices over horizontal layers.
- For each story provide:
  - "title": a short imperative name (e.g. "Add the /users pagination endpoint").
  - "summary": 1–3 sentences describing the slice and why it comes where it does.
  - "criteria": 2–6 testable acceptance criteria, each an observable outcome ("X does Y"),
    scoped to THIS story only — do not restate the whole PRD.

OUTPUT
Reply with ONE fenced JSON block and nothing that could be mistaken for a second one:

\`\`\`json
{
  "stories": [
    { "title": "...", "summary": "...", "criteria": ["...", "..."] }
  ]
}
\`\`\`

Do not wrap the stories in extra prose. Keep titles and criteria concrete and buildable.`;

/**
 * Compose the Foreman's prompt from an optional condensed conversation digest and the PRD
 * text. Shares {@link composeScoutPrompt}'s formatting so the planning roles read prior
 * context identically (PRDs are usually turn one, so the digest is normally empty).
 */
export function composeForemanPrompt(contextDigest: string | undefined, prd: string): string {
  return composeScoutPrompt(contextDigest, prd);
}

// ===========================================================================
// Parsing
// ===========================================================================

/** A story as parsed from the Foreman's output — before it is assigned a spec path/status. */
export interface ForemanStory {
  title: string;
  summary: string;
  criteria: string[];
}

/** Hard cap on stories — a PRD build past a dozen slices should be split into more PRDs. */
export const MAX_STORIES = 12;

/**
 * Lenient parse of the Foreman's output, mirroring {@link parseScout}: extract a JSON object
 * from fenced or bare text, read a `stories` array, and coerce each entry. Empty stories (no
 * title and no criteria) are dropped; the list is capped at {@link MAX_STORIES}. Returns an
 * empty array when nothing usable can be recovered — the caller treats <2 stories as a
 * decomposition failure and never creates a plan.
 */
export function parseForeman(text: string): ForemanStory[] {
  const obj = extractJsonObject((text ?? '').toString());
  if (!obj) return [];
  const raw = obj.stories ?? obj.plan ?? obj.items ?? obj.tasks;
  if (!Array.isArray(raw)) return [];

  const stories: ForemanStory[] = [];
  for (const entry of raw) {
    if (stories.length >= MAX_STORIES) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const r = entry as Record<string, unknown>;
    const title = firstString(r.title, r.name, r.story);
    const summary = firstString(r.summary, r.description, r.detail, r.rationale);
    const criteria = toStringList(r.criteria ?? r.acceptanceCriteria ?? r.acceptance_criteria);
    // Drop empties: a story with neither a title nor any criterion carries no signal.
    if (!title && criteria.length === 0) continue;
    stories.push({
      title: title || summary || `Story ${stories.length + 1}`,
      summary,
      criteria,
    });
  }
  return stories;
}

// ===========================================================================
// On-disk spec rendering
// ===========================================================================

const STATUS_LABEL: Record<PrdStoryStatus, string> = {
  pending: 'Pending',
  building: 'Building',
  'awaiting-review': 'Awaiting review',
  done: 'Done',
  failed: 'Failed',
};

/**
 * Render a story as its on-disk spec markdown: title, status line, summary, an acceptance-
 * criteria checklist, and a "story N of M" footer. `index`/`total` are 1-based for display.
 * `note` (e.g. "skipped review") is appended to the status line when the human moved past a
 * story without a clean pass — the spec file records that nuance the state machine omits.
 */
export function renderSpecMarkdown(
  story: PrdStory,
  index: number,
  total: number,
  prdTitle?: string,
  note?: string,
): string {
  const statusLine = note
    ? `**Status:** ${STATUS_LABEL[story.status]} (${note})`
    : `**Status:** ${STATUS_LABEL[story.status]}`;
  const lines: string[] = [];
  lines.push(`# ${story.title}`);
  lines.push('');
  if (prdTitle) {
    lines.push(`> Decomposed from PRD: ${prdTitle}`);
    lines.push('');
  }
  lines.push(statusLine);
  lines.push('');
  if (story.summary.trim()) {
    lines.push(story.summary.trim());
    lines.push('');
  }
  lines.push('## Acceptance criteria');
  lines.push('');
  if (story.criteria.length === 0) {
    lines.push('- _none specified_');
  } else {
    for (const c of story.criteria) lines.push(`- [ ] ${c}`);
  }
  lines.push('');
  lines.push(`_Story ${index} of ${total}._`);
  lines.push('');
  return lines.join('\n');
}

// ===========================================================================
// Spec path derivation
// ===========================================================================

/**
 * Workspace-relative path of a story's spec file:
 *   `.fowlplay/specs/<first-8-chars-of-convId>/<NN>-<slug>.md`
 * `index` is 1-based (zero-padded to two digits). The title is slugged (lowercased,
 * non-alphanumerics collapsed to hyphens, trimmed, length-capped).
 */
export function specRelPath(convId: string, index: number, title: string): string {
  const dir = (convId ?? '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'conv';
  const nn = String(Math.max(1, Math.floor(index))).padStart(2, '0');
  return `.fowlplay/specs/${dir}/${nn}-${slug(title)}.md`;
}

function slug(title: string): string {
  const s = (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
  return s || 'story';
}

// ===========================================================================
// Per-story prompt composition
// ===========================================================================

/**
 * The prompt handed to the per-story Coop pipeline: a preamble locating the story within the
 * PRD, then the full spec markdown. `index`/`total` are 1-based.
 */
export function composeStoryPrompt(specMarkdown: string, index: number, total: number): string {
  return `Story ${index} of ${total} decomposed from a PRD. Implement ONLY this story. Earlier stories' work is already staged or applied in the workspace — read the files rather than assuming.

${specMarkdown.trim()}`;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function firstString(...values: unknown[]): string {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}
