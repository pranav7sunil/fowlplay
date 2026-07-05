/**
 * Coop harness unit tests — the pipeline state machine + verdict parsing.
 *
 * Uses scripted RoleRunner / ChangesetInspector fakes to drive each pipeline path.
 */

import { describe, expect, it, vi } from 'vitest';
import type { GateCard, HarnessSettings, TokenUsage } from '../src/shared/types';
import {
  ContextExceededError,
  RunawayError,
  runCoopPipeline,
  type ChangesetInspector,
  type CoopResult,
  type RoleRunner,
} from '../src/core/harness/coop';
import { parseVerdict } from '../src/core/harness/evidence';
import { parseScout } from '../src/core/harness/roles';
import { estimateTokens } from '../src/core/agent/contextBudget';

// ---------------------------------------------------------------------------
// Fakes & helpers
// ---------------------------------------------------------------------------

const usage = (i = 1, o = 1, c = 0): TokenUsage => ({
  inputTokens: i,
  outputTokens: o,
  cachedTokens: c,
});

/** A RoleRunner whose reply is chosen per role from scripted responses (FIFO per role). */
function scriptedRunner(script: Partial<Record<string, string[]>>): {
  runner: RoleRunner;
  calls: Array<{ role: string; userPrompt: string }>;
} {
  const queues: Record<string, string[]> = {};
  for (const [role, list] of Object.entries(script)) queues[role] = [...(list ?? [])];
  const calls: Array<{ role: string; userPrompt: string }> = [];
  const runner: RoleRunner = {
    async run({ role, userPrompt }) {
      calls.push({ role, userPrompt });
      const q = queues[role];
      const text = q && q.length > 1 ? q.shift()! : q?.[0] ?? '';
      return { text, usage: usage() };
    },
  };
  return { runner, calls };
}

function fakeInspector(diff = '--- a\n+++ b\n@@\n+added line'): ChangesetInspector {
  return {
    unifiedDiff: () => diff,
    summary: () => ({ filesChanged: 1, additions: 1, deletions: 0 }),
  };
}

const settings = (qasRetryBudget = 2): HarnessSettings => ({
  defaultMode: 'coop',
  qasRetryBudget,
});

/** Collect emitted cards; assert onGate always fires for the final card state. */
function gateCollector() {
  const emitted: GateCard[] = [];
  return { onGate: (c: GateCard) => emitted.push({ ...c }), emitted };
}

const scoutOk = (criteria: string[]) =>
  '```json\n' +
  JSON.stringify({ criteria, plan: ['step one', 'step two'], ambiguous: false }) +
  '\n```';

const approve = '```json\n{"verdict":"approve","findings":[],"evidence":"all criteria met"}\n```';

const rejectWith = (findings: string[]) =>
  '```json\n' +
  JSON.stringify({ verdict: 'reject', findings, evidence: 'criterion unmet' }) +
  '\n```';

/** Token usage the fake Builder loop "spends" — must be counted by the pipeline. */
const BUILDER_USAGE = { inputTokens: 10, outputTokens: 5, cachedTokens: 0 };

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runCoopPipeline — happy path', () => {
  it('passes every gate and ends ready-for-review with correct card order', async () => {
    const { runner } = scriptedRunner({
      scout: [scoutOk(['C1: does X', 'C2: does Y'])],
      inspector: [approve],
      sentry: [approve],
    });
    const { onGate, emitted } = gateCollector();
    const buildStage = vi.fn(async () => BUILDER_USAGE);

    const result = await runCoopPipeline({
      userPrompt: 'add feature X',
      runner,
      inspector: fakeInspector(),
      buildStage,
      settings: settings(),
      onGate,
    });

    expect(result.outcome).toBe('ready-for-review');
    expect(buildStage).toHaveBeenCalledTimes(1);

    // Final card state, in order.
    const roles = result.cards.map((c) => c.role);
    expect(roles).toEqual([
      'scout',
      'stop-the-line',
      'builder',
      'inspector',
      'sentry',
      'hitl',
    ]);
    const statusOf = (role: GateCard['role']) =>
      result.cards.find((c) => c.role === role)?.status;
    expect(statusOf('scout')).toBe('passed');
    expect(statusOf('stop-the-line')).toBe('passed');
    expect(statusOf('builder')).toBe('passed');
    expect(statusOf('inspector')).toBe('passed');
    expect(statusOf('sentry')).toBe('passed');
    expect(statusOf('hitl')).toBe('awaiting'); // terminal "your turn" state, not a spinner

    // Stop-the-line carries the criteria.
    expect(result.cards.find((c) => c.role === 'stop-the-line')?.acceptanceCriteria).toEqual([
      'C1: does X',
      'C2: does Y',
    ]);

    // onGate saw both the running and final transitions for each card.
    const runningThenFinal = emitted.filter((c) => c.role === 'inspector');
    expect(runningThenFinal.map((c) => c.status)).toEqual(['running', 'passed']);

    // Usage accumulates scout + inspector + sentry (3 runner calls @ 1/1) PLUS
    // the Builder loop (BUILDER_USAGE) — the Builder must not be dropped.
    expect(result.usage.inputTokens).toBe(3 + BUILDER_USAGE.inputTokens);
    expect(result.usage.outputTokens).toBe(3 + BUILDER_USAGE.outputTokens);
  });
});

// ---------------------------------------------------------------------------
// Per-role model labels
// ---------------------------------------------------------------------------

describe('runCoopPipeline — modelLabelFor', () => {
  it('stamps each role card with the label from modelLabelFor', async () => {
    const { runner } = scriptedRunner({
      scout: [scoutOk(['C1'])],
      inspector: [approve],
      sentry: [approve],
    });
    const labels: Record<string, string> = {
      scout: 'Qwen-Plan',
      builder: 'GLM-Build',
      inspector: 'Fable-QA',
      sentry: 'Fable-Sec',
    };

    const result = await runCoopPipeline({
      userPrompt: 'do it',
      runner,
      inspector: fakeInspector(),
      buildStage: vi.fn(async () => BUILDER_USAGE),
      settings: settings(),
      onGate: () => {},
      modelLabelFor: (role) => labels[role],
    });

    const labelOf = (role: GateCard['role']) => result.cards.find((c) => c.role === role)?.modelLabel;
    expect(labelOf('scout')).toBe('Qwen-Plan');
    expect(labelOf('builder')).toBe('GLM-Build');
    expect(labelOf('inspector')).toBe('Fable-QA');
    expect(labelOf('sentry')).toBe('Fable-Sec');
    // Synthetic gates carry no model label.
    expect(labelOf('stop-the-line')).toBeUndefined();
    expect(labelOf('hitl')).toBeUndefined();
  });

  it('leaves modelLabel unset when modelLabelFor is omitted', async () => {
    const { runner } = scriptedRunner({
      scout: [scoutOk(['C1'])],
      inspector: [approve],
      sentry: [approve],
    });
    const result = await runCoopPipeline({
      userPrompt: 'do it',
      runner,
      inspector: fakeInspector(),
      buildStage: vi.fn(async () => BUILDER_USAGE),
      settings: settings(),
      onGate: () => {},
    });
    expect(result.cards.every((c) => c.modelLabel === undefined)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Context digest → Scout prompt composition
// ---------------------------------------------------------------------------

describe('runCoopPipeline — contextDigest', () => {
  it('prepends the condensed conversation to the Scout prompt when a digest is provided', async () => {
    const { runner, calls } = scriptedRunner({
      scout: [scoutOk(['C1'])],
      inspector: [approve],
      sentry: [approve],
    });

    await runCoopPipeline({
      userPrompt: 'use those 7 criteria',
      contextDigest: 'user: build the auth flow\nassistant: which provider?',
      runner,
      inspector: fakeInspector(),
      buildStage: vi.fn(async () => BUILDER_USAGE),
      settings: settings(),
      onGate: () => {},
    });

    const scoutPrompt = calls.find((c) => c.role === 'scout')!.userPrompt;
    expect(scoutPrompt).toContain('CONVERSATION SO FAR (condensed):');
    expect(scoutPrompt).toContain('build the auth flow');
    expect(scoutPrompt).toContain('CURRENT REQUEST:');
    expect(scoutPrompt).toContain('use those 7 criteria');
    // The digest precedes the current request.
    expect(scoutPrompt.indexOf('CONVERSATION SO FAR')).toBeLessThan(scoutPrompt.indexOf('CURRENT REQUEST'));
  });

  it('passes the bare request as the Scout prompt when no digest is given', async () => {
    const { runner, calls } = scriptedRunner({
      scout: [scoutOk(['C1'])],
      inspector: [approve],
      sentry: [approve],
    });

    await runCoopPipeline({
      userPrompt: 'add feature X',
      runner,
      inspector: fakeInspector(),
      buildStage: vi.fn(async () => BUILDER_USAGE),
      settings: settings(),
      onGate: () => {},
    });

    expect(calls.find((c) => c.role === 'scout')!.userPrompt).toBe('add feature X');
  });
});

// ---------------------------------------------------------------------------
// Ambiguous scout → blocked
// ---------------------------------------------------------------------------

describe('runCoopPipeline — ambiguous scout', () => {
  it('stops the line with the clarifying question and never builds', async () => {
    const question = 'Which database should the cache use?';
    const { runner } = scriptedRunner({
      scout: [
        '```json\n' +
          JSON.stringify({ criteria: [], plan: [], ambiguous: true, question }) +
          '\n```',
      ],
    });
    const { emitted } = gateCollector();
    const buildStage = vi.fn(async () => BUILDER_USAGE);

    const result = await runCoopPipeline({
      userPrompt: 'add a cache',
      runner,
      inspector: fakeInspector(),
      buildStage,
      settings: settings(),
      onGate: (c) => emitted.push(c),
    });

    expect(result.outcome).toBe('blocked');
    expect(result.question).toBe(question);
    expect(buildStage).not.toHaveBeenCalled();

    // The Scout card itself reads as blocked (not a green "passed") on an ambiguous result.
    expect(result.cards.find((c) => c.role === 'scout')?.status).toBe('blocked');

    const stl = result.cards.find((c) => c.role === 'stop-the-line');
    expect(stl?.status).toBe('blocked');
    expect(stl?.evidence).toContain(question);
    expect(stl?.findings).toContain(question);
    // No builder/inspector/sentry cards were produced.
    expect(result.cards.some((c) => c.role === 'builder')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Inspector rejects once then approves
// ---------------------------------------------------------------------------

describe('runCoopPipeline — inspector route-back then approve', () => {
  it('re-runs the builder with findings and numbers the attempts', async () => {
    const findings = ['criterion 2: missing null check'];
    const { runner } = scriptedRunner({
      scout: [scoutOk(['C1', 'C2'])],
      inspector: [rejectWith(findings), approve],
      sentry: [approve],
    });

    const buildInstructions: string[] = [];
    const buildStage = vi.fn(async (instructions: string): Promise<typeof BUILDER_USAGE> => {
      buildInstructions.push(instructions);
      return BUILDER_USAGE;
    });

    const result = await runCoopPipeline({
      userPrompt: 'implement C1 and C2',
      runner,
      inspector: fakeInspector(),
      buildStage,
      settings: settings(2),
      onGate: () => {},
    });

    expect(result.outcome).toBe('ready-for-review');
    expect(buildStage).toHaveBeenCalledTimes(2);

    // Second build instruction carries the inspector's findings.
    expect(buildInstructions[1]).toContain('missing null check');
    expect(buildInstructions[1]).toMatch(/FIX THESE FINDINGS/i);

    // Attempt numbering across builder + inspector cards.
    const builders = result.cards.filter((c) => c.role === 'builder');
    expect(builders.map((c) => c.attempt)).toEqual([1, 2]);
    const inspectors = result.cards.filter((c) => c.role === 'inspector');
    expect(inspectors.map((c) => c.attempt)).toEqual([1, 2]);
    expect(inspectors.map((c) => c.status)).toEqual(['failed', 'passed']);
    expect(inspectors[0].findings).toEqual(findings);
  });
});

// ---------------------------------------------------------------------------
// Retry budget exhaustion → qas-failed
// ---------------------------------------------------------------------------

describe('runCoopPipeline — retry budget exhaustion', () => {
  it('gives up after budget+1 attempts and reports qas-failed', async () => {
    const { runner } = scriptedRunner({
      scout: [scoutOk(['C1'])],
      // Always reject — one string is reused for every inspector call.
      inspector: [rejectWith(['still broken'])],
      sentry: [approve],
    });
    const buildStage = vi.fn(async () => BUILDER_USAGE);

    const result = await runCoopPipeline({
      userPrompt: 'do the thing',
      runner,
      inspector: fakeInspector(),
      buildStage,
      settings: settings(1), // 1 route-back → 2 total attempts
      onGate: () => {},
    });

    expect(result.outcome).toBe('qas-failed');
    expect(buildStage).toHaveBeenCalledTimes(2);
    const inspectors = result.cards.filter((c) => c.role === 'inspector');
    expect(inspectors).toHaveLength(2);
    expect(inspectors.every((c) => c.status === 'failed')).toBe(true);
    // Sentry never ran — changes stay staged for the human.
    expect(result.cards.some((c) => c.role === 'sentry')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sentry finding → security-blocked (no retry)
// ---------------------------------------------------------------------------

describe('runCoopPipeline — sentry security block', () => {
  it('blocks without any retry when the sentry finds a concern', async () => {
    const { runner } = scriptedRunner({
      scout: [scoutOk(['C1'])],
      inspector: [approve],
      sentry: [
        '```json\n' +
          JSON.stringify({
            verdict: 'block',
            findings: ["config.ts: hard-coded API key at 'const KEY = \"sk-...\"'"],
            evidence: 'secret committed',
          }) +
          '\n```',
      ],
    });
    const buildStage = vi.fn(async () => BUILDER_USAGE);

    const result = await runCoopPipeline({
      userPrompt: 'wire up the client',
      runner,
      inspector: fakeInspector(),
      buildStage,
      settings: settings(),
      onGate: () => {},
    });

    expect(result.outcome).toBe('security-blocked');
    expect(buildStage).toHaveBeenCalledTimes(1); // no security auto-fix retry
    const sentry = result.cards.find((c) => c.role === 'sentry');
    expect(sentry?.status).toBe('blocked');
    expect(sentry?.findings?.[0]).toContain('hard-coded API key');
    // No HITL card — the pipeline halted before human review.
    expect(result.cards.some((c) => c.role === 'hitl')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('runCoopPipeline — cancellation', () => {
  it('returns cancelled when the signal aborts before the scout runs', async () => {
    const controller = new AbortController();
    controller.abort();
    const { runner } = scriptedRunner({ scout: [scoutOk(['C1'])] });
    const buildStage = vi.fn(async () => BUILDER_USAGE);

    const result: CoopResult = await runCoopPipeline({
      userPrompt: 'x',
      runner,
      inspector: fakeInspector(),
      buildStage,
      settings: settings(),
      onGate: () => {},
      signal: controller.signal,
    });

    expect(result.outcome).toBe('cancelled');
    expect(buildStage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Chunked review under a diff budget
// ---------------------------------------------------------------------------

/** Two equal-size single-hunk files; a budget of one file forces a 2-chunk split. */
function twoFileDiff(): { diff: string; oneFileBudget: number } {
  const file = (name: string, ch: string) =>
    [`--- a/${name}`, `+++ b/${name}`, '@@ -1,1 +1,1 @@', `-${ch.repeat(40)}`, `+${ch.repeat(40)}`].join('\n');
  const f1 = file('f1.ts', 'a');
  const f2 = file('f2.ts', 'b');
  return { diff: `${f1}\n${f2}`, oneFileBudget: estimateTokens(f1) };
}

describe('runCoopPipeline — chunked inspector under a diff budget', () => {
  it('reviews each chunk and rejects overall (with unioned findings) when any chunk rejects', async () => {
    const { diff, oneFileBudget } = twoFileDiff();
    const { runner, calls } = scriptedRunner({
      scout: [scoutOk(['C1'])],
      // FIFO across the two chunk calls: first rejects, second rejects (distinct + a dup).
      inspector: [rejectWith(['dup finding', 'part-1 issue']), rejectWith(['dup finding', 'part-2 issue'])],
      sentry: [approve],
    });
    const buildStage = vi.fn(async () => BUILDER_USAGE);

    const result = await runCoopPipeline({
      userPrompt: 'do it',
      runner,
      inspector: fakeInspector(diff),
      buildStage,
      settings: settings(0), // no route-backs → single inspector attempt
      onGate: () => {},
      diffBudgetFor: (role) => (role === 'inspector' ? oneFileBudget : undefined),
    });

    // The inspector ran once per chunk (2 chunks).
    expect(calls.filter((c) => c.role === 'inspector')).toHaveLength(2);
    // Overall rejected → budget exhausted → qas-failed.
    expect(result.outcome).toBe('qas-failed');
    const inspector = result.cards.find((c) => c.role === 'inspector')!;
    expect(inspector.status).toBe('failed');
    // Findings unioned across chunks (deduplicated, order preserved).
    expect(inspector.findings).toEqual(['dup finding', 'part-1 issue', 'part-2 issue']);
    // Evidence notes the chunked review.
    expect(inspector.evidence).toContain('reviewed in 2 parts');
  });

  it('passes to Sentry only when every chunk approves', async () => {
    const { diff, oneFileBudget } = twoFileDiff();
    const { runner, calls } = scriptedRunner({
      scout: [scoutOk(['C1'])],
      inspector: [approve], // reused for both chunk calls → both approve
      sentry: [approve], // reused for both sentry chunk calls
    });

    const result = await runCoopPipeline({
      userPrompt: 'do it',
      runner,
      inspector: fakeInspector(diff),
      buildStage: vi.fn(async () => BUILDER_USAGE),
      settings: settings(),
      onGate: () => {},
      diffBudgetFor: (role) => (role === 'inspector' || role === 'sentry' ? oneFileBudget : undefined),
    });

    expect(result.outcome).toBe('ready-for-review');
    // Both the inspector and the sentry chunked into 2 calls each.
    expect(calls.filter((c) => c.role === 'inspector')).toHaveLength(2);
    expect(calls.filter((c) => c.role === 'sentry')).toHaveLength(2);
    const sentry = result.cards.find((c) => c.role === 'sentry')!;
    expect(sentry.status).toBe('passed');
    expect(sentry.evidence).toContain('reviewed in 2 parts');
  });
});

// ---------------------------------------------------------------------------
// Context-exceeded outcome (Builder cannot fit the newest turn)
// ---------------------------------------------------------------------------

describe('runCoopPipeline — context-exceeded', () => {
  it('emits a blocked Context limit gate and returns context-exceeded when buildStage throws', async () => {
    const { runner } = scriptedRunner({ scout: [scoutOk(['C1'])] });
    const buildStage = vi.fn(async () => {
      throw new ContextExceededError({
        role: 'builder',
        modelLabel: 'Tiny-8k',
        windowTokens: 8000,
        neededTokens: 9000,
        budgetTokens: 6000,
      });
    });

    const result = await runCoopPipeline({
      userPrompt: 'refactor the whole app',
      runner,
      inspector: fakeInspector(),
      buildStage,
      settings: settings(),
      onGate: () => {},
    });

    expect(result.outcome).toBe('context-exceeded');
    expect(result.context?.modelLabel).toBe('Tiny-8k');
    expect(result.context?.windowTokens).toBe(8000);

    const ctxCard = result.cards.find((c) => c.title === 'Context limit')!;
    expect(ctxCard.role).toBe('stop-the-line');
    expect(ctxCard.status).toBe('blocked');
    expect(ctxCard.evidence).toContain('Context window exceeded');

    // The in-flight Builder card was marked failed, and nothing after it ran.
    expect(result.cards.find((c) => c.role === 'builder')?.status).toBe('failed');
    expect(result.cards.some((c) => c.role === 'inspector')).toBe(false);
    expect(result.cards.some((c) => c.role === 'sentry')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Runaway outcome (Builder's own call streamed past the safety cap)
// ---------------------------------------------------------------------------

describe('runCoopPipeline — runaway builder', () => {
  it('fails the Builder card with the runaway evidence and returns the runaway outcome', async () => {
    const { runner } = scriptedRunner({ scout: [scoutOk(['C1'])] });
    const message =
      'Runaway generation halted after ~180k tokens (cap ~8k). Retry the step — consider a larger context window or a different model.';
    const buildStage = vi.fn(async () => {
      throw new RunawayError({ role: 'builder', message });
    });

    const result = await runCoopPipeline({
      userPrompt: 'implement the thing',
      runner,
      inspector: fakeInspector(),
      buildStage,
      settings: settings(),
      onGate: () => {},
    });

    expect(result.outcome).toBe('runaway');

    // The in-flight Builder card is marked failed and carries the runaway evidence.
    const builder = result.cards.find((c) => c.role === 'builder');
    expect(builder?.status).toBe('failed');
    expect(builder?.evidence).toContain('Runaway generation halted');
    expect(builder?.evidence).toContain('180k');

    // Nothing after the Builder ran.
    expect(result.cards.some((c) => c.role === 'inspector')).toBe(false);
    expect(result.cards.some((c) => c.role === 'sentry')).toBe(false);
    expect(result.cards.some((c) => c.role === 'hitl')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verdict parser fixtures
// ---------------------------------------------------------------------------

describe('parseVerdict', () => {
  it('parses a clean fenced JSON block', () => {
    const v = parseVerdict('```json\n{"verdict":"approve","findings":[],"evidence":"ok"}\n```');
    expect(v.verdict).toBe('approve');
    expect(v.evidence).toBe('ok');
  });

  it('parses JSON embedded in surrounding prose without fences', () => {
    const v = parseVerdict(
      'Here is my assessment. {"verdict": "reject", "findings": ["missing test"]} Thanks!',
    );
    expect(v.verdict).toBe('reject');
    expect(v.findings).toEqual(['missing test']);
  });

  it('tolerates single-quoted JSON and trailing commas', () => {
    const v = parseVerdict("{'verdict':'block','findings':['unsafe eval',],'evidence':'danger',}");
    expect(v.verdict).toBe('block');
    expect(v.findings).toEqual(['unsafe eval']);
  });

  it('falls back to a plain-text APPROVE first line', () => {
    const v = parseVerdict('APPROVE\nEverything checks out, criteria all met.');
    expect(v.verdict).toBe('approve');
  });

  it('falls back to a plain-text REJECT keyword', () => {
    const v = parseVerdict('REJECT: the second criterion is not implemented');
    expect(v.verdict).toBe('reject');
  });

  it('defaults to reject on unparseable garbage (fail-safe, never fail-open)', () => {
    const v = parseVerdict('the weather today is quite pleasant and mild');
    expect(v.verdict).toBe('reject');
    expect(v.findings).toContain('could not parse verdict');
  });

  it('never approves an empty response', () => {
    expect(parseVerdict('').verdict).toBe('reject');
  });
});

// ---------------------------------------------------------------------------
// Scout parser fixtures
// ---------------------------------------------------------------------------

describe('parseScout', () => {
  it('parses criteria + plan and marks not-ambiguous', () => {
    const s = parseScout(scoutOk(['C1', 'C2']));
    expect(s.ambiguous).toBe(false);
    expect(s.criteria).toEqual(['C1', 'C2']);
    expect(s.plan).toEqual(['step one', 'step two']);
  });

  it('honours an explicit ambiguous flag with a question', () => {
    const s = parseScout('{"criteria":[],"plan":[],"ambiguous":true,"question":"Which API?"}');
    expect(s.ambiguous).toBe(true);
    expect(s.question).toBe('Which API?');
  });

  it('fails safe to ambiguous when no criteria can be recovered', () => {
    const s = parseScout('sorry, I am not sure what you want');
    expect(s.ambiguous).toBe(true);
    expect(s.question).toBeTruthy();
    expect(s.criteria).toEqual([]);
  });

  it('treats an empty-criteria non-ambiguous response as ambiguous (fail-safe)', () => {
    const s = parseScout('{"criteria":[],"plan":["do it"],"ambiguous":false}');
    expect(s.ambiguous).toBe(true);
  });

  it('extracts a JSON object embedded after a sentence of prose', () => {
    const s = parseScout(
      'Sure — here is the contract for the request. {"criteria":["C1: does X"],"plan":["step"],"ambiguous":false}',
    );
    expect(s.ambiguous).toBe(false);
    expect(s.criteria).toEqual(['C1: does X']);
    expect(s.plan).toEqual(['step']);
  });
});
