/**
 * Coop harness — pipeline state machine.
 *
 * Sequences the verification roles between the user's prompt and the human diff review:
 *
 *   Scout → Stop-the-line gate → Builder ⇄ Inspector (bounded retries) → Sentry → HITL
 *
 * Every stage emits {@link GateCard} updates (running → final) through `onGate`, so the UI
 * can render evidence-based gate cards live. Verdicts are parsed leniently but fail safe.
 *
 * DECOUPLING: this module deliberately does not import the agentic loop or the staging
 * layer. It depends only on two narrow interfaces the extension wires up at runtime:
 * {@link RoleRunner} (a role-prompted model call) and {@link ChangesetInspector} (read
 * access to the staged diff). The real Builder loop is injected as `buildStage`.
 *
 * Pure TypeScript — no `vscode`, no Node built-ins.
 */

import type {
  CoopRole,
  GateCard,
  HarnessSettings,
  TokenUsage,
} from '../../shared/types';
import { fitDiffToBudget } from '../agent/contextBudget';
import {
  createCard,
  joinSections,
  numberedList,
  parseVerdict,
  renderChangeSummary,
  section,
  transition,
  type ParsedVerdict,
  type Verdict,
} from './evidence';
import {
  INSPECTOR_SYSTEM,
  SCOUT_SYSTEM,
  SENTRY_SYSTEM,
  composeBuilderFix,
  composeBuilderInstructions,
  composeInspectorPrompt,
  composeScoutPrompt,
  composeSentryPrompt,
  parseScout,
} from './roles';

// ---------------------------------------------------------------------------
// Injected collaborators (defined here so the harness stays decoupled)
// ---------------------------------------------------------------------------

/** Runs one role-prompted model call/loop and returns its text + token usage. */
export interface RoleRunner {
  run(opts: {
    role: CoopRole;
    system: string;
    userPrompt: string;
    /** Inspector/Sentry get read-only tools; Scout too (it must not edit). */
    readOnly: boolean;
    signal?: AbortSignal;
    /**
     * Throttled live progress: an estimate of the role's streamed output tokens
     * so far, so the pipeline can show a climbing count on the role's RUNNING
     * gate card. Optional — omitted by fakes and callers that don't stream.
     */
    onProgress?: (estOutputTokens: number) => void;
  }): Promise<{ text: string; usage: TokenUsage }>;
}

/** Read-only view of the currently staged changeset. */
export interface ChangesetInspector {
  unifiedDiff(): string;
  summary(): { filesChanged: number; additions: number; deletions: number; previewPath?: string };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CoopPipelineOptions {
  userPrompt: string;
  /**
   * A condensed digest of the conversation so far, prepended to the Scout's prompt so it can
   * read the real goal (and any acceptance criteria the user already gave) before judging
   * ambiguity. Undefined on turn one / empty history. Builder/Inspector/Sentry are unaffected
   * — the Builder already inherits wire history.
   */
  contextDigest?: string;
  runner: RoleRunner;
  inspector: ChangesetInspector;
  /**
   * Runs the real agentic Builder loop with the composed instructions. The extension owns
   * this; the harness only supplies instructions and reads the resulting staged diff back
   * through `inspector`. Returns the Builder's token usage so it is counted toward the
   * conversation totals (the Builder is usually the dominant cost in a Coop turn).
   */
  buildStage: (
    instructions: string,
    signal?: AbortSignal,
    onProgress?: (estOutputTokens: number) => void,
  ) => Promise<TokenUsage>;
  settings: HarnessSettings;
  /** Called on every card transition (create + each status change). */
  onGate: (card: GateCard) => void;
  /**
   * Resolves the display label of the model a given role will run on, so each
   * role's gate card can show which model ran it. Optional — the pipeline itself
   * knows nothing about models; the extension supplies this. Omitting it leaves
   * `modelLabel` unset on cards (existing tests stay green).
   */
  modelLabelFor?: (role: CoopRole) => string | undefined;
  /**
   * Payload token budget a review role (Inspector/Sentry) may spend on the diff,
   * already net of system-prompt / instruction / response overhead. When it
   * returns a number and the diff overflows it, the role runs once per chunk and
   * the verdicts are aggregated. Returning `undefined` (unknown context window)
   * preserves the exact single-call path — the extension supplies this.
   */
  diffBudgetFor?: (role: CoopRole) => number | undefined;
  signal?: AbortSignal;
}

export type CoopOutcome =
  | 'ready-for-review'
  | 'blocked'
  | 'qas-failed'
  | 'security-blocked'
  | 'context-exceeded'
  | 'runaway'
  | 'cancelled';

/** Detail behind a `context-exceeded` outcome, for the caller's user-facing message. */
export interface ContextExceededInfo {
  role: CoopRole;
  modelLabel?: string;
  /** The model's full context window in tokens, when known. */
  windowTokens?: number;
  /** Estimated tokens the (already-trimmed) newest turn needs. */
  neededTokens: number;
  /** The payload budget it had to fit into. */
  budgetTokens: number;
}

/**
 * Thrown from `buildStage` when the newest turn alone cannot fit the Builder's
 * payload budget even after trimming. The pipeline catches it, emits a blocked
 * "Context limit" gate card, and returns the `context-exceeded` outcome.
 */
export class ContextExceededError extends Error {
  constructor(public readonly info: ContextExceededInfo) {
    super('Context window exceeded');
    this.name = 'ContextExceededError';
  }
}

/**
 * Thrown from `buildStage` (via the extension) when the Builder's own call was
 * halted by the client-side runaway failsafe — it streamed past the safety cap
 * without stopping. The pipeline catches it, fails the in-flight Builder card
 * with the runaway evidence, and returns the `runaway` outcome. Mirrors the
 * {@link ContextExceededError} pattern so the harness stays decoupled from the
 * agentic loop (the extension translates the loop-level error into this one).
 */
export class RunawayError extends Error {
  constructor(public readonly info: { role: CoopRole; message: string }) {
    super(info.message);
    this.name = 'RunawayError';
  }
}

export interface CoopResult {
  outcome: CoopOutcome;
  /** Present for `blocked` — the clarifying question to surface to the user. */
  question?: string;
  /** Present for `context-exceeded` — sizes + model for the user-facing message. */
  context?: ContextExceededInfo;
  cards: GateCard[];
  usage: TokenUsage;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function runCoopPipeline(opts: CoopPipelineOptions): Promise<CoopResult> {
  const { userPrompt, contextDigest, runner, inspector, buildStage, settings, onGate, modelLabelFor, diffBudgetFor, signal } = opts;
  const labelFor = (role: CoopRole): string | undefined => modelLabelFor?.(role);

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const cards: GateCard[] = [];
  let idSeq = 0;
  const nextId = (role: string) => `gate-${role}-${(idSeq += 1)}`;

  /** Push a new card or update the existing one (matched by id), then notify. */
  const emit = (card: GateCard): GateCard => {
    const idx = cards.findIndex((c) => c.id === card.id);
    if (idx >= 0) cards[idx] = card;
    else cards.push(card);
    onGate(card);
    return card;
  };

  const addUsage = (u: TokenUsage) => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cachedTokens += u.cachedTokens;
  };

  const aborted = () => Boolean(signal?.aborted);

  /**
   * Live progress on a still-RUNNING role card: re-emit it with a climbing
   * output-token estimate so the user sees generation accumulating (the card
   * renders `usage.outputTokens` as a ↓ count). No-op once the card has settled.
   */
  const bumpCard = (card: GateCard, estOutputTokens: number): void => {
    if (card.status !== 'running' || estOutputTokens <= 0) return;
    emit({ ...card, usage: { inputTokens: 0, outputTokens: estOutputTokens, cachedTokens: 0 } });
  };

  /**
   * Run a read-only review role (Inspector/Sentry) over the diff, splitting it
   * into budget-sized chunks when a budget is supplied and the diff overflows.
   * Each chunk is reviewed sequentially (abort-aware); the verdicts are then
   * aggregated — approve only if EVERY chunk approves, findings unioned. Returns
   * the aggregated verdict, the role's summed usage, and a context note (empty
   * when a single call sufficed).
   */
  const runReview = async (
    role: CoopRole,
    system: string,
    buildPrompt: (chunk: string) => string,
    diff: string,
    onProgress?: (estOutputTokens: number) => void,
  ): Promise<{ verdict: ParsedVerdict; usage: TokenUsage; note: string; aborted: boolean }> => {
    const budget = diffBudgetFor?.(role);
    const fit =
      budget !== undefined ? fitDiffToBudget(diff, budget) : { chunks: [diff], truncated: false };
    const roleUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    const spend = (u: TokenUsage) => {
      roleUsage.inputTokens += u.inputTokens;
      roleUsage.outputTokens += u.outputTokens;
      roleUsage.cachedTokens += u.cachedTokens;
    };

    // Single-call path (no budget, or the whole diff fits): identical to before.
    if (fit.chunks.length <= 1) {
      const run = await runner.run({
        role,
        system,
        userPrompt: buildPrompt(fit.chunks[0] ?? diff),
        readOnly: true,
        signal,
        onProgress,
      });
      spend(run.usage);
      const note = fit.truncated
        ? 'Part of the diff was truncated to fit the model\'s context window.'
        : '';
      return { verdict: parseVerdict(run.text), usage: roleUsage, note, aborted: aborted() };
    }

    // Chunked path: review each part, then aggregate.
    const n = fit.chunks.length;
    const verdicts: ParsedVerdict[] = [];
    for (let i = 0; i < n; i += 1) {
      if (aborted()) {
        return {
          verdict: { verdict: 'reject', findings: [], evidence: '' },
          usage: roleUsage,
          note: '',
          aborted: true,
        };
      }
      const prompt = `(Reviewing part ${i + 1} of ${n} of the changeset — judge only what is present in this part.)\n\n${buildPrompt(fit.chunks[i])}`;
      const run = await runner.run({ role, system, userPrompt: prompt, readOnly: true, signal, onProgress });
      spend(run.usage);
      verdicts.push(parseVerdict(run.text));
    }
    const note = `Diff reviewed in ${n} parts (context budget).${fit.truncated ? ' Part of the diff was truncated to fit.' : ''}`;
    return { verdict: aggregateVerdicts(verdicts), usage: roleUsage, note, aborted: aborted() };
  };

  /** Blocked "Context limit" card + `context-exceeded` result. */
  const contextExceeded = (info: ContextExceededInfo): CoopResult => {
    emit(
      createCard(nextId('ctx'), {
        role: 'stop-the-line',
        title: 'Context limit',
        status: 'blocked',
        modelLabel: info.modelLabel,
        evidence: joinSections(
          section(
            'Context window exceeded',
            `The ${info.role} step's request needs ~${fmtK(info.neededTokens)} tokens but only ~${fmtK(info.budgetTokens)} fit ${info.modelLabel ?? 'the selected model'}'s payload budget${info.windowTokens ? ` (~${fmtK(info.windowTokens)} token window)` : ''}.`,
          ),
          section('What to do', 'Trim the request, start a fresh conversation, or pick a model with a larger context window.'),
        ),
      }),
    );
    return { outcome: 'context-exceeded', context: info, cards, usage };
  };

  /** Finalize on cancellation: mark the in-flight card and return the cancelled result. */
  const cancel = (running?: GateCard): CoopResult => {
    if (running && running.status === 'running') {
      emit(
        transition(running, 'failed', {
          evidence: joinSections(running.evidence, '_Cancelled by user._'),
        }),
      );
    }
    return { outcome: 'cancelled', question: undefined, cards, usage };
  };

  // ---- 1. Scout (BSA), read-only -----------------------------------------
  const scoutCard = emit(
    createCard(nextId('scout'), {
      role: 'scout',
      title: 'Scout — acceptance criteria',
      evidence: 'Restating the request as testable acceptance criteria…',
      modelLabel: labelFor('scout'),
    }),
  );
  if (aborted()) return cancel(scoutCard);

  const scoutRun = await runner.run({
    role: 'scout',
    system: SCOUT_SYSTEM,
    userPrompt: composeScoutPrompt(contextDigest, userPrompt),
    readOnly: true,
    signal,
    onProgress: (t) => bumpCard(scoutCard, t),
  });
  addUsage(scoutRun.usage);
  if (aborted()) return cancel(scoutCard);

  const scout = parseScout(scoutRun.text);
  // An ambiguous (or empty-criteria) result is not a pass — the Scout card must
  // read as blocked, matching the stop-the-line gate that follows it.
  const scoutBlocked = scout.ambiguous || scout.criteria.length === 0;
  emit(
    transition(scoutCard, scoutBlocked ? 'blocked' : 'passed', {
      usage: scoutRun.usage,
      acceptanceCriteria: scout.criteria,
      evidence: scoutBlocked
        ? joinSections(
            section('Assessment', 'Request is ambiguous — raising a clarifying question.'),
            section('Question', scout.question ?? ''),
          )
        : joinSections(
            section('Acceptance criteria', numberedList(scout.criteria)),
            section('Plan', numberedList(scout.plan)),
          ),
    }),
  );

  // ---- 2. Stop-the-line gate ---------------------------------------------
  // Hard gate: no implementation until acceptance criteria exist.
  const gateCard = emit(
    createCard(nextId('stl'), {
      role: 'stop-the-line',
      title: 'Stop-the-line gate',
      evidence: 'Checking that acceptance criteria exist before any code is written…',
    }),
  );
  if (scout.ambiguous || scout.criteria.length === 0) {
    const question = scout.question ?? 'Please clarify the intended scope of the request.';
    emit(
      transition(gateCard, 'blocked', {
        findings: [question],
        evidence: joinSections(
          section('Stopped the line', 'No acceptance criteria — the request needs clarification before work can begin.'),
          section('Clarifying question', question),
        ),
      }),
    );
    return { outcome: 'blocked', question, cards, usage };
  }
  emit(
    transition(gateCard, 'passed', {
      acceptanceCriteria: scout.criteria,
      evidence: joinSections(
        section('Passed', `${scout.criteria.length} acceptance criteria established.`),
        section('Criteria', numberedList(scout.criteria)),
      ),
    }),
  );

  // ---- 3 & 4. Builder ⇄ Inspector (bounded retries) ----------------------
  // qasRetryBudget = number of route-backs; total attempts = budget + 1.
  const maxAttempts = Math.max(1, Math.floor(settings.qasRetryBudget ?? 0) + 1);
  let inspectorFindings: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (aborted()) return cancel();

    // --- Builder: run the real agentic loop with composed instructions ---
    const builderCard = emit(
      createCard(nextId('builder'), {
        role: 'builder',
        title: 'Builder — implementation',
        attempt,
        evidence:
          attempt === 1
            ? 'Implementing against the acceptance criteria…'
            : 'Revising to address Inspector findings…',
        modelLabel: labelFor('builder'),
      }),
    );
    const instructions =
      attempt === 1
        ? composeBuilderInstructions(userPrompt, scout.criteria, scout.plan)
        : composeBuilderFix(userPrompt, scout.criteria, scout.plan, inspectorFindings);

    let builderUsage: TokenUsage;
    try {
      builderUsage = await buildStage(instructions, signal, (t) => bumpCard(builderCard, t));
    } catch (err) {
      if (err instanceof ContextExceededError) {
        // Mark the in-flight Builder card, then emit the Context limit gate.
        emit(
          transition(builderCard, 'failed', {
            attempt,
            evidence: joinSections(builderCard.evidence, '_Halted — request exceeds the context window._'),
          }),
        );
        return contextExceeded(err.info);
      }
      if (err instanceof RunawayError) {
        // The Builder's own call ran away (server ignored max_tokens). Fail the
        // in-flight card with the runaway evidence and end the pipeline; the
        // outcome maps a story to `failed` so the human can retry from clean context.
        emit(
          transition(builderCard, 'failed', {
            attempt,
            evidence: joinSections(builderCard.evidence, section('Runaway generation halted', err.info.message)),
          }),
        );
        return { outcome: 'runaway', cards, usage };
      }
      throw err;
    }
    addUsage(builderUsage);
    if (aborted()) return cancel(builderCard);

    const summary = inspector.summary();
    emit(
      transition(builderCard, 'passed', {
        attempt,
        usage: builderUsage,
        evidence: joinSections(
          section('Changeset', renderChangeSummary(summary)),
          attempt > 1
            ? section('Addressed findings', numberedList(inspectorFindings))
            : '',
        ),
      }),
    );

    // --- Inspector (QAS): independent validation, read-only ---
    if (aborted()) return cancel();
    const inspectorCard = emit(
      createCard(nextId('inspector'), {
        role: 'inspector',
        title: 'Inspector — QA validation',
        attempt,
        evidence: 'Validating the changeset against the acceptance criteria (fresh eyes)…',
        modelLabel: labelFor('inspector'),
      }),
    );
    const diff = inspector.unifiedDiff();
    const inspectorReview = await runReview(
      'inspector',
      INSPECTOR_SYSTEM,
      (chunk) => composeInspectorPrompt(scout.criteria, chunk),
      diff,
      (t) => bumpCard(inspectorCard, t),
    );
    addUsage(inspectorReview.usage);
    if (inspectorReview.aborted) return cancel(inspectorCard);

    const verdict = inspectorReview.verdict;
    if (verdict.verdict === 'approve') {
      emit(
        transition(inspectorCard, 'passed', {
          attempt,
          usage: inspectorReview.usage,
          findings: verdict.findings,
          evidence: joinSections(
            verdictEvidence('All acceptance criteria verified.', verdict),
            inspectorReview.note ? section('Context', inspectorReview.note) : '',
          ),
        }),
      );
      break; // proceed to Sentry
    }

    // Not approved → route back to the Builder if budget remains.
    inspectorFindings =
      verdict.findings.length > 0
        ? verdict.findings
        : ['Inspector did not approve but gave no specific findings; re-examine each acceptance criterion.'];

    const budgetRemains = attempt < maxAttempts;
    emit(
      transition(inspectorCard, 'failed', {
        attempt,
        usage: inspectorReview.usage,
        findings: inspectorFindings,
        evidence: joinSections(
          verdictEvidence(
            budgetRemains
              ? `Routing back to Builder (attempt ${attempt} of ${maxAttempts}).`
              : 'Retry budget exhausted.',
            verdict,
          ),
          inspectorReview.note ? section('Context', inspectorReview.note) : '',
        ),
      }),
    );

    if (!budgetRemains) {
      // Changes remain staged for the human to inspect/salvage.
      return { outcome: 'qas-failed', cards, usage };
    }
    // else: loop re-runs the Builder with the findings appended.
  }

  // ---- 5. Sentry (security): NO retries ----------------------------------
  if (aborted()) return cancel();
  const sentryCard = emit(
    createCard(nextId('sentry'), {
      role: 'sentry',
      title: 'Sentry — security review',
      evidence: 'Reviewing the diff for secrets, injection, and unsafe patterns…',
      modelLabel: labelFor('sentry'),
    }),
  );
  const sentryReview = await runReview(
    'sentry',
    SENTRY_SYSTEM,
    (chunk) => composeSentryPrompt(chunk),
    inspector.unifiedDiff(),
    (t) => bumpCard(sentryCard, t),
  );
  addUsage(sentryReview.usage);
  if (sentryReview.aborted) return cancel(sentryCard);

  const sentryVerdict = sentryReview.verdict;
  if (sentryVerdict.verdict !== 'approve') {
    // Security findings are never auto-fixed — the human decides.
    const findings =
      sentryVerdict.findings.length > 0
        ? sentryVerdict.findings
        : ['Sentry flagged a security concern but gave no specific finding; treat the changeset as suspect.'];
    emit(
      transition(sentryCard, 'blocked', {
        usage: sentryReview.usage,
        findings,
        evidence: joinSections(
          verdictEvidence('Security concern — pipeline halted for human decision.', sentryVerdict),
          sentryReview.note ? section('Context', sentryReview.note) : '',
        ),
      }),
    );
    return { outcome: 'security-blocked', cards, usage };
  }
  emit(
    transition(sentryCard, 'passed', {
      usage: sentryReview.usage,
      findings: sentryVerdict.findings,
      evidence: joinSections(
        verdictEvidence('No security concerns found in the diff.', sentryVerdict),
        sentryReview.note ? section('Context', sentryReview.note) : '',
      ),
    }),
  );

  // ---- 6. HITL gate — the human is the final authority -------------------
  // Created in a terminal `awaiting` state (not `running`) so it renders as a
  // settled "your turn" card rather than a perpetual spinner in live chat and
  // in saved history.
  emit(
    createCard(nextId('hitl'), {
      role: 'hitl',
      title: 'Human review',
      status: 'awaiting',
      evidence: 'Awaiting your diff review — you are the final gate.',
      // Surface a Preview button on the card when the changeset has a previewable entry.
      previewPath: inspector.summary().previewPath,
    }),
  );

  return { outcome: 'ready-for-review', cards, usage };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Aggregate per-chunk review verdicts into one: approve ONLY if every chunk
 * approves; any `block` wins over `reject`; findings are unioned (dedup, order
 * preserved); evidence lists each part's verdict.
 */
function aggregateVerdicts(verdicts: ParsedVerdict[]): ParsedVerdict {
  const allApprove = verdicts.length > 0 && verdicts.every((v) => v.verdict === 'approve');
  const anyBlock = verdicts.some((v) => v.verdict === 'block');
  const verdict: Verdict = allApprove ? 'approve' : anyBlock ? 'block' : 'reject';

  const seen = new Set<string>();
  const findings: string[] = [];
  for (const v of verdicts) {
    for (const f of v.findings) {
      if (!seen.has(f)) {
        seen.add(f);
        findings.push(f);
      }
    }
  }
  const evidence = verdicts
    .map((v, i) => `Part ${i + 1}: ${v.verdict.toUpperCase()}${v.evidence ? ` — ${v.evidence}` : ''}`)
    .join('\n');
  return { verdict, findings, evidence };
}

/** Format a token count with a thousands suffix, e.g. 1234 → "1.2k". */
function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

/** Assemble a role card's evidence markdown from a headline + parsed verdict. */
function verdictEvidence(headline: string, verdict: ParsedVerdict): string {
  return joinSections(
    section('Verdict', `${verdict.verdict.toUpperCase()} — ${headline}`),
    verdict.findings.length > 0 ? section('Findings', numberedList(verdict.findings)) : '',
    verdict.evidence ? section('Evidence', verdict.evidence) : '',
  );
}
