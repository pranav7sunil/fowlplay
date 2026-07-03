import { describe, expect, it, vi } from 'vitest';

import type { ProviderAdapter, WireMessage } from '../src/core/providers/adapter';
import { applyFindReplace } from '../src/core/agent/edits';
import { gcHistory } from '../src/core/agent/contextGc';
import { runAgentLoop } from '../src/core/agent/loop';
import { buildToolSpecs, dispatchToolCall, type ToolHost } from '../src/core/agent/tools';
import type { StreamEvent } from '../src/shared/types';

// --- edits.ts matching ladder ---------------------------------------------

describe('applyFindReplace', () => {
  it('replaces an exact substring match', () => {
    const r = applyFindReplace('const x = 1;\n', 'x = 1', 'x = 2', false);
    expect(r).toEqual({ ok: true, content: 'const x = 2;\n' });
  });

  it('matches after whitespace normalization / line trimming', () => {
    const content = ['function f() {', '    return 1;', '}'].join('\n');
    // find has different indentation than the file.
    const find = ['function f() {', '  return 1;', '}'].join('\n');
    const replace = ['function f() {', '    return 2;', '}'].join('\n');
    const r = applyFindReplace(content, find, replace, false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toContain('return 2;');
  });

  it('matches via anchored fuzzy (interior whitespace differs)', () => {
    const content = ['start(', '  a  +  b', 'end'].join('\n');
    const find = ['start(', 'a+b', 'end'].join('\n');
    const r = applyFindReplace(content, find, 'REPLACED', false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe('REPLACED');
  });

  it('fails with a count when ambiguous and all=false', () => {
    const content = 'foo\nfoo\n';
    const r = applyFindReplace(content, 'foo', 'bar', false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/2 exact matches/);
  });

  it('replaces every occurrence when all=true', () => {
    const r = applyFindReplace('foo foo foo', 'foo', 'bar', true);
    expect(r).toEqual({ ok: true, content: 'bar bar bar' });
  });

  it('returns a nearest miss on total failure', () => {
    const content = ['alpha line one', 'beta line two', 'gamma line three'].join('\n');
    const find = ['beta line two', 'delta line missing'].join('\n');
    const r = applyFindReplace(content, find, 'X', false);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.nearestMiss).toBeDefined();
      expect(r.nearestMiss).toContain('beta line two');
    }
  });
});

// --- tools dispatch --------------------------------------------------------

function makeHost(files: Record<string, string>): ToolHost & { staged: unknown[] } {
  const staged: unknown[] = [];
  return {
    staged,
    async readFile(path) {
      if (!(path in files)) throw new Error(`no such file: ${path}`);
      return files[path];
    },
    async listDir() {
      return [{ name: 'a.ts', kind: 'file' as const }];
    },
    async glob() {
      return ['a.ts'];
    },
    async grep() {
      return [{ path: 'a.ts', line: 3, text: 'match' }];
    },
    async stageEdit(ops) {
      staged.push(...ops);
    },
    async listStaged() {
      return [];
    },
  };
}

describe('tools', () => {
  it('buildToolSpecs exposes the expected toolset', () => {
    const names = buildToolSpecs().map((t) => t.name);
    expect(names).toEqual(['open_files', 'list_dir', 'glob', 'grep', 'edit_files']);
  });

  it('open_files batches reads and marks gcClass file-content', async () => {
    const host = makeHost({ 'a.ts': 'one\ntwo', 'b.ts': 'three' });
    const res = await dispatchToolCall(host, 'open_files', { paths: ['a.ts', 'b.ts'] });
    expect(res.ok).toBe(true);
    expect(res.gcClass).toBe('file-content');
    expect(res.content).toContain('a.ts');
    expect(res.content).toContain('1\tone');
    expect(res.content).toContain('b.ts');
  });

  it('edit_files applies find/replace to staged content', async () => {
    const host = makeHost({ 'a.ts': 'value = 1;' });
    const res = await dispatchToolCall(host, 'edit_files', {
      edits: [{ path: 'a.ts', find: 'value = 1', replace: 'value = 2' }],
    });
    expect(res.ok).toBe(true);
    expect(host.staged).toEqual([{ kind: 'modify', path: 'a.ts', content: 'value = 2;' }]);
  });

  it('edit_files reports per-edit failure with a nearest miss', async () => {
    const host = makeHost({ 'a.ts': 'totally different text' });
    const res = await dispatchToolCall(host, 'edit_files', {
      edits: [{ path: 'a.ts', find: 'nonexistent', replace: 'x' }],
    });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/FAIL/);
  });

  it('returns ok:false for unknown tools', async () => {
    const host = makeHost({});
    const res = await dispatchToolCall(host, 'nope', {});
    expect(res.ok).toBe(false);
    expect(res.content).toContain('Unknown tool');
  });
});

// --- load_skill ------------------------------------------------------------

describe('load_skill tool', () => {
  const metas = [
    { name: 'commit-message', description: 'write a commit message' },
    { name: 'test-writing', description: 'write tests' },
  ];

  function skillHost(bodies: Record<string, string>): ToolHost {
    return {
      ...makeHost({}),
      skills: metas,
      async loadSkill(name: string) {
        return name in bodies ? bodies[name] : null;
      },
    };
  }

  it('is omitted from the toolset when no skills exist (backward-compatible)', () => {
    expect(buildToolSpecs().map((t) => t.name)).not.toContain('load_skill');
    expect(buildToolSpecs({}).map((t) => t.name)).not.toContain('load_skill');
    expect(buildToolSpecs({ skills: [] }).map((t) => t.name)).not.toContain('load_skill');
  });

  it('is appended (with skill names in its description) when skills exist', () => {
    const specs = buildToolSpecs({ skills: metas });
    const loadSkill = specs.find((t) => t.name === 'load_skill');
    expect(loadSkill).toBeDefined();
    expect(loadSkill!.description).toContain('commit-message');
    expect(loadSkill!.description).toContain('test-writing');
    // The base toolset is otherwise untouched.
    expect(specs.slice(0, 5).map((t) => t.name)).toEqual(['open_files', 'list_dir', 'glob', 'grep', 'edit_files']);
  });

  it('dispatch returns the skill body', async () => {
    const host = skillHost({ 'commit-message': 'BODY: how to write a commit' });
    const res = await dispatchToolCall(host, 'load_skill', { name: 'commit-message' });
    expect(res.ok).toBe(true);
    expect(res.content).toBe('BODY: how to write a commit');
    expect(res.gcClass).toBe('other');
  });

  it('dispatch reports an unknown skill and lists available names', async () => {
    const host = skillHost({ 'commit-message': 'x' });
    const res = await dispatchToolCall(host, 'load_skill', { name: 'nope' });
    expect(res.ok).toBe(false);
    expect(res.content).toContain('unknown skill: nope');
    expect(res.content).toContain('commit-message');
    expect(res.content).toContain('test-writing');
  });
});

// --- loop.ts ---------------------------------------------------------------

/** Adapter that replays a scripted list of events per chat() call. */
class ScriptedAdapter implements ProviderAdapter {
  private index = 0;
  constructor(private readonly scripts: StreamEvent[][]) {}
  async *chat(): AsyncIterable<StreamEvent> {
    const script = this.scripts[this.index++] ?? [{ type: 'done', stopReason: 'end' }];
    for (const event of script) yield event;
  }
}

describe('runAgentLoop', () => {
  it('runs a tool round then finishes', async () => {
    const adapter = new ScriptedAdapter([
      // Round 1: request a tool.
      [
        { type: 'tool_call_start', id: 'c1', name: 'open_files' },
        { type: 'tool_call_args', id: 'c1', delta: '{"paths":["a.ts"]}' },
        { type: 'tool_call_end', id: 'c1' },
        { type: 'usage', usage: { inputTokens: 5, outputTokens: 2, cachedTokens: 0 } },
        { type: 'done', stopReason: 'tool_use' },
      ],
      // Round 2: final text.
      [
        { type: 'text', delta: 'All done.' },
        { type: 'usage', usage: { inputTokens: 6, outputTokens: 3, cachedTokens: 1 } },
        { type: 'done', stopReason: 'end' },
      ],
    ]);

    const host = makeHost({ 'a.ts': 'line1\nline2' });
    const seen: StreamEvent[] = [];

    const result = await runAgentLoop({
      adapter,
      baseUrl: 'http://x',
      modelId: 'm',
      system: 'sys',
      history: [{ role: 'user', content: [{ type: 'text', text: 'read a.ts' }] }],
      tools: buildToolSpecs(),
      toolHost: host,
      onEvent: (e) => seen.push(e),
    });

    // Cumulative usage.
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 5, cachedTokens: 1 });

    // Blocks: one tool_call record + final text.
    const toolBlock = result.blocks.find((b) => b.type === 'tool_call');
    expect(toolBlock).toBeDefined();
    if (toolBlock && toolBlock.type === 'tool_call') {
      expect(toolBlock.call.name).toBe('open_files');
      expect(toolBlock.call.ok).toBe(true);
      expect(toolBlock.call.resultSummary).toContain('a.ts');
      expect(toolBlock.call.resultSummary.length).toBeLessThanOrEqual(400);
    }
    const textBlock = result.blocks.find((b) => b.type === 'text');
    expect(textBlock).toEqual({ type: 'text', text: 'All done.' });

    // Wire history: user + assistant(tool_call) + tool(result) + assistant(text).
    expect(result.wireHistory).toHaveLength(4);
    expect(result.wireHistory[1].role).toBe('assistant');
    expect(result.wireHistory[2].role).toBe('tool');
    expect(result.wireHistory[3].role).toBe('assistant');

    // The tool result carries the opened path for context GC.
    const toolMsg = result.wireHistory[2];
    if (toolMsg.role === 'tool') {
      expect(toolMsg.results[0].paths).toEqual(['a.ts']);
      expect(toolMsg.results[0].gcClass).toBe('file-content');
    }

    // Every stream event was forwarded.
    expect(seen.filter((e) => e.type === 'done')).toHaveLength(2);
  });

  it('drops unanswered tool_call parts when cancelled mid-tool-call', async () => {
    // C3: the model started a tool call, then the turn was cancelled before any
    // result could be produced. The persisted history must not end with an
    // assistant tool_call that has no matching tool result.
    const adapter = new ScriptedAdapter([
      [
        { type: 'text', delta: 'let me look' },
        { type: 'tool_call_start', id: 'c1', name: 'open_files' },
        { type: 'tool_call_args', id: 'c1', delta: '{"paths":["a.ts"]}' },
        { type: 'tool_call_end', id: 'c1' },
        { type: 'done', stopReason: 'cancelled' },
      ],
    ]);

    const result = await runAgentLoop({
      adapter,
      baseUrl: 'http://x',
      modelId: 'm',
      system: '',
      history: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      tools: buildToolSpecs(),
      toolHost: makeHost({ 'a.ts': 'x' }),
      onEvent: () => {},
    });

    // No tool result was appended...
    expect(result.wireHistory.some((m) => m.role === 'tool')).toBe(false);
    // ...so no assistant message may carry a tool_call part.
    for (const m of result.wireHistory) {
      if (m.role === 'assistant') {
        expect(m.content.some((p) => p.type === 'tool_call')).toBe(false);
      }
    }
    // The assistant text is still preserved.
    const asst = result.wireHistory[1];
    expect(asst.role).toBe('assistant');
    if (asst.role === 'assistant') {
      expect(asst.content).toEqual([{ type: 'text', text: 'let me look' }]);
    }
  });

  it('stops immediately when the first turn ends without tools', async () => {
    const adapter = new ScriptedAdapter([
      [{ type: 'text', delta: 'hi' }, { type: 'done', stopReason: 'end' }],
    ]);
    const chatSpy = vi.spyOn(adapter, 'chat');
    const result = await runAgentLoop({
      adapter,
      baseUrl: 'http://x',
      modelId: 'm',
      system: '',
      history: [],
      tools: [],
      toolHost: makeHost({}),
      onEvent: () => {},
    });
    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.wireHistory).toHaveLength(1);
    expect(result.blocks).toEqual([{ type: 'text', text: 'hi' }]);
  });
});

// --- contextGc.ts ----------------------------------------------------------

describe('gcHistory', () => {
  it('stubs file/search results from older turns but keeps the last turn intact', () => {
    const messages: WireMessage[] = [
      // Turn 1
      { role: 'user', content: [{ type: 'text', text: 'open a.ts' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c1', name: 'open_files', args: { paths: ['a.ts'] } }],
      },
      {
        role: 'tool',
        results: [
          { toolCallId: 'c1', content: 'big file contents', gcClass: 'file-content', paths: ['a.ts'] },
        ],
      },
      // Turn 2 (last)
      { role: 'user', content: [{ type: 'text', text: 'open b.ts' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_call', id: 'c2', name: 'open_files', args: { paths: ['b.ts'] } }],
      },
      {
        role: 'tool',
        results: [
          { toolCallId: 'c2', content: 'fresh contents', gcClass: 'file-content', paths: ['b.ts'] },
        ],
      },
    ];

    const gc = gcHistory(messages);

    // Old turn's tool result is stubbed.
    const oldTool = gc[2];
    expect(oldTool.role).toBe('tool');
    if (oldTool.role === 'tool') {
      expect(oldTool.results[0].content).toContain('garbage-collected');
    }
    // Last turn is untouched.
    const newTool = gc[5];
    if (newTool.role === 'tool') {
      expect(newTool.results[0].content).toBe('fresh contents');
    }
    // Conversation text preserved.
    expect(gc[0]).toEqual(messages[0]);
    expect(gc[3]).toEqual(messages[3]);
  });

  it('dedups repeated file opens, keeping the newest copy', () => {
    const messages: WireMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'work' }] },
      {
        role: 'tool',
        results: [{ toolCallId: 'a', content: 'OLD a.ts', gcClass: 'file-content', paths: ['a.ts'] }],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'reopening' }] },
      {
        role: 'tool',
        results: [{ toolCallId: 'b', content: 'NEW a.ts', gcClass: 'file-content', paths: ['a.ts'] }],
      },
    ];

    const gc = gcHistory(messages);
    const older = gc[1];
    const newer = gc[3];
    if (older.role === 'tool') expect(older.results[0].content).toContain('garbage-collected');
    if (newer.role === 'tool') expect(newer.results[0].content).toBe('NEW a.ts');
  });

  it('dedups per-path: an older [a,b] open keeps fresh a and b, drops only stale a', () => {
    // C2: older result opened [a,b]; a was re-opened newer. The stale a section
    // must be stubbed, but b (no newer copy) must survive.
    const olderContent = '===== a.ts =====\n1\tstale a body\n\n===== b.ts =====\n1\tb body';
    const newerContent = '===== a.ts =====\n1\tfresh a body';
    const messages: WireMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'work' }] },
      {
        role: 'tool',
        results: [
          { toolCallId: 't1', content: olderContent, gcClass: 'file-content', paths: ['a.ts', 'b.ts'] },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'reopen a' }] },
      {
        role: 'tool',
        results: [
          { toolCallId: 't2', content: newerContent, gcClass: 'file-content', paths: ['a.ts'] },
        ],
      },
    ];

    const gc = gcHistory(messages);

    // Fresh a is untouched.
    const newer = gc[3];
    if (newer.role === 'tool') expect(newer.results[0].content).toBe(newerContent);

    // Older result message is preserved (pairing intact), but its a section is
    // stubbed and its b section is kept verbatim.
    const older = gc[1];
    expect(older.role).toBe('tool');
    if (older.role === 'tool') {
      const content = older.results[0].content;
      expect(content).not.toContain('stale a body'); // no stale a
      expect(content).toContain('garbage-collected'); // a stubbed
      expect(content).toContain('b body'); // fresh b survives
      expect(older.results[0].toolCallId).toBe('t1'); // result not dropped
    }
  });
});
