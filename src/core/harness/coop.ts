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
import {
  createCard,
  joinSections,
  numberedList,
  parseVerdict,
  renderChangeSummary,
  section,
  transition,
  type ParsedVerdict,
} from './evidence';
import {
  INSPECTOR_SYSTEM,
  SCOUT_SYSTEM,
  SENTRY_SYSTEM,
  composeBuilderFix,
  composeBuilderInstructions,
  composeInspectorPrompt,
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
  }): Promise<{ text: string; usage: TokenUsage }>;
}

/** Read-only view of the currently staged changeset. */
export interface ChangesetInspector {
  unifiedDiff(): string;
  summary(): { filesChanged: number; additions: number; deletions: number };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CoopPipelineOptions {
  userPrompt: string;
  runner: RoleRunner;
  inspector: ChangesetInspector;
  /**
   * Runs the real agentic Builder loop with the composed instructions. The extension owns
   * this; the harness only supplies instructions and reads the resulting staged diff back
   * through `inspector`. Returns the Builder's token usage so it is counted toward the
   * conversation totals (the Builder is usually the dominant cost in a Coop turn).
   */
  buildStage: (instructions: string, signal?: AbortSignal) => Promise<TokenUsage>;
  settings: HarnessSettings;
  /** Called on every card transition (create + each status change). */
  onGate: (card: GateCard) => void;
  signal?: AbortSignal;
}

export type CoopOutcome =
  | 'ready-for-review'
  | 'blocked'
  | 'qas-failed'
  | 'security-blocked'
  | 'cancelled';

export interface CoopResult {
  outcome: CoopOutcome;
  /** Present for `blocked` — the clarifying question to surface to the user. */
  question?: string;
  cards: GateCard[];
  usage: TokenUsage;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export async function runCoopPipeline(opts: CoopPipelineOptions): Promise<CoopResult> {
  const { userPrompt, runner, inspector, buildStage, settings, onGate, signal } = opts;

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
    }),
  );
  if (aborted()) return cancel(scoutCard);

  const scoutRun = await runner.run({
    role: 'scout',
    system: SCOUT_SYSTEM,
    userPrompt,
    readOnly: true,
    signal,
  });
  addUsage(scoutRun.usage);
  if (aborted()) return cancel(scoutCard);

  const scout = parseScout(scoutRun.text);
  emit(
    transition(scoutCard, 'passed', {
      acceptanceCriteria: scout.criteria,
      evidence: scout.ambiguous
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
      }),
    );
    const instructions =
      attempt === 1
        ? composeBuilderInstructions(userPrompt, scout.criteria, scout.plan)
        : composeBuilderFix(userPrompt, scout.criteria, scout.plan, inspectorFindings);

    const builderUsage = await buildStage(instructions, signal);
    addUsage(builderUsage);
    if (aborted()) return cancel(builderCard);

    const summary = inspector.summary();
    emit(
      transition(builderCard, 'passed', {
        attempt,
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
      }),
    );
    const diff = inspector.unifiedDiff();
    const inspectorRun = await runner.run({
      role: 'inspector',
      system: INSPECTOR_SYSTEM,
      userPrompt: composeInspectorPrompt(scout.criteria, diff),
      readOnly: true,
      signal,
    });
    addUsage(inspectorRun.usage);
    if (aborted()) return cancel(inspectorCard);

    const verdict = parseVerdict(inspectorRun.text);
    if (verdict.verdict === 'approve') {
      emit(
        transition(inspectorCard, 'passed', {
          attempt,
          findings: verdict.findings,
          evidence: verdictEvidence('All acceptance criteria verified.', verdict),
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
        findings: inspectorFindings,
        evidence: verdictEvidence(
          budgetRemains
            ? `Routing back to Builder (attempt ${attempt} of ${maxAttempts}).`
            : 'Retry budget exhausted.',
          verdict,
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
    }),
  );
  const sentryRun = await runner.run({
    role: 'sentry',
    system: SENTRY_SYSTEM,
    userPrompt: composeSentryPrompt(inspector.unifiedDiff()),
    readOnly: true,
    signal,
  });
  addUsage(sentryRun.usage);
  if (aborted()) return cancel(sentryCard);

  const sentryVerdict = parseVerdict(sentryRun.text);
  if (sentryVerdict.verdict !== 'approve') {
    // Security findings are never auto-fixed — the human decides.
    const findings =
      sentryVerdict.findings.length > 0
        ? sentryVerdict.findings
        : ['Sentry flagged a security concern but gave no specific finding; treat the changeset as suspect.'];
    emit(
      transition(sentryCard, 'blocked', {
        findings,
        evidence: verdictEvidence('Security concern — pipeline halted for human decision.', sentryVerdict),
      }),
    );
    return { outcome: 'security-blocked', cards, usage };
  }
  emit(
    transition(sentryCard, 'passed', {
      findings: sentryVerdict.findings,
      evidence: verdictEvidence('No security concerns found in the diff.', sentryVerdict),
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
    }),
  );

  return { outcome: 'ready-for-review', cards, usage };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Assemble a role card's evidence markdown from a headline + parsed verdict. */
function verdictEvidence(headline: string, verdict: ParsedVerdict): string {
  return joinSections(
    section('Verdict', `${verdict.verdict.toUpperCase()} — ${headline}`),
    verdict.findings.length > 0 ? section('Findings', numberedList(verdict.findings)) : '',
    verdict.evidence ? section('Evidence', verdict.evidence) : '',
  );
}
