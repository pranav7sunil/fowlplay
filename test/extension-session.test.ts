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
  async saveDefaultModel() {}
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
  const deps: SessionDeps = {
    io,
    secrets: new FakeSecrets(),
    settings: new FakeSettings(opts.mode ?? 'solo'),
    history: new FakeHistory(),
    git: fakeGit,
    post: (m) => posted.push(m),
    createAdapter: () => adapter,
    fetchModels: async () => [{ id: 'm1' }],
    clock: () => Date.now(),
  };
  const session = createSessionCore(deps);
  return { session, posted, io, requests };
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
