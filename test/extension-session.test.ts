/**
 * Extension session-core tests.
 *
 * `vscode` cannot be imported under vitest, so these drive `createSessionCore`
 * directly with in-memory fakes for every host port and a scripted provider
 * adapter. They cover the wiring the extension host is responsible for: the ready
 * handshake, a solo prompt turn that stages an edit, the diff review feedback
 * loop, apply-to-disk, and a coop pipeline emitting gate cards in order.
 */

import { describe, expect, it } from 'vitest';
import type {
  AppearanceSettings,
  ContentBlock,
  Conversation,
  ConversationSummary,
  FowlPlaySettings,
  HarnessMode,
  ProviderConfig,
  StreamEvent,
} from '../src/shared/types';
import type { HostToWebview } from '../src/shared/protocol';
import type { ChatRequest, ProviderAdapter } from '../src/core/providers/adapter';
import {
  createSessionCore,
  type DiskIo,
  type GitPort,
  type HistoryPort,
  type SecretsPort,
  type SessionDeps,
  type SettingsPort,
} from '../src/extension/session';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeIo implements DiskIo {
  files = new Map<string, string>();
  async read(p: string) {
    return this.files.has(p) ? this.files.get(p)! : null;
  }
  async exists(p: string) {
    return this.files.has(p);
  }
  async listDir() {
    return [];
  }
  async glob() {
    return [...this.files.keys()];
  }
  async grep() {
    return [];
  }
  async write(p: string, c: string) {
    this.files.set(p, c);
  }
  async remove(p: string) {
    this.files.delete(p);
  }
}

class FakeSecrets implements SecretsPort {
  map = new Map<string, string>();
  async get(id: string) {
    return this.map.get(id);
  }
  async set(id: string, k: string) {
    this.map.set(id, k);
  }
  async delete(id: string) {
    this.map.delete(id);
  }
}

const PROVIDER: ProviderConfig = {
  id: 'p1',
  name: 'Test Local',
  kind: 'local',
  sdkType: 'openai-completions',
  baseUrl: 'http://localhost:11434/v1',
  requiresApiKey: false,
  models: [{ id: 'm1' }],
};

const APPEARANCE: AppearanceSettings = { fontFamily: 'JetBrains Mono', fontScale: 1, theme: 'inherit' };

class FakeSettings implements SettingsPort {
  providers: ProviderConfig[] = [PROVIDER];
  defaultModel = { providerId: 'p1', modelId: 'm1' };
  constructor(private mode: HarnessMode = 'solo') {}
  async load(): Promise<FowlPlaySettings> {
    return {
      appearance: APPEARANCE,
      harness: { defaultMode: this.mode, qasRetryBudget: 1 },
      providers: this.providers,
      defaultModel: this.defaultModel,
    };
  }
  async saveAppearance() {}
  async saveHarness() {}
  async saveProviders(p: ProviderConfig[]) {
    this.providers = p;
  }
  savedDefault: { providerId: string; modelId: string } | null | undefined = undefined;
  async saveDefaultModel(model: { providerId: string; modelId: string } | null) {
    this.savedDefault = model;
    this.defaultModel = model as typeof this.defaultModel;
  }
}

class FakeHistory implements HistoryPort {
  store = new Map<string, Conversation>();
  async list(query?: string): Promise<ConversationSummary[]> {
    return [...this.store.values()]
      .filter((c) => !query || c.title.toLowerCase().includes(query.toLowerCase()))
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: Object.keys(c.nodes).length }));
  }
  async load(id: string) {
    return this.store.get(id) ?? null;
  }
  async save(conv: Conversation) {
    this.store.set(conv.id, conv);
  }
  async rename(id: string, title: string) {
    const c = this.store.get(id);
    if (c) this.store.set(id, { ...c, title });
  }
  async remove(id: string) {
    this.store.delete(id);
  }
}

const fakeGit: GitPort = {
  async isRepo() {
    return true;
  },
  async commit() {
    return { sha: 'abc1234' };
  },
  async head() {
    return { sha: 'abc1234', branch: 'main' };
  },
};

// ---------------------------------------------------------------------------
// Scripted adapter
// ---------------------------------------------------------------------------

const USAGE: StreamEvent = { type: 'usage', usage: { inputTokens: 5, outputTokens: 3, cachedTokens: 0 } };

function editEvents(path: string, content: string): StreamEvent[] {
  return [
    { type: 'tool_call_start', id: 't1', name: 'edit_files' },
    { type: 'tool_call_args', id: 't1', delta: JSON.stringify({ edits: [{ path, create: content }] }) },
    { type: 'tool_call_end', id: 't1' },
    USAGE,
    { type: 'done', stopReason: 'tool_use' },
  ];
}

function textEvents(text: string): StreamEvent[] {
  return [{ type: 'text', delta: text }, USAGE, { type: 'done', stopReason: 'end' }];
}

/** Adapter that stages `path`/`content` on a build turn and approves every role gate. */
function scriptedAdapter(path = 'foo.txt', content = 'hello\nworld\n'): { adapter: ProviderAdapter; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const adapter: ProviderAdapter = {
    chat(request: ChatRequest) {
      requests.push(request);
      let events: StreamEvent[];
      if (request.system.includes('SCOUT')) {
        events = textEvents(JSON.stringify({ criteria: ['File is created'], plan: ['create file'], ambiguous: false, question: '' }));
      } else if (request.system.includes('INSPECTOR') || request.system.includes('SENTRY')) {
        events = textEvents(JSON.stringify({ verdict: 'approve', findings: [], evidence: 'looks fine' }));
      } else {
        // Builder / solo agent loop: stage the edit, then finish once tool results arrive.
        const hasToolResult = request.messages.some((m) => m.role === 'tool');
        events = hasToolResult ? textEvents('Done — created the file.') : editEvents(path, content);
      }
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
  };
  return { adapter, requests };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeSession(opts: { mode?: HarnessMode; path?: string; content?: string } = {}) {
  const io = new FakeIo();
  const posted: HostToWebview[] = [];
  const { adapter, requests } = scriptedAdapter(opts.path, opts.content);
  const settings = new FakeSettings(opts.mode ?? 'solo');
  const deps: SessionDeps = {
    io,
    secrets: new FakeSecrets(),
    settings,
    history: new FakeHistory(),
    git: fakeGit,
    post: (m) => posted.push(m),
    createAdapter: () => adapter,
    fetchModels: async () => [{ id: 'm1' }],
    clock: () => Date.now(),
  };
  const session = createSessionCore(deps);
  return { session, posted, io, requests, settings };
}

function lastConversation(posted: HostToWebview[]): Conversation | undefined {
  for (let i = posted.length - 1; i >= 0; i--) {
    const m = posted[i];
    if (m.type === 'conversation') return m.conversation;
  }
  return undefined;
}

function assistantLeaf(conv: Conversation) {
  return conv.currentLeafId ? conv.nodes[conv.currentLeafId] : undefined;
}

/** Concatenated text of the last user message in a wire request. */
function userWireText(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m.role === 'user') {
      return m.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('\n');
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session ready handshake', () => {
  it('sends settings then a conversation seeded with the default model', async () => {
    const { session, posted } = makeSession();
    await session.handle({ type: 'ready' });

    expect(posted.some((m) => m.type === 'settings')).toBe(true);
    const conv = lastConversation(posted);
    expect(conv).toBeDefined();
    expect(conv!.model).toEqual({ providerId: 'p1', modelId: 'm1' });
    expect(conv!.harnessMode).toBe('solo');
  });
});

describe('setModel', () => {
  it('persists the picked model as the default so new conversations inherit it', async () => {
    const { session, posted, settings } = makeSession();
    await session.handle({ type: 'ready' });
    const pick = { providerId: 'p1', modelId: 'm2' };
    await session.handle({ type: 'setModel', model: pick });

    // Current conversation reflects the pick...
    expect(lastConversation(posted)!.model).toEqual(pick);
    // ...and it was persisted as the default for future conversations.
    expect(settings.savedDefault).toEqual(pick);
  });
});

describe('solo prompt turn', () => {
  it('streams a turn, stages an edit, and appends a changes block', async () => {
    const { session, posted } = makeSession({ path: 'foo.txt', content: 'hello\nworld\n' });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'create foo.txt' });

    expect(posted.some((m) => m.type === 'turnStarted')).toBe(true);
    expect(posted.some((m) => m.type === 'turnFinished')).toBe(true);
    // A tool call was streamed to the UI.
    expect(posted.some((m) => m.type === 'stream' && m.event.type === 'tool_call_start')).toBe(true);

    const conv = lastConversation(posted)!;
    const leaf = assistantLeaf(conv)!;
    expect(leaf.role).toBe('assistant');
    expect(leaf.blocks.some((b) => b.type === 'changes')).toBe(true);
    // Usage accumulated into the conversation totals.
    expect(conv.usageTotals.inputTokens).toBeGreaterThan(0);
  });

  it('makes the user prompt visible before the turn finishes (no blank-transcript window)', async () => {
    const { session, posted } = makeSession({ path: 'foo.txt', content: 'x\n' });
    await session.handle({ type: 'ready' });
    const before = posted.length;
    await session.handle({ type: 'sendPrompt', text: 'create foo.txt please' });

    const turnFinishedIdx = posted.findIndex((m, i) => i >= before && m.type === 'turnFinished');
    expect(turnFinishedIdx).toBeGreaterThan(-1);
    // A conversation carrying the user's text must be delivered before the turn
    // ends — otherwise the prompt is invisible for the whole (possibly long) turn.
    const userVisibleEarly = posted.slice(before, turnFinishedIdx).some(
      (m) =>
        m.type === 'conversation' &&
        Object.values(m.conversation.nodes).some(
          (n) => n.role === 'user' && n.blocks.some((b) => b.type === 'text' && b.text.includes('create foo.txt please')),
        ),
    );
    expect(userVisibleEarly).toBe(true);
  });
});

describe('edit selection context', () => {
  it('prepends the highlighted region to the prompt once, then does not leak into later turns', async () => {
    const { session, posted, requests } = makeSession({ path: 'foo.txt', content: 'x\n' });
    await session.handle({ type: 'ready' });

    session.receiveSelection({
      path: 'src/auth/login.ts',
      startLine: 10,
      endLine: 14,
      text: 'const token = res.data.token;',
      languageId: 'typescript',
    });
    // receiveSelection surfaces the chip to the webview.
    expect(posted.some((m) => m.type === 'selectionContext' && m.context?.path === 'src/auth/login.ts')).toBe(true);

    const firstReqIdx = requests.length;
    await session.handle({ type: 'sendPrompt', text: 'rename token to session' });

    const firstUserText = userWireText(requests[firstReqIdx]);
    expect(firstUserText).toContain('src/auth/login.ts');       // file path
    expect(firstUserText).toContain('10');                       // start line
    expect(firstUserText).toContain('14');                       // end line
    expect(firstUserText).toContain('const token = res.data.token;'); // selected text
    expect(firstUserText).toContain('rename token to session');  // the user's request

    // The host clears the chip after consuming the selection.
    const clears = posted.filter((m) => m.type === 'selectionContext' && m.context === null);
    expect(clears.length).toBeGreaterThan(0);

    // A follow-up prompt WITHOUT a new selection must not carry stale context.
    const secondReqIdx = requests.length;
    await session.handle({ type: 'sendPrompt', text: 'now add a test' });
    const secondUserText = userWireText(requests[secondReqIdx]);
    expect(secondUserText).toContain('now add a test');
    expect(secondUserText).not.toContain('src/auth/login.ts');
    expect(secondUserText).not.toContain('const token = res.data.token;');
  });

  it('clearSelection drops the pending selection and posts a null chip', async () => {
    const { session, posted, requests } = makeSession({ path: 'foo.txt', content: 'x\n' });
    await session.handle({ type: 'ready' });

    session.receiveSelection({ path: 'a.ts', startLine: 1, endLine: 2, text: 'noop();', languageId: 'typescript' });
    await session.handle({ type: 'clearSelection' });
    expect(posted.some((m) => m.type === 'selectionContext' && m.context === null)).toBe(true);

    const reqIdx = requests.length;
    await session.handle({ type: 'sendPrompt', text: 'do the thing' });
    const userText = userWireText(requests[reqIdx]);
    expect(userText).not.toContain('a.ts');
    expect(userText).not.toContain('noop();');
  });
});

describe('diff review — toggleRevert then sendFeedback', () => {
  it('turns reverted hunks into a revision prompt', async () => {
    const { session, posted } = makeSession({ path: 'foo.txt', content: 'a\nb\nc\n' });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'create foo.txt' });

    await session.handle({ type: 'openDiff' });
    const csMsg = [...posted].reverse().find((m) => m.type === 'changeset' && m.view) as
      | Extract<HostToWebview, { type: 'changeset' }>
      | undefined;
    expect(csMsg?.view).toBeTruthy();
    const hunkId = csMsg!.view!.files[0].hunks[0].id;

    await session.handle({ type: 'toggleRevert', hunkId, reverted: true });
    const before = posted.length;
    await session.handle({ type: 'sendFeedback' });

    // A new user node carrying the feedback prompt was appended and a turn ran.
    const conv = lastConversation(posted.slice(before - 1))!;
    const userNodes = Object.values(conv.nodes).filter((n) => n.role === 'user');
    const feedbackNode = userNodes.find((n) =>
      n.blocks.some((b) => b.type === 'text' && b.text.includes('Do not re-apply these reverted changes')),
    );
    expect(feedbackNode).toBeDefined();
  });
});

describe('applyToDisk', () => {
  it('writes effective ops to disk and clears staging', async () => {
    const { session, posted, io } = makeSession({ path: 'foo.txt', content: 'line1\nline2\n' });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'create foo.txt' });

    await session.handle({ type: 'applyToDisk' });

    expect(io.files.get('foo.txt')).toBe('line1\nline2\n');
    expect(posted.some((m) => m.type === 'applied' && m.committed === false)).toBe(true);
    // Staging is cleared: the latest changeset message carries a null view.
    const lastCs = [...posted].reverse().find((m) => m.type === 'changeset') as
      | Extract<HostToWebview, { type: 'changeset' }>
      | undefined;
    expect(lastCs?.view).toBeNull();
  });
});

describe('View Changes on historical commits', () => {
  it('freezes the committed diff, appends a commit block, and later serves the frozen (not live) diff', async () => {
    const io = new FakeIo();
    const posted: HostToWebview[] = [];
    // Stage v1 on the first turn, v2 on the second — so the live changeset
    // genuinely diverges from the frozen one captured at commit time.
    const contents = ['v1\n', 'v2\n'];
    let turn = 0;
    const adapter: ProviderAdapter = {
      chat(request: ChatRequest) {
        // A turn's continuation call ends in a tool result; its opening call ends
        // in the user prompt. (Checking the LAST message — not `.some` — matters
        // across turns, where earlier turns' tool results linger in history.)
        const last = request.messages[request.messages.length - 1];
        const isContinuation = last?.role === 'tool';
        const content = contents[Math.min(turn, contents.length - 1)];
        const events: StreamEvent[] = isContinuation ? textEvents('done') : editEvents('foo.txt', content);
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    };
    const deps: SessionDeps = {
      io,
      secrets: new FakeSecrets(),
      settings: new FakeSettings('solo'),
      history: new FakeHistory(),
      git: fakeGit,
      post: (m) => posted.push(m),
      createAdapter: () => adapter,
      fetchModels: async () => [{ id: 'm1' }],
      clock: () => Date.now(),
    };
    const session = createSessionCore(deps);

    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'create foo.txt' });
    turn = 1;
    await session.handle({ type: 'applyAndCommit', coAuthor: false });

    // (a) A commit block was appended to the leaf assistant node.
    const conv = lastConversation(posted)!;
    const leaf = assistantLeaf(conv)!;
    const commitBlock = leaf.blocks.find((b): b is Extract<ContentBlock, { type: 'commit' }> => b.type === 'commit');
    expect(commitBlock).toBeDefined();
    const commitId = commitBlock!.commit.changesetId;
    expect(commitId).toBe('cs-abc1234'); // fakeGit returns sha 'abc1234'
    expect(commitBlock!.commit.filesChanged).toBe(1);

    // (b) The frozen view is stored under that id.
    const frozenFirst = conv.committedChangesets?.[commitId];
    expect(frozenFirst).toBeTruthy();
    expect(frozenFirst!.id).toBe(commitId);
    expect(frozenFirst!.files[0].path).toBe('foo.txt');
    const frozenFingerprint = JSON.stringify(frozenFirst!.files);

    // A second turn stages a DIFFERENT edit → the live changeset now diverges.
    await session.handle({ type: 'sendPrompt', text: 'change foo.txt' });

    // (c) Opening the historical diff serves the FIRST frozen view, not the live one.
    const histFrom = posted.length;
    await session.handle({ type: 'openDiff', changesetId: commitId });
    const histMsg = posted.slice(histFrom).find((m) => m.type === 'changeset') as
      | Extract<HostToWebview, { type: 'changeset' }>
      | undefined;
    expect(histMsg?.view).toBeTruthy();
    expect(histMsg!.view!.id).toBe(commitId);
    expect(JSON.stringify(histMsg!.view!.files)).toBe(frozenFingerprint);

    // Sanity: the live changeset (no id) reflects the SECOND edit and differs.
    const liveFrom = posted.length;
    await session.handle({ type: 'openDiff' });
    const liveMsg = posted.slice(liveFrom).find((m) => m.type === 'changeset') as
      | Extract<HostToWebview, { type: 'changeset' }>
      | undefined;
    expect(liveMsg?.view).toBeTruthy();
    expect(JSON.stringify(liveMsg!.view!.files)).not.toBe(frozenFingerprint);
  });
});

describe('skills', () => {
  it('injects the skill catalog into the solo system prompt and offers load_skill', async () => {
    const { session, io, requests } = makeSession({ path: 'foo.txt', content: 'x\n' });
    io.files.set('.fowlplay/skills/foo.md', '---\nname: foo-skill\ndescription: does foo things\n---\n\n# Foo\n\nBody of foo.');
    await session.handle({ type: 'ready' });

    const reqIdx = requests.length;
    await session.handle({ type: 'sendPrompt', text: 'create foo.txt' });

    // The opening request's system prompt carries the catalog (bundled + workspace).
    const sys = requests[reqIdx].system;
    expect(sys).toContain('AVAILABLE SKILLS');
    expect(sys).toContain('foo-skill');
    expect(sys).toContain('does foo things');
    expect(sys).toContain('commit-message'); // a bundled default is present too

    // load_skill is offered as a tool when skills exist.
    expect(requests[reqIdx].tools.map((t) => t.name)).toContain('load_skill');
  });

  it('a load_skill tool call returns the skill body to the model', async () => {
    const io = new FakeIo();
    io.files.set('.fowlplay/skills/foo.md', '---\nname: foo-skill\ndescription: does foo\n---\n\nBODY-OF-FOO-SKILL');
    const posted: HostToWebview[] = [];
    const requests: ChatRequest[] = [];
    // Round 1: call load_skill. Round 2 (after the tool result arrives): finish.
    const adapter: ProviderAdapter = {
      chat(request: ChatRequest) {
        requests.push(request);
        const hasToolResult = request.messages.some((m) => m.role === 'tool');
        const events: StreamEvent[] = hasToolResult
          ? textEvents('done')
          : [
              { type: 'tool_call_start', id: 's1', name: 'load_skill' },
              { type: 'tool_call_args', id: 's1', delta: JSON.stringify({ name: 'foo-skill' }) },
              { type: 'tool_call_end', id: 's1' },
              USAGE,
              { type: 'done', stopReason: 'tool_use' },
            ];
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    };
    const deps: SessionDeps = {
      io,
      secrets: new FakeSecrets(),
      settings: new FakeSettings('solo'),
      history: new FakeHistory(),
      git: fakeGit,
      post: (m) => posted.push(m),
      createAdapter: () => adapter,
      fetchModels: async () => [{ id: 'm1' }],
      clock: () => Date.now(),
    };
    const session = createSessionCore(deps);

    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'use the foo skill' });

    // The continuation request carries the tool result with the skill body.
    const continuation = requests.find((r) => r.messages.some((m) => m.role === 'tool'));
    expect(continuation).toBeDefined();
    const toolMsg = continuation!.messages.find((m) => m.role === 'tool');
    const content = toolMsg && toolMsg.role === 'tool' ? toolMsg.results.map((r) => r.content).join('\n') : '';
    expect(content).toContain('BODY-OF-FOO-SKILL');

    // The tool call was surfaced to the UI and reported ok.
    const toolStream = posted.some((m) => m.type === 'stream' && m.event.type === 'tool_call_start');
    expect(toolStream).toBe(true);
  });
});

describe('coop pipeline', () => {
  it('emits gate cards in Scout → Gate → Builder → Inspector → Sentry → HITL order', async () => {
    const { session, posted } = makeSession({ mode: 'coop', path: 'foo.txt', content: 'x\n' });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'add a feature' });

    const gates = posted.filter((m): m is Extract<HostToWebview, { type: 'gateUpdate' }> => m.type === 'gateUpdate');
    // Distinct cards in first-seen order.
    const order: string[] = [];
    for (const g of gates) if (!order.includes(g.card.id)) order.push(g.card.id);
    const roles = order.map((id) => gates.find((g) => g.card.id === id)!.card.role);
    expect(roles).toEqual(['scout', 'stop-the-line', 'builder', 'inspector', 'sentry', 'hitl']);

    // The final conversation stores the gate cards as blocks and a changes block.
    const conv = lastConversation(posted)!;
    const leaf = assistantLeaf(conv)!;
    expect(leaf.blocks.filter((b) => b.type === 'gate').length).toBe(6);
    expect(leaf.blocks.some((b) => b.type === 'changes')).toBe(true);
    // The Builder loop's usage must be counted, not just the three role calls.
    // Scout+Inspector+Sentry each spend 5in/3out; the Builder loop makes two
    // model calls (edit round + finish round), so totals must exceed 3 calls.
    expect(conv.usageTotals.inputTokens).toBeGreaterThan(3 * 5);
  });
});
