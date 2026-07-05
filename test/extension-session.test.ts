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
  HarnessSettings,
  ModelRef,
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

/** A 2-story Foreman decomposition, returned when `foreman: 'two'`. */
const TWO_STORY_JSON = JSON.stringify({
  stories: [
    { title: 'First story', summary: 'the first slice', criteria: ['story one works'] },
    { title: 'Second story', summary: 'the second slice', criteria: ['story two works'] },
  ],
});

/**
 * Adapter that stages `path`/`content` on a build turn and approves every role gate. When a
 * FOREMAN system prompt arrives it returns a decomposition: two stories (`foreman: 'two'`,
 * the default) or unparseable text (`foreman: 'garbage'`) to exercise the failure path.
 */
function scriptedAdapter(
  path = 'foo.txt',
  content = 'hello\nworld\n',
  foreman: 'two' | 'garbage' = 'two',
): { adapter: ProviderAdapter; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  const adapter: ProviderAdapter = {
    chat(request: ChatRequest) {
      requests.push(request);
      let events: StreamEvent[];
      if (request.system.includes('FOREMAN')) {
        events = textEvents(foreman === 'garbage' ? 'I cannot break this down, sorry.' : TWO_STORY_JSON);
      } else if (request.system.includes('SCOUT')) {
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

function makeSession(opts: { mode?: HarnessMode; path?: string; content?: string; foreman?: 'two' | 'garbage' } = {}) {
  const io = new FakeIo();
  const posted: HostToWebview[] = [];
  const { adapter, requests } = scriptedAdapter(opts.path, opts.content, opts.foreman);
  const settings = new FakeSettings(opts.mode ?? 'solo');
  // Count broadcast triggers so tests can assert which mutations notify siblings.
  const changed = { count: 0 };
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
    onSettingsChanged: () => {
      changed.count += 1;
    },
  };
  const session = createSessionCore(deps);
  return { session, posted, io, requests, settings, changed };
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

describe('fetchModels wiring', () => {
  it('passes the provider kind through and forwards fetched contextWindow to the webview', async () => {
    const posted: HostToWebview[] = [];
    let receivedKind: string | undefined;
    let receivedBaseUrl: string | undefined;
    const deps: SessionDeps = {
      io: new FakeIo(),
      secrets: new FakeSecrets(),
      settings: new FakeSettings('solo'),
      history: new FakeHistory(),
      git: fakeGit,
      post: (m) => posted.push(m),
      createAdapter: () => scriptedAdapter().adapter,
      fetchModels: async (cfg) => {
        receivedKind = cfg.kind;
        receivedBaseUrl = cfg.baseUrl;
        return [{ id: 'm1', contextWindow: 32768 }, { id: 'm2' }];
      },
      clock: () => Date.now(),
    };
    const session = createSessionCore(deps);
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'fetchModels', providerId: 'p1' });

    // The provider's kind (and baseUrl) reach the registry so it can decide to enrich.
    expect(receivedKind).toBe('local');
    expect(receivedBaseUrl).toBe('http://localhost:11434/v1');

    const msg = posted.find(
      (m): m is Extract<HostToWebview, { type: 'modelsFetched' }> => m.type === 'modelsFetched',
    );
    expect(msg?.providerId).toBe('p1');
    expect(msg?.models).toEqual([{ id: 'm1', contextWindow: 32768 }, { id: 'm2' }]);
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

  it('fences a selection that itself contains ``` without breaking out', async () => {
    const { session, requests } = makeSession({ path: 'foo.txt', content: 'x\n' });
    await session.handle({ type: 'ready' });

    // A markdown selection containing its own fenced block.
    const md = 'Example:\n```ts\nconst x = 1;\n```\nEnd.';
    session.receiveSelection({ path: 'README.md', startLine: 1, endLine: 5, text: md, languageId: 'markdown' });

    const idx = requests.length;
    await session.handle({ type: 'sendPrompt', text: 'tighten this doc' });
    const text = userWireText(requests[idx]);
    // The outer fence must be longer than the inner ``` so the selection is
    // fully enclosed and the user's request stays outside the quoted block.
    expect(text).toContain('````'); // >=4 backticks chosen for the wrapper
    expect(text).toContain('const x = 1;');
    expect(text).toContain('tighten this doc');
    // The wrapper fence encloses the inner block: the segment between the first
    // and last 4-backtick runs contains the inner triple-fence and the text.
    const first = text.indexOf('````');
    const last = text.lastIndexOf('````');
    expect(last).toBeGreaterThan(first);
    expect(text.slice(first, last)).toContain('```ts');
  });

  it('re-surfaces a selection delivered before the webview mounted, on ready', async () => {
    const { session, posted } = makeSession({ path: 'foo.txt', content: 'x\n' });
    // Selection arrives BEFORE ready (freshly opened tab); the initial chip post
    // may be dropped by the not-yet-subscribed webview.
    session.receiveSelection({ path: 'a.ts', startLine: 1, endLine: 2, text: 'noop();', languageId: 'typescript' });
    const before = posted.filter((m) => m.type === 'selectionContext' && m.context?.path === 'a.ts').length;
    await session.handle({ type: 'ready' });
    const after = posted.filter((m) => m.type === 'selectionContext' && m.context?.path === 'a.ts').length;
    // ready re-posts the pending chip so it isn't lost.
    expect(after).toBeGreaterThan(before);
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

// ---------------------------------------------------------------------------
// Hard context-window management
// ---------------------------------------------------------------------------

/** A session whose single model optionally advertises a context window. */
function makeWindowSession(opts: { window?: number; mode?: HarnessMode; path?: string; content?: string }) {
  const io = new FakeIo();
  const posted: HostToWebview[] = [];
  const { adapter, requests } = scriptedAdapter(opts.path, opts.content);
  const model = opts.window ? { id: 'm1', contextWindow: opts.window } : { id: 'm1' };
  const provider: ProviderConfig = { ...PROVIDER, models: [model] };
  const mode = opts.mode ?? 'solo';
  const settings: SettingsPort = {
    async load(): Promise<FowlPlaySettings> {
      return {
        appearance: APPEARANCE,
        harness: { defaultMode: mode, qasRetryBudget: 1 },
        providers: [provider],
        defaultModel: { providerId: 'p1', modelId: 'm1' },
      };
    },
    async saveAppearance() {},
    async saveHarness() {},
    async saveProviders() {},
    async saveDefaultModel() {},
  };
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
  return { session: createSessionCore(deps), posted, io, requests };
}

/** Every text payload in a wire request (user text + tool results). */
function allWireText(req: ChatRequest): string {
  return req.messages
    .map((m) =>
      m.role === 'tool'
        ? m.results.map((r) => r.content).join('\n')
        : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n'),
    )
    .join('\n');
}

describe('context-window management', () => {
  // ~4000 tokens each (chars/4); a small-window model must trim one to fit.
  const T1 = `TURN1MARK ${'x'.repeat(16000)}`;
  const T2 = `TURN2MARK ${'x'.repeat(16000)}`;

  it('trims the oldest turn when the conversation model has a small context window', async () => {
    // window 8000 → reserve max(1500, 2000)=2000 → payload budget 6000.
    const { session, requests } = makeWindowSession({ window: 8000, path: 'foo.txt', content: 'hi\n' });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: T1 }); // fits alone (~4k ≤ 6k)

    const idx = requests.length;
    await session.handle({ type: 'sendPrompt', text: T2 }); // now T1+T2 overruns → trim T1
    const first = allWireText(requests[idx]);

    expect(first).toContain('trimmed to fit'); // synthetic note prepended
    expect(first).toContain('TURN2MARK'); // newest turn preserved
    expect(first).not.toContain('TURN1MARK'); // oldest whole turn dropped
  });

  it('a model with no known context window keeps full history (no regression)', async () => {
    const { session, requests } = makeWindowSession({ path: 'foo.txt', content: 'hi\n' }); // no window
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: T1 });

    const idx = requests.length;
    await session.handle({ type: 'sendPrompt', text: T2 });
    const first = allWireText(requests[idx]);

    expect(first).not.toContain('trimmed to fit'); // no budget → no trim
    expect(first).toContain('TURN1MARK'); // full history retained
    expect(first).toContain('TURN2MARK');
  });

  it('surfaces a friendly block when the request exceeds the model context window (coop)', async () => {
    // window 4000 → payload budget 2500; a ~3000-token prompt cannot fit.
    const { session, posted } = makeWindowSession({ window: 4000, mode: 'coop', path: 'foo.txt', content: 'x\n' });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: `refactor everything ${'x'.repeat(12000)}` });

    const conv = lastConversation(posted)!;
    const leaf = assistantLeaf(conv)!;
    const textBlock = leaf.blocks.find(
      (b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text',
    );
    expect(textBlock?.text).toMatch(/exceeds .* context window/);
    expect(textBlock?.text).toContain('4.0k');
    // A blocked Context limit gate card was emitted.
    expect(leaf.blocks.some((b) => b.type === 'gate' && b.card.title === 'Context limit')).toBe(true);
  });

  it('surfaces a friendly error block in solo mode when the request exceeds the window', async () => {
    const { session, posted } = makeWindowSession({ window: 4000, mode: 'solo', path: 'foo.txt', content: 'x\n' });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: `rewrite it all ${'x'.repeat(12000)}` });

    const conv = lastConversation(posted)!;
    const leaf = assistantLeaf(conv)!;
    const errorBlock = leaf.blocks.find(
      (b): b is Extract<ContentBlock, { type: 'error' }> => b.type === 'error',
    );
    expect(errorBlock?.message).toMatch(/exceeds .* context window/);
    // No gate cards in solo mode.
    expect(leaf.blocks.some((b) => b.type === 'gate')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cross-surface settings sync
// ---------------------------------------------------------------------------

const PROVIDER_2: ProviderConfig = {
  id: 'p2',
  name: 'LM Studio',
  kind: 'local',
  sdkType: 'openai-completions',
  baseUrl: 'http://localhost:1234/v1',
  requiresApiKey: false,
  models: [{ id: 'lm-1' }],
};

/** The provider list carried by the last posted `settings` message. */
function lastSettingsProviders(posted: HostToWebview[]): ProviderConfig[] | undefined {
  for (let i = posted.length - 1; i >= 0; i--) {
    const m = posted[i];
    if (m.type === 'settings') return m.settings.providers;
  }
  return undefined;
}

describe('settings mutations notify siblings (onSettingsChanged)', () => {
  it('fires when a provider is added', async () => {
    const { session, changed } = makeSession();
    await session.handle({ type: 'ready' });
    const before = changed.count;
    await session.handle({ type: 'addProvider', provider: PROVIDER_2 });
    expect(changed.count).toBe(before + 1);
  });

  it('fires when a provider is deleted', async () => {
    const { session, changed } = makeSession();
    await session.handle({ type: 'ready' });
    const before = changed.count;
    await session.handle({ type: 'deleteProvider', providerId: 'p1' });
    expect(changed.count).toBe(before + 1);
  });

  it('fires when the model (default) changes', async () => {
    const { session, changed } = makeSession();
    await session.handle({ type: 'ready' });
    const before = changed.count;
    await session.handle({ type: 'setModel', model: { providerId: 'p1', modelId: 'm2' } });
    expect(changed.count).toBe(before + 1);
  });
});

describe('reloadSettings', () => {
  it('re-sends settings reflecting providers written to the store after the cache was warmed', async () => {
    const { session, posted, settings } = makeSession();
    // Warm this session's cache with the original single-provider settings.
    await session.handle({ type: 'ready' });
    expect(lastSettingsProviders(posted)!.map((p) => p.id)).toEqual(['p1']);

    // A sibling surface adds a provider directly to the shared store.
    settings.providers = [PROVIDER, PROVIDER_2];

    const before = posted.length;
    await session.reloadSettings();

    // reloadSettings force-reloads from disk, so the fresh provider is surfaced
    // even though this session had already cached the older list.
    const providers = lastSettingsProviders(posted.slice(before));
    expect(providers).toBeDefined();
    expect(providers!.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  it('adopts a newly written defaultModel into a brand-new, modelless conversation', async () => {
    const { session, posted, settings } = makeSession();
    // Do NOT call ready: the conversation stays brand-new (no leaf, no model).
    settings.defaultModel = { providerId: 'p2', modelId: 'lm-1' };
    settings.providers = [PROVIDER, PROVIDER_2];

    await session.reloadSettings();

    const conv = lastConversation(posted);
    expect(conv).toBeDefined();
    expect(conv!.model).toEqual({ providerId: 'p2', modelId: 'lm-1' });
  });

  it('does not overwrite the model of a conversation that already has one', async () => {
    const { session, posted, settings } = makeSession();
    // ready seeds the conversation with the current default (m1).
    await session.handle({ type: 'ready' });
    expect(lastConversation(posted)!.model).toEqual({ providerId: 'p1', modelId: 'm1' });

    // The store's default changes elsewhere, but this conversation already has a model.
    settings.defaultModel = { providerId: 'p2', modelId: 'lm-1' };
    await session.reloadSettings();

    expect(lastConversation(posted)!.model).toEqual({ providerId: 'p1', modelId: 'm1' });
  });

  it('does not adopt a default model into a conversation that already has messages', async () => {
    const { session, posted, settings } = makeSession({ path: 'foo.txt', content: 'x\n' });
    await session.handle({ type: 'ready' });
    // Send a prompt so the conversation has a leaf, then clear its model to prove
    // the guard keys off currentLeafId (a touched conversation), not just model.
    await session.handle({ type: 'sendPrompt', text: 'create foo.txt' });
    await session.handle({ type: 'deleteProvider', providerId: 'p1' }); // clears conv.model (its provider)
    expect(lastConversation(posted)!.model).toBeNull();

    settings.defaultModel = { providerId: 'p2', modelId: 'lm-1' };
    settings.providers = [PROVIDER, PROVIDER_2];
    await session.reloadSettings();

    // The conversation has messages (a non-null leaf), so the fresh default is
    // NOT adopted — the model stays null.
    expect(lastConversation(posted)!.model).toBeNull();
  });

  it('does not itself trigger a broadcast (no echo loop)', async () => {
    const { session, settings, changed } = makeSession();
    await session.handle({ type: 'ready' });
    settings.providers = [PROVIDER, PROVIDER_2];

    const before = changed.count;
    await session.reloadSettings();
    expect(changed.count).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Per-role model overrides + chat-mention parsing
// ---------------------------------------------------------------------------

/** A provider whose model ids/displayNames drive the resolution + mention tests. */
const P_ROLES: ProviderConfig = {
  id: 'p1',
  name: 'Roles',
  kind: 'local',
  sdkType: 'openai-completions',
  baseUrl: 'http://localhost/v1',
  requiresApiKey: false,
  models: [
    { id: 'm-base' },
    { id: 'm-scout-conv' },
    { id: 'm-scout-settings' },
    { id: 'm-builder', displayName: 'BuilderModel' },
    { id: 'qwen-a', displayName: 'Qwen A' },
    { id: 'qwen-b', displayName: 'Qwen B' },
  ],
};

function makeCustomSession(opts: {
  providers?: ProviderConfig[];
  harness?: HarnessSettings;
  conversation?: Conversation;
  defaultModel?: ModelRef | null;
}) {
  const io = new FakeIo();
  const posted: HostToWebview[] = [];
  const { adapter, requests } = scriptedAdapter();
  const providers = opts.providers ?? [P_ROLES];
  const harness = opts.harness ?? { defaultMode: 'coop', qasRetryBudget: 1 };
  const defaultModel = opts.defaultModel ?? { providerId: 'p1', modelId: 'm-base' };
  const settings: SettingsPort = {
    async load(): Promise<FowlPlaySettings> {
      return { appearance: APPEARANCE, harness, providers, defaultModel };
    },
    async saveAppearance() {},
    async saveHarness() {},
    async saveProviders() {},
    async saveDefaultModel() {},
  };
  const deps: SessionDeps = {
    io,
    secrets: new FakeSecrets(),
    settings,
    history: new FakeHistory(),
    git: fakeGit,
    post: (m) => posted.push(m),
    createAdapter: () => adapter,
    fetchModels: async () => [],
    clock: () => Date.now(),
  };
  const session = createSessionCore(deps, opts.conversation ? { conversation: opts.conversation } : undefined);
  return { session, posted, requests };
}

function coopConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    title: 'test',
    nodes: {},
    rootIds: [],
    currentLeafId: null,
    model: { providerId: 'p1', modelId: 'm-base' },
    harnessMode: 'coop',
    createdAt: 0,
    updatedAt: 0,
    usageTotals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
    ...overrides,
  };
}

/** Which modelId each Coop role's request ran on, keyed off the role system prompt. */
function coopModelIds(requests: ChatRequest[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of requests) {
    if (r.system.includes('SCOUT')) out.scout = r.modelId;
    else if (r.system.includes('INSPECTOR')) out.inspector = r.modelId;
    else if (r.system.includes('SENTRY')) out.sentry = r.modelId;
    else if (out.builder === undefined) out.builder = r.modelId; // Builder/agent loop
  }
  return out;
}

describe('per-role model resolution chain', () => {
  it('resolves conv override > settings override > conv model, and stale overrides fall through', async () => {
    const conversation = coopConversation({
      roleModelOverrides: { scout: { providerId: 'p1', modelId: 'm-scout-conv' } },
    });
    const { session, requests } = makeCustomSession({
      conversation,
      harness: {
        defaultMode: 'coop',
        qasRetryBudget: 1,
        roleModelOverrides: {
          // conv override wins for scout; this settings one should be shadowed.
          scout: { providerId: 'p1', modelId: 'm-scout-settings' },
          // stale — references a model that no longer exists → falls through.
          inspector: { providerId: 'p1', modelId: 'm-deleted' },
        },
      },
    });

    await session.handle({ type: 'sendPrompt', text: 'add a feature' });

    const ids = coopModelIds(requests);
    expect(ids.scout).toBe('m-scout-conv'); // conversation override wins
    expect(ids.builder).toBe('m-base'); // no override anywhere → conv model
    expect(ids.inspector).toBe('m-base'); // stale settings override → falls through
    expect(ids.sentry).toBe('m-base'); // no override → conv model
  });
});

describe('directive-only chat mention', () => {
  it('applies a per-role override and does NOT start a turn', async () => {
    const { session, posted } = makeCustomSession({
      harness: { defaultMode: 'solo', qasRetryBudget: 1 },
    });
    await session.handle({ type: 'ready' });

    const before = posted.length;
    await session.handle({ type: 'sendPrompt', text: 'build with m-builder' });

    // No turn ran.
    expect(posted.slice(before).some((m) => m.type === 'turnStarted')).toBe(false);
    // The override rode onto the conversation.
    const conv = lastConversation(posted)!;
    expect(conv.roleModelOverrides?.builder).toEqual({ providerId: 'p1', modelId: 'm-builder' });
    // A confirmation toast summarizing the assignment was posted.
    expect(
      posted.some((m) => m.type === 'toast' && m.level === 'info' && m.message === 'Builder → BuilderModel'),
    ).toBe(true);
  });

  it('warns and ignores a mention that matches no configured model', async () => {
    const { session, posted } = makeCustomSession({
      harness: { defaultMode: 'solo', qasRetryBudget: 1 },
    });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'use nonexistent-model' });

    expect(posted.some((m) => m.type === 'toast' && m.level === 'warn' && m.message.includes('nonexistent-model'))).toBe(true);
    const conv = lastConversation(posted)!;
    expect(conv.roleModelOverrides).toBeUndefined();
  });
});

describe('ambiguous chat mention', () => {
  it('holds the prompt, then releases it on resolveModelMention with the picked model', async () => {
    const { session, posted } = makeCustomSession({
      harness: { defaultMode: 'solo', qasRetryBudget: 1 },
    });
    await session.handle({ type: 'ready' });

    const before = posted.length;
    // "qwen" matches qwen-a AND qwen-b → ambiguous; trailing prose keeps it a real turn.
    await session.handle({ type: 'sendPrompt', text: 'qwen to build the login page' });

    // A choice was surfaced and the prompt is held (no turn yet).
    const choice = posted.slice(before).find(
      (m): m is Extract<HostToWebview, { type: 'modelMentionChoice' }> => m.type === 'modelMentionChoice',
    );
    expect(choice).toBeDefined();
    expect(choice!.role).toBe('builder');
    expect(choice!.query).toBe('qwen');
    expect(choice!.candidates.map((c) => c.modelId).sort()).toEqual(['qwen-a', 'qwen-b']);
    expect(posted.slice(before).some((m) => m.type === 'turnStarted')).toBe(false);

    // Resolve with a pick → the held prompt runs with the ORIGINAL full text.
    const pick = choice!.candidates[0];
    const beforeResolve = posted.length;
    await session.handle({ type: 'resolveModelMention', role: 'builder', model: { providerId: pick.providerId, modelId: pick.modelId } });

    expect(posted.slice(beforeResolve).some((m) => m.type === 'turnStarted')).toBe(true);
    const conv = lastConversation(posted)!;
    expect(conv.roleModelOverrides?.builder).toEqual({ providerId: pick.providerId, modelId: pick.modelId });
    // The stored user message keeps the original text (mentions not stripped).
    const userNode = Object.values(conv.nodes).find((n) => n.role === 'user');
    expect(userNode?.blocks.some((b) => b.type === 'text' && b.text.includes('qwen to build the login page'))).toBe(true);
  });

  it('a new prompt supersedes a held one — answering the stale picker releases nothing', async () => {
    const { session, posted } = makeCustomSession({
      harness: { defaultMode: 'solo', qasRetryBudget: 1 },
    });
    await session.handle({ type: 'ready' });

    // Ambiguous mention → prompt held behind the picker.
    await session.handle({ type: 'sendPrompt', text: 'qwen to build the login page' });
    expect(posted.some((m) => m.type === 'modelMentionChoice')).toBe(true);

    // The user abandons the picker and sends a plain prompt instead.
    const beforeSecond = posted.length;
    await session.handle({ type: 'sendPrompt', text: 'just fix the typo in README' });
    const turnsAfterSecond = posted.slice(beforeSecond).filter((m) => m.type === 'turnStarted').length;
    expect(turnsAfterSecond).toBe(1);

    // Answering the stale picker now must not release the abandoned prompt.
    const beforeStale = posted.length;
    await session.handle({ type: 'resolveModelMention', role: 'builder', model: { providerId: 'p1', modelId: 'qwen-a' } });
    expect(posted.slice(beforeStale).some((m) => m.type === 'turnStarted')).toBe(false);
    const conv = lastConversation(posted)!;
    expect(conv.roleModelOverrides?.builder).toBeUndefined();
    // The abandoned prompt's text never became a user node.
    expect(
      Object.values(conv.nodes).some(
        (n) => n.role === 'user' && n.blocks.some((b) => b.type === 'text' && b.text.includes('login page')),
      ),
    ).toBe(false);
  });

  it('dismissal (null) sends the prompt without applying any override', async () => {
    const { session, posted } = makeCustomSession({
      harness: { defaultMode: 'solo', qasRetryBudget: 1 },
    });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'qwen to build the login page' });

    const beforeResolve = posted.length;
    await session.handle({ type: 'resolveModelMention', role: 'builder', model: null });

    // The prompt still ran…
    expect(posted.slice(beforeResolve).some((m) => m.type === 'turnStarted')).toBe(true);
    // …with an info toast and NO override applied.
    expect(posted.some((m) => m.type === 'toast' && m.level === 'info' && m.message.includes('without changing'))).toBe(true);
    const conv = lastConversation(posted)!;
    expect(conv.roleModelOverrides?.builder).toBeUndefined();
  });
});

describe('conversation-level model directive persists (JSON round-trip)', () => {
  it('keeps roleModelOverrides through a history save/load', async () => {
    const history = new FakeHistory();
    const io = new FakeIo();
    const posted: HostToWebview[] = [];
    const { adapter } = scriptedAdapter();
    const settings: SettingsPort = {
      async load(): Promise<FowlPlaySettings> {
        return { appearance: APPEARANCE, harness: { defaultMode: 'solo', qasRetryBudget: 1 }, providers: [P_ROLES], defaultModel: { providerId: 'p1', modelId: 'm-base' } };
      },
      async saveAppearance() {},
      async saveHarness() {},
      async saveProviders() {},
      async saveDefaultModel() {},
    };
    const deps: SessionDeps = {
      io, secrets: new FakeSecrets(), settings, history, git: fakeGit,
      post: (m) => posted.push(m), createAdapter: () => adapter, fetchModels: async () => [], clock: () => Date.now(),
    };
    const session = createSessionCore(deps);
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'build with m-builder' }); // directive-only → applies + persists

    // Serialize exactly as persistence does, then reload.
    const saved = [...history.store.values()][0];
    expect(saved).toBeDefined();
    const roundTripped: Conversation = JSON.parse(JSON.stringify(saved));
    expect(roundTripped.roleModelOverrides?.builder).toEqual({ providerId: 'p1', modelId: 'm-builder' });
  });
});

// ---------------------------------------------------------------------------
// PRD builds (Foreman decomposition → per-story build loop)
// ---------------------------------------------------------------------------

/** Roles of the distinct gate cards emitted so far, in first-seen order. */
function gateRoles(posted: HostToWebview[]): string[] {
  const gates = posted.filter(
    (m): m is Extract<HostToWebview, { type: 'gateUpdate' }> => m.type === 'gateUpdate',
  );
  const order: string[] = [];
  for (const g of gates) if (!order.includes(g.card.id)) order.push(g.card.id);
  return order.map((id) => gates.find((g) => g.card.id === id)!.card.role);
}

/** The synthetic user nodes ("Continue to story N: …") on the current conversation. */
function continueNodes(conv: Conversation): string[] {
  return Object.values(conv.nodes)
    .filter((n) => n.role === 'user')
    .map((n) => n.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''))
    .filter((t) => t.startsWith('Continue to story'));
}

describe('PRD build turn', () => {
  it('decomposes the PRD, writes a spec per story, sets the plan, and builds story 1 to awaiting-review', async () => {
    const { session, posted, io } = makeSession({ mode: 'coop', path: 'foo.txt', content: 'x\n' });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'Build the whole thing per this PRD…', prd: true });

    // Two spec files were written directly to disk (not staged).
    const specs = [...io.files.keys()].filter((p) => p.startsWith('.fowlplay/specs/'));
    expect(specs).toHaveLength(2);
    expect(io.files.get(specs[0])).toContain('First story');
    expect(io.files.get(specs[1])).toContain('Second story');

    // The plan rode onto the conversation with two stories, cursor at 0.
    const conv = lastConversation(posted)!;
    expect(conv.prdPlan?.stories).toHaveLength(2);
    expect(conv.prdPlan?.cursor).toBe(0);
    expect(conv.prdPlan?.stories[0].status).toBe('awaiting-review'); // story 1 built to review
    expect(conv.prdPlan?.stories[1].status).toBe('pending');

    // Foreman + full pipeline cards were emitted; a plan block marker sits in the node.
    const roles = gateRoles(posted);
    expect(roles).toEqual(['foreman', 'scout', 'stop-the-line', 'builder', 'inspector', 'sentry', 'hitl']);
    const leaf = assistantLeaf(conv)!;
    expect(leaf.blocks.some((b) => b.type === 'plan')).toBe(true);
    expect(leaf.blocks.some((b) => b.type === 'gate' && b.card.role === 'foreman')).toBe(true);
    // Story 1 staged a change → a changes block was appended.
    expect(leaf.blocks.some((b) => b.type === 'changes')).toBe(true);
  });

  it('blocks the Foreman card and creates no plan when decomposition fails', async () => {
    const { session, posted, io } = makeSession({ mode: 'coop', path: 'foo.txt', content: 'x\n', foreman: 'garbage' });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'a vague half-idea', prd: true });

    const conv = lastConversation(posted)!;
    expect(conv.prdPlan).toBeUndefined(); // no plan
    // No spec files written.
    expect([...io.files.keys()].some((p) => p.startsWith('.fowlplay/specs/'))).toBe(false);

    // The Foreman card is blocked; no downstream role cards ran.
    const roles = gateRoles(posted);
    expect(roles).toEqual(['foreman']);
    const foreman = posted
      .filter((m): m is Extract<HostToWebview, { type: 'gateUpdate' }> => m.type === 'gateUpdate')
      .map((m) => m.card)
      .filter((c) => c.role === 'foreman')
      .pop();
    expect(foreman?.status).toBe('blocked');
    const leaf = assistantLeaf(conv)!;
    expect(leaf.blocks.some((b) => b.type === 'text' && b.text.toLowerCase().includes('could not decompose'))).toBe(true);
    expect(leaf.blocks.some((b) => b.type === 'plan')).toBe(false);
  });

  it('continueStoryLoop marks story 1 done, appends a synthetic user node, and builds story 2', async () => {
    const { session, posted } = makeSession({ mode: 'coop', path: 'foo.txt', content: 'x\n' });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'PRD text', prd: true });

    const before = posted.length;
    await session.handle({ type: 'continueStoryLoop' });

    const conv = lastConversation(posted)!;
    expect(conv.prdPlan?.cursor).toBe(1);
    expect(conv.prdPlan?.stories[0].status).toBe('done');
    expect(conv.prdPlan?.stories[1].status).toBe('awaiting-review'); // story 2 built to review
    // A synthetic "Continue to story 2" user node was appended and a turn ran.
    expect(continueNodes(conv)).toEqual(['Continue to story 2: Second story']);
    expect(posted.slice(before).some((m) => m.type === 'turnStarted')).toBe(true);
    // The second story's pipeline cards ran again (a fresh set of gate ids).
    expect(posted.slice(before).some((m) => m.type === 'gateUpdate' && m.card.role === 'scout')).toBe(true);
  });

  it('a second continue completes the plan with a summary block and no further story turn', async () => {
    const { session, posted } = makeSession({ mode: 'coop', path: 'foo.txt', content: 'x\n' });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'PRD text', prd: true });
    await session.handle({ type: 'continueStoryLoop' }); // story 1 → done, build story 2

    const before = posted.length;
    await session.handle({ type: 'continueStoryLoop' }); // story 2 → done, plan complete

    const conv = lastConversation(posted)!;
    expect(conv.prdPlan?.cursor).toBe(2);
    expect(conv.prdPlan?.stories.every((s) => s.status === 'done')).toBe(true);
    // No new story turn ran; a completion summary was appended instead.
    expect(posted.slice(before).some((m) => m.type === 'turnStarted')).toBe(false);
    const leaf = assistantLeaf(conv)!;
    expect(leaf.blocks.some((b) => b.type === 'text' && b.text.includes('PRD build complete'))).toBe(true);
  });

  it('resets a story cancelled mid-pipeline to pending (retryable)', async () => {
    const io = new FakeIo();
    const posted: HostToWebview[] = [];
    let unblock: () => void = () => {};
    const blocker = new Promise<void>((res) => {
      unblock = res;
    });
    // Block the Builder loop of story 1 so the pipeline hangs after the plan is set (story
    // 'building'); cancel while blocked, then release. The pipeline's post-build abort check
    // yields a cancelled outcome → the story must reset to 'pending', never left 'building'.
    const adapter: ProviderAdapter = {
      chat(request: ChatRequest) {
        let events: StreamEvent[];
        let block = false;
        if (request.system.includes('FOREMAN')) events = textEvents(TWO_STORY_JSON);
        else if (request.system.includes('SCOUT')) events = textEvents(JSON.stringify({ criteria: ['x'], plan: [], ambiguous: false }));
        else if (request.system.includes('INSPECTOR') || request.system.includes('SENTRY')) events = textEvents(JSON.stringify({ verdict: 'approve', findings: [] }));
        else {
          const hasToolResult = request.messages.some((m) => m.role === 'tool');
          events = hasToolResult ? textEvents('done') : editEvents('foo.txt', 'x\n');
          if (!hasToolResult) block = true; // the Builder's first (edit) round hangs
        }
        return (async function* () {
          if (block) await blocker;
          for (const e of events) yield e;
        })();
      },
    };
    const deps: SessionDeps = {
      io,
      secrets: new FakeSecrets(),
      settings: new FakeSettings('coop'),
      history: new FakeHistory(),
      git: fakeGit,
      post: (m) => posted.push(m),
      createAdapter: () => adapter,
      fetchModels: async () => [{ id: 'm1' }],
      clock: () => Date.now(),
    };
    const session = createSessionCore(deps);
    await session.handle({ type: 'ready' });

    const turn = session.handle({ type: 'sendPrompt', text: 'PRD text', prd: true });
    // Flush until the Builder card is emitted (the loop is now blocked).
    for (let i = 0; i < 100; i += 1) {
      if (posted.some((m) => m.type === 'gateUpdate' && m.card.role === 'builder')) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    await session.handle({ type: 'cancelResponse' });
    unblock();
    await turn;

    const conv = lastConversation(posted)!;
    expect(conv.prdPlan).toBeDefined();
    expect(conv.prdPlan?.stories[0].status).toBe('pending'); // cancelled → retryable, not building

    // Continue on the pending cursor story must RETRY it — not mark it done and
    // skip past work that never happened. The adapter no longer blocks, so the
    // rerun completes to awaiting-review with the cursor still on story 1.
    const beforeResume = posted.length;
    await session.handle({ type: 'continueStoryLoop' });
    const after = lastConversation(posted)!;
    expect(after.prdPlan?.cursor).toBe(0);
    expect(after.prdPlan?.stories[0].status).toBe('awaiting-review');
    expect(after.prdPlan?.stories[1].status).toBe('pending');
    // The retry ran as a real turn parented on a synthetic "Resume story" node.
    expect(posted.slice(beforeResume).some((m) => m.type === 'turnStarted')).toBe(true);
    expect(
      Object.values(after.nodes).some(
        (n) => n.role === 'user' && n.blocks.some((b) => b.type === 'text' && b.text.startsWith('Resume story 1:')),
      ),
    ).toBe(true);
  });

  it('ignores continueStoryLoop while a turn is streaming', async () => {
    const io = new FakeIo();
    const posted: HostToWebview[] = [];
    let unblock: () => void = () => {};
    const blocker = new Promise<void>((res) => {
      unblock = res;
    });
    // Block the Sentry role call so the story-1 pipeline hangs mid-turn (plan already set,
    // abort controller live) — the moment continueStoryLoop must be ignored.
    const adapter: ProviderAdapter = {
      chat(request: ChatRequest) {
        let events: StreamEvent[];
        let block = false;
        if (request.system.includes('FOREMAN')) events = textEvents(TWO_STORY_JSON);
        else if (request.system.includes('SCOUT')) events = textEvents(JSON.stringify({ criteria: ['x'], plan: [], ambiguous: false }));
        else if (request.system.includes('SENTRY')) {
          events = textEvents(JSON.stringify({ verdict: 'approve', findings: [] }));
          block = true;
        } else if (request.system.includes('INSPECTOR')) {
          events = textEvents(JSON.stringify({ verdict: 'approve', findings: [] }));
        } else {
          const hasToolResult = request.messages.some((m) => m.role === 'tool');
          events = hasToolResult ? textEvents('done') : editEvents('foo.txt', 'x\n');
        }
        return (async function* () {
          if (block) await blocker;
          for (const e of events) yield e;
        })();
      },
    };
    const deps: SessionDeps = {
      io,
      secrets: new FakeSecrets(),
      settings: new FakeSettings('coop'),
      history: new FakeHistory(),
      git: fakeGit,
      post: (m) => posted.push(m),
      createAdapter: () => adapter,
      fetchModels: async () => [{ id: 'm1' }],
      clock: () => Date.now(),
    };
    const session = createSessionCore(deps);
    await session.handle({ type: 'ready' });

    const turn = session.handle({ type: 'sendPrompt', text: 'PRD text', prd: true });

    // Flush until the Sentry card has been emitted (the pipeline is now blocked on it).
    for (let i = 0; i < 100; i += 1) {
      if (posted.some((m) => m.type === 'gateUpdate' && m.card.role === 'sentry')) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(posted.some((m) => m.type === 'gateUpdate' && m.card.role === 'sentry')).toBe(true);

    // A turn is in flight → continueStoryLoop is ignored (posts nothing, advances nothing).
    const before = posted.length;
    await session.handle({ type: 'continueStoryLoop' });
    expect(posted.length).toBe(before);

    unblock();
    await turn;
    // The turn finished normally; the plan advanced only through the pipeline, not a stray continue.
    const conv = lastConversation(posted)!;
    expect(conv.prdPlan?.cursor).toBe(0);
    expect(continueNodes(conv)).toEqual([]);
  });
});

describe('PRD plan history round-trip', () => {
  it('keeps prdPlan through a JSON save/load', async () => {
    const { session } = makeSession({ mode: 'coop', path: 'foo.txt', content: 'x\n' });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'PRD text', prd: true });

    const saved = session.conversation;
    expect(saved.prdPlan).toBeDefined();
    const roundTripped: Conversation = JSON.parse(JSON.stringify(saved));
    expect(roundTripped.prdPlan?.stories).toHaveLength(2);
    expect(roundTripped.prdPlan?.stories[0].specPath).toBe(saved.prdPlan!.stories[0].specPath);
    expect(roundTripped.prdPlan?.stories[0].status).toBe('awaiting-review');
    expect(roundTripped.prdPlan?.cursor).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Conversation context digest for the planning roles (Scout)
// ---------------------------------------------------------------------------

/** The user prompt text of the SCOUT request(s) in a request list, oldest → newest. */
function scoutPrompts(requests: ChatRequest[]): string[] {
  return requests.filter((r) => r.system.includes('SCOUT')).map((r) => userWireText(r));
}

describe('coop context digest', () => {
  it("carries prior conversation text into a follow-up coop turn's Scout prompt", async () => {
    const { session, requests } = makeSession({ mode: 'coop', path: 'foo.txt', content: 'x\n' });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'FIRSTASK build the login form' });

    const idx = requests.length;
    await session.handle({ type: 'sendPrompt', text: 'SECONDASK now add validation' });

    const scout = scoutPrompts(requests.slice(idx))[0];
    expect(scout).toContain('CONVERSATION SO FAR (condensed):');
    expect(scout).toContain('FIRSTASK build the login form'); // prior turn in the digest
    expect(scout).toContain('CURRENT REQUEST:');
    expect(scout).toContain('SECONDASK now add validation'); // the new turn
  });

  it("first turn has no digest — the Scout prompt is the bare request", async () => {
    const { session, requests } = makeSession({ mode: 'coop', path: 'foo.txt', content: 'x\n' });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'add a feature' });

    const scout = scoutPrompts(requests)[0];
    expect(scout).not.toContain('CONVERSATION SO FAR');
    expect(scout.trim()).toBe('add a feature');
  });

  it('clarification flow: the second Scout prompt carries BOTH the original request and the reply', async () => {
    const io = new FakeIo();
    const posted: HostToWebview[] = [];
    const requests: ChatRequest[] = [];
    let scoutCalls = 0;
    // First Scout call is ambiguous (blocks the line); later ones return criteria.
    const adapter: ProviderAdapter = {
      chat(request: ChatRequest) {
        requests.push(request);
        let events: StreamEvent[];
        if (request.system.includes('SCOUT')) {
          scoutCalls += 1;
          events =
            scoutCalls === 1
              ? textEvents(JSON.stringify({ criteria: [], plan: [], ambiguous: true, question: 'Which cache backend?' }))
              : textEvents(JSON.stringify({ criteria: ['C1'], plan: ['p'], ambiguous: false }));
        } else if (request.system.includes('INSPECTOR') || request.system.includes('SENTRY')) {
          events = textEvents(JSON.stringify({ verdict: 'approve', findings: [] }));
        } else {
          const hasToolResult = request.messages.some((m) => m.role === 'tool');
          events = hasToolResult ? textEvents('done') : editEvents('foo.txt', 'x\n');
        }
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    };
    const deps: SessionDeps = {
      io,
      secrets: new FakeSecrets(),
      settings: new FakeSettings('coop'),
      history: new FakeHistory(),
      git: fakeGit,
      post: (m) => posted.push(m),
      createAdapter: () => adapter,
      fetchModels: async () => [{ id: 'm1' }],
      clock: () => Date.now(),
    };
    const session = createSessionCore(deps);

    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'ORIGINALASK add a cache layer' });
    // First turn blocked on the clarifying question (no build ran).
    const firstConv = lastConversation(posted)!;
    const firstLeaf = assistantLeaf(firstConv)!;
    expect(firstLeaf.blocks.some((b) => b.type === 'text' && b.text.includes('Which cache backend?'))).toBe(true);

    const idx = requests.length;
    await session.handle({ type: 'sendPrompt', text: 'REPLYTEXT use redis with a 60s TTL' });

    const secondScout = scoutPrompts(requests.slice(idx))[0];
    expect(secondScout).toContain('ORIGINALASK add a cache layer'); // original request survives via the digest
    expect(secondScout).toContain('Which cache backend?'); // the assistant's question too
    expect(secondScout).toContain('REPLYTEXT use redis with a 60s TTL'); // the new reply
  });

  it('bounds the digest for a long history (per-message + total caps respected)', async () => {
    const { session, requests } = makeSession({ mode: 'coop', path: 'foo.txt', content: 'x\n' });
    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: `HEADMARK ${'L'.repeat(5000)}` });

    const idx = requests.length;
    await session.handle({ type: 'sendPrompt', text: 'follow up' });

    const scout = scoutPrompts(requests.slice(idx))[0];
    const digest = scout.split('CURRENT REQUEST:')[0];
    // The long prior message was truncated with the ellipsis marker…
    expect(digest).toContain('HEADMARK');
    expect(digest).toContain('[…]');
    // …and the digest is bounded (per-message ~600 chars, total ~2000).
    expect(digest.length).toBeLessThan(2200);
  });
});

// ---------------------------------------------------------------------------
// Retry a failed PRD story
// ---------------------------------------------------------------------------

describe('retryStory', () => {
  it('re-runs a failed cursor story (failed → building → awaiting-review) via a "Retry story" node', async () => {
    const io = new FakeIo();
    const posted: HostToWebview[] = [];
    let approveInspector = false; // story 1 fails first (inspector rejects), then a retry approves
    const adapter: ProviderAdapter = {
      chat(request: ChatRequest) {
        let events: StreamEvent[];
        if (request.system.includes('FOREMAN')) events = textEvents(TWO_STORY_JSON);
        else if (request.system.includes('SCOUT')) events = textEvents(JSON.stringify({ criteria: ['x'], plan: [], ambiguous: false }));
        else if (request.system.includes('SENTRY')) events = textEvents(JSON.stringify({ verdict: 'approve', findings: [] }));
        else if (request.system.includes('INSPECTOR'))
          events = textEvents(JSON.stringify({ verdict: approveInspector ? 'approve' : 'reject', findings: approveInspector ? [] : ['not yet'] }));
        else {
          const hasToolResult = request.messages.some((m) => m.role === 'tool');
          events = hasToolResult ? textEvents('done') : editEvents('foo.txt', 'x\n');
        }
        return (async function* () {
          for (const e of events) yield e;
        })();
      },
    };
    const deps: SessionDeps = {
      io,
      secrets: new FakeSecrets(),
      settings: new FakeSettings('coop'),
      history: new FakeHistory(),
      git: fakeGit,
      post: (m) => posted.push(m),
      createAdapter: () => adapter,
      fetchModels: async () => [{ id: 'm1' }],
      clock: () => Date.now(),
    };
    const session = createSessionCore(deps);

    await session.handle({ type: 'ready' });
    await session.handle({ type: 'sendPrompt', text: 'PRD text', prd: true });

    // Story 1 exhausted its retry budget → failed, cursor still on it.
    let conv = lastConversation(posted)!;
    expect(conv.prdPlan?.cursor).toBe(0);
    expect(conv.prdPlan?.stories[0].status).toBe('failed');

    // Now the inspector approves; retryStory re-runs the cursor story to awaiting-review.
    approveInspector = true;
    const before = posted.length;
    await session.handle({ type: 'retryStory' });

    conv = lastConversation(posted)!;
    expect(conv.prdPlan?.cursor).toBe(0); // cursor did NOT advance
    expect(conv.prdPlan?.stories[0].status).toBe('awaiting-review'); // failed → awaiting-review
    expect(conv.prdPlan?.stories[1].status).toBe('pending');
    // A synthetic "Retry story 1" user node parented the re-run, and a turn ran.
    expect(
      Object.values(conv.nodes).some(
        (n) => n.role === 'user' && n.blocks.some((b) => b.type === 'text' && b.text.startsWith('Retry story 1:')),
      ),
    ).toBe(true);
    expect(posted.slice(before).some((m) => m.type === 'turnStarted')).toBe(true);
  });

  it('ignores retryStory while a turn is streaming', async () => {
    const io = new FakeIo();
    const posted: HostToWebview[] = [];
    let unblock: () => void = () => {};
    const blocker = new Promise<void>((res) => {
      unblock = res;
    });
    // Hang the story-1 Sentry call so a turn is in flight when retryStory arrives.
    const adapter: ProviderAdapter = {
      chat(request: ChatRequest) {
        let events: StreamEvent[];
        let block = false;
        if (request.system.includes('FOREMAN')) events = textEvents(TWO_STORY_JSON);
        else if (request.system.includes('SCOUT')) events = textEvents(JSON.stringify({ criteria: ['x'], plan: [], ambiguous: false }));
        else if (request.system.includes('SENTRY')) {
          events = textEvents(JSON.stringify({ verdict: 'approve', findings: [] }));
          block = true;
        } else if (request.system.includes('INSPECTOR')) {
          events = textEvents(JSON.stringify({ verdict: 'approve', findings: [] }));
        } else {
          const hasToolResult = request.messages.some((m) => m.role === 'tool');
          events = hasToolResult ? textEvents('done') : editEvents('foo.txt', 'x\n');
        }
        return (async function* () {
          if (block) await blocker;
          for (const e of events) yield e;
        })();
      },
    };
    const deps: SessionDeps = {
      io,
      secrets: new FakeSecrets(),
      settings: new FakeSettings('coop'),
      history: new FakeHistory(),
      git: fakeGit,
      post: (m) => posted.push(m),
      createAdapter: () => adapter,
      fetchModels: async () => [{ id: 'm1' }],
      clock: () => Date.now(),
    };
    const session = createSessionCore(deps);
    await session.handle({ type: 'ready' });

    const turn = session.handle({ type: 'sendPrompt', text: 'PRD text', prd: true });
    for (let i = 0; i < 100; i += 1) {
      if (posted.some((m) => m.type === 'gateUpdate' && m.card.role === 'sentry')) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(posted.some((m) => m.type === 'gateUpdate' && m.card.role === 'sentry')).toBe(true);

    const before = posted.length;
    await session.handle({ type: 'retryStory' });
    expect(posted.length).toBe(before); // ignored while a turn is in flight

    unblock();
    await turn;
  });
});
