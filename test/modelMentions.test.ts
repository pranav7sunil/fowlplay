/**
 * Deterministic model-mention parsing + matching.
 *
 * Covers every grammar pattern, shorthand/ranked matching, and the conservative
 * false-positive guards (ordinary prose that merely contains a verb must NOT
 * produce a directive; a directive whose name matches nothing must matchModels-[]).
 */

import { describe, expect, it } from 'vitest';
import type { ProviderConfig } from '../src/shared/types';
import {
  findUnparsedModelHints,
  isDirectiveOnly,
  matchModels,
  parseModelMentions,
  stripDirectives,
} from '../src/core/agent/modelMentions';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const provider = (id: string, name: string, models: ProviderConfig['models']): ProviderConfig => ({
  id,
  name,
  kind: 'local',
  sdkType: 'openai-completions',
  baseUrl: 'http://localhost/v1',
  requiresApiKey: false,
  models,
});

const PROVIDERS: ProviderConfig[] = [
  provider('ollama', 'Ollama', [
    { id: 'qwen3.6-35b-moe', displayName: 'Qwen3.6-35B-MoE' },
    { id: 'qwen2.5-coder:32b', displayName: 'Qwen2.5 Coder 32B' },
    { id: 'glm-4-9b', displayName: 'GLM-4 9B' },
    { id: 'llama3.1:8b', displayName: 'Llama 3.1 8B' },
  ]),
  provider('anthropic', 'Anthropic', [{ id: 'claude-fable-5', displayName: 'Claude Fable 5' }]),
];

// ---------------------------------------------------------------------------
// Grammar — role-directed patterns
// ---------------------------------------------------------------------------

describe('parseModelMentions — role directives', () => {
  it('"<name> to <verb>" → role from verb', () => {
    expect(parseModelMentions('qwen to orchestrate')).toEqual([{ role: 'scout', query: 'qwen' }]);
    expect(parseModelMentions('glm to build')).toEqual([{ role: 'builder', query: 'glm' }]);
    expect(parseModelMentions('fable to review')).toEqual([{ role: 'inspector', query: 'fable' }]);
    expect(parseModelMentions('glm to audit')).toEqual([{ role: 'sentry', query: 'glm' }]);
  });

  it('"use <name> to <verb>"', () => {
    expect(parseModelMentions('use qwen to orchestrate')).toEqual([{ role: 'scout', query: 'qwen' }]);
    expect(parseModelMentions('use glm to implement the feature')).toEqual([{ role: 'builder', query: 'glm' }]);
  });

  it('"<verb> with <name>"', () => {
    expect(parseModelMentions('build with glm')).toEqual([{ role: 'builder', query: 'glm' }]);
    expect(parseModelMentions('review with fable')).toEqual([{ role: 'inspector', query: 'fable' }]);
  });

  it('"let <name> <verb>"', () => {
    expect(parseModelMentions('let glm build')).toEqual([{ role: 'builder', query: 'glm' }]);
    expect(parseModelMentions('let qwen plan')).toEqual([{ role: 'scout', query: 'qwen' }]);
  });

  it('"<name> for <role-noun>"', () => {
    expect(parseModelMentions('qwen for review')).toEqual([{ role: 'inspector', query: 'qwen' }]);
    expect(parseModelMentions('glm for security')).toEqual([{ role: 'sentry', query: 'glm' }]);
    expect(parseModelMentions('fable for planning')).toEqual([{ role: 'scout', query: 'fable' }]);
    expect(parseModelMentions('use fable for review')).toEqual([{ role: 'inspector', query: 'fable' }]);
  });

  it('maps each verb spelling to the right role', () => {
    expect(parseModelMentions('qwen to plan')[0].role).toBe('scout');
    expect(parseModelMentions('qwen to planning')[0].role).toBe('scout');
    expect(parseModelMentions('qwen to implement')[0].role).toBe('builder');
    expect(parseModelMentions('qwen to building')[0].role).toBe('builder');
    expect(parseModelMentions('qwen to reviewing')[0].role).toBe('inspector');
    expect(parseModelMentions('qwen to inspect')[0].role).toBe('inspector');
    expect(parseModelMentions('qwen to qa')[0].role).toBe('inspector');
    expect(parseModelMentions('qwen to sentry')[0].role).toBe('sentry');
    expect(parseModelMentions('qwen to audit')[0].role).toBe('sentry');
  });

  it('is case-insensitive', () => {
    expect(parseModelMentions('QWEN to ORCHESTRATE')).toEqual([{ role: 'scout', query: 'QWEN' }]);
    expect(parseModelMentions('Build With Glm')).toEqual([{ role: 'builder', query: 'Glm' }]);
  });

  it('captures multi-token / dotted model names (1–3 tokens)', () => {
    expect(parseModelMentions('qwen2.5-coder:32b to build')).toEqual([
      { role: 'builder', query: 'qwen2.5-coder:32b' },
    ]);
  });

  it('recognizes multiple directives in one message', () => {
    expect(parseModelMentions('qwen to orchestrate and glm to build')).toEqual([
      { role: 'scout', query: 'qwen' },
      { role: 'builder', query: 'glm' },
    ]);
  });

  it('chains "and"-joined verbs: one model, several roles', () => {
    expect(parseModelMentions('qwen to orchestrate and build, gemma to review and audit')).toEqual([
      { role: 'scout', query: 'qwen' },
      { role: 'builder', query: 'qwen' },
      { role: 'inspector', query: 'gemma' },
      { role: 'sentry', query: 'gemma' },
    ]);
  });

  it('chains in the "with" and "for" forms too', () => {
    expect(parseModelMentions('review and audit with gemma')).toEqual([
      { role: 'inspector', query: 'gemma' },
      { role: 'sentry', query: 'gemma' },
    ]);
    expect(parseModelMentions('qwen for review and security')).toEqual([
      { role: 'inspector', query: 'qwen' },
      { role: 'sentry', query: 'qwen' },
    ]);
    expect(parseModelMentions('use fable to plan and audit')).toEqual([
      { role: 'scout', query: 'fable' },
      { role: 'sentry', query: 'fable' },
    ]);
  });

  it('a chain stops at a non-verb: "and <name>" starts a new clause, not a chain', () => {
    expect(parseModelMentions('qwen to build and glm to review')).toEqual([
      { role: 'builder', query: 'qwen' },
      { role: 'inspector', query: 'glm' },
    ]);
  });

  it('chained directives are still directive-only messages', () => {
    expect(isDirectiveOnly('qwen to orchestrate and build, gemma to review and audit')).toBe(true);
  });

  it('copula phrasing: "<name> should be the <role-person>"', () => {
    expect(
      parseModelMentions('implement @prd.md . Qwen should be the orchestrator and gemma should be the builder'),
    ).toEqual([
      { role: 'scout', query: 'Qwen' },
      { role: 'builder', query: 'gemma' },
    ]);
    expect(parseModelMentions('gemma is the reviewer and auditor')).toEqual([
      { role: 'inspector', query: 'gemma' },
      { role: 'sentry', query: 'gemma' },
    ]);
    expect(parseModelMentions('glm as builder, qwen as orchestrator')).toEqual([
      { role: 'builder', query: 'glm' },
      { role: 'scout', query: 'qwen' },
    ]);
  });

  it('"make <name> the <role-person>" and "<role-person>: <name>"', () => {
    expect(parseModelMentions('make gemma the reviewer')).toEqual([{ role: 'inspector', query: 'gemma' }]);
    expect(parseModelMentions('builder: gemma')).toEqual([{ role: 'builder', query: 'gemma' }]);
  });

  it('copula guards: pronouns/articles never become model names, prose never triggers', () => {
    expect(parseModelMentions('it should be the builder that runs')).toEqual([]);
    expect(parseModelMentions('we should build the builder with care')).toEqual([]);
    expect(parseModelMentions('the app should be the best')).toEqual([]);
  });

  it('modal + bare verb: "<name> should/will build" → role(s) from the verb', () => {
    expect(parseModelMentions('qwen should build')).toEqual([{ role: 'builder', query: 'qwen' }]);
    expect(parseModelMentions('gemma will review and audit')).toEqual([
      { role: 'inspector', query: 'gemma' },
      { role: 'sentry', query: 'gemma' },
    ]);
    // "also" is tolerated between the modal and the verb.
    expect(parseModelMentions('glm must also plan')).toEqual([{ role: 'scout', query: 'glm' }]);
  });

  it('the exact field failure: copula + modal-verb in one message', () => {
    expect(
      parseModelMentions('gemma should be the orchestrator and planner and qwen should build'),
    ).toEqual([
      { role: 'scout', query: 'gemma' },
      { role: 'builder', query: 'qwen' },
    ]);
  });

  it('copula still wins over modal-verb for "should be the <role-person>"', () => {
    expect(parseModelMentions('gemma should be the builder')).toEqual([{ role: 'builder', query: 'gemma' }]);
  });

  it('modal-verb guards: prose with pronoun/noun subjects never triggers', () => {
    expect(parseModelMentions('it should build on the existing design')).toEqual([]);
    expect(parseModelMentions('this should build quickly')).toEqual([]);
    expect(parseModelMentions('we must implement caching')).toEqual([]);
    expect(parseModelMentions('code should build cleanly')).toEqual([]);
  });

  it('reversed assignment: "(set|assign) [the] <role> to <name>"', () => {
    expect(parseModelMentions('set the orchestrator to gemma')).toEqual([{ role: 'scout', query: 'gemma' }]);
    expect(parseModelMentions('assign the builder to qwen')).toEqual([{ role: 'builder', query: 'qwen' }]);
    expect(parseModelMentions('set planning to gemma')).toEqual([{ role: 'scout', query: 'gemma' }]);
    // A chained role list before "to" dedupes to one mention.
    expect(parseModelMentions('set the orchestrator and planner to gemma')).toEqual([
      { role: 'scout', query: 'gemma' },
    ]);
  });

  it('reversed assignment composes with a following clause', () => {
    expect(parseModelMentions('set the orchestrator and planner to gemma and qwen to build')).toEqual([
      { role: 'scout', query: 'gemma' },
      { role: 'builder', query: 'qwen' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// findUnparsedModelHints — near-miss detection
// ---------------------------------------------------------------------------

describe('findUnparsedModelHints', () => {
  it('fires for a model token + role word that the grammar did not parse', () => {
    const text = 'qwen handles the building please';
    const mentions = parseModelMentions(text);
    expect(mentions).toEqual([]); // grammar missed it
    expect(findUnparsedModelHints(text, mentions, PROVIDERS)).toEqual(['qwen']);
  });

  it('is silent when the directive DID parse (token is inside a claimed span)', () => {
    const text = 'qwen to build';
    const mentions = parseModelMentions(text);
    expect(findUnparsedModelHints(text, mentions, PROVIDERS)).toEqual([]);
  });

  it('is silent for a fully-parsed modal-verb directive', () => {
    const text = 'qwen should build';
    const mentions = parseModelMentions(text);
    expect(findUnparsedModelHints(text, mentions, PROVIDERS)).toEqual([]);
  });

  it('is silent for a model named in ordinary prose with no role word', () => {
    expect(findUnparsedModelHints('qwen wrote this yesterday', [], PROVIDERS)).toEqual([]);
  });

  it('is silent when no token matches a configured model', () => {
    expect(findUnparsedModelHints('please review the design', [], PROVIDERS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Grammar — role-less (conversation) directives
// ---------------------------------------------------------------------------

describe('parseModelMentions — conversation directives', () => {
  it('"use <name>" → conversation', () => {
    expect(parseModelMentions('use qwen')).toEqual([{ role: 'conversation', query: 'qwen' }]);
  });

  it('"switch to <name>" → conversation', () => {
    expect(parseModelMentions('switch to qwen')).toEqual([{ role: 'conversation', query: 'qwen' }]);
  });

  it('"use <name> for everything" → conversation', () => {
    expect(parseModelMentions('use qwen for everything')).toEqual([{ role: 'conversation', query: 'qwen' }]);
  });

  it('requires a leading use/switch-to for role-less directives (no bare "<name>")', () => {
    expect(parseModelMentions('qwen')).toEqual([]);
    expect(parseModelMentions('just qwen please')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// False-positive guards
// ---------------------------------------------------------------------------

describe('parseModelMentions — false-positive guards', () => {
  it('does NOT trigger on ordinary prose containing a verb', () => {
    expect(parseModelMentions('we should build the parser with care')).toEqual([]);
    expect(parseModelMentions('please review this and plan the next steps')).toEqual([]);
    expect(parseModelMentions('implement the login flow')).toEqual([]);
  });

  it('"use caution" parses as a directive but matches no configured model', () => {
    const mentions = parseModelMentions('use caution');
    // Syntactically a role-less directive…
    expect(mentions).toEqual([{ role: 'conversation', query: 'caution' }]);
    // …but nothing matches, so the host would warn and ignore it.
    expect(matchModels('caution', PROVIDERS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// stripDirectives / isDirectiveOnly
// ---------------------------------------------------------------------------

describe('stripDirectives + isDirectiveOnly', () => {
  it('flags directive-only messages', () => {
    expect(isDirectiveOnly('use qwen')).toBe(true);
    expect(isDirectiveOnly('qwen to orchestrate')).toBe(true);
    expect(isDirectiveOnly('qwen to orchestrate and glm to build')).toBe(true);
    expect(isDirectiveOnly('use qwen for everything')).toBe(true);
  });

  it('does not flag mixed or plain messages', () => {
    expect(isDirectiveOnly('qwen to orchestrate, then add a test')).toBe(false);
    expect(isDirectiveOnly('just fix the bug')).toBe(false);
    expect(isDirectiveOnly('')).toBe(false);
  });

  it('removes recognized spans, leaving the real request', () => {
    const rest = stripDirectives('qwen to orchestrate and fix the failing test').trim();
    expect(rest).not.toContain('qwen to orchestrate');
    expect(rest).toContain('fix the failing test');
  });
});

// ---------------------------------------------------------------------------
// matchModels — shorthand & ranking
// ---------------------------------------------------------------------------

describe('matchModels', () => {
  it('shorthand: "fable" → claude-fable-5 (token-start)', () => {
    const m = matchModels('fable', PROVIDERS);
    expect(m).toEqual([{ providerId: 'anthropic', modelId: 'claude-fable-5', label: 'Claude Fable 5' }]);
  });

  it('"qwen" surfaces BOTH loaded qwen models', () => {
    const m = matchModels('qwen', PROVIDERS);
    expect(m.map((x) => x.modelId).sort()).toEqual(['qwen2.5-coder:32b', 'qwen3.6-35b-moe']);
  });

  it('returns [] when nothing matches', () => {
    expect(matchModels('gpt', PROVIDERS)).toEqual([]);
    expect(matchModels('caution', PROVIDERS)).toEqual([]);
  });

  it('ranks exact > token-start > substring', () => {
    const ps = [provider('p', 'P', [{ id: 'coder' }, { id: 'qwen-coder' }, { id: 'aicoderx' }])];
    // Exact wins alone.
    expect(matchModels('coder', ps)).toEqual([{ providerId: 'p', modelId: 'coder', label: 'coder' }]);

    // Without the exact model: token-start beats substring.
    const ps2 = [provider('p', 'P', [{ id: 'qwen-coder' }, { id: 'aicoderx' }])];
    expect(matchModels('coder', ps2)).toEqual([{ providerId: 'p', modelId: 'qwen-coder', label: 'qwen-coder' }]);
  });

  it('matches against displayName as well as id', () => {
    const m = matchModels('moe', PROVIDERS); // "Qwen3.6-35B-MoE" displayName
    expect(m.map((x) => x.modelId)).toContain('qwen3.6-35b-moe');
  });

  it('dedupes by provider+model', () => {
    // A query hitting both id and displayName of the same model yields one entry.
    const ps = [provider('p', 'P', [{ id: 'glm', displayName: 'glm' }])];
    expect(matchModels('glm', ps)).toHaveLength(1);
  });
});
