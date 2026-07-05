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
