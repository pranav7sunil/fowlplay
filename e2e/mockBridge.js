/**
 * Standalone MockBridge for the FowlPlay webview e2e harness.
 * Implements the WebviewBridge shape (post / onMessage) without VS Code.
 *
 *  - window.__sentMessages         : every WebviewToHost message the UI posts
 *  - window.__host.emit(msg)       : push a HostToWebview message into the UI
 *  - window.__fowlplayBridge       : the bridge the webview bundle picks up
 *
 * On the UI's 'ready' message a scripted scenario runs, selected by URL hash:
 *   #chat #diff #settings #onboarding #stream   (default: #chat)
 */
(function () {
  const handlers = [];
  window.__sentMessages = [];

  function emit(msg) {
    handlers.forEach((h) => {
      try { h(msg); } catch (e) { console.error('emit handler error', e); }
    });
  }

  window.__host = { emit };

  window.__fowlplayBridge = {
    post(msg) {
      window.__sentMessages.push(msg);
      if (msg && msg.type === 'ready') {
        // Defer so the UI has subscribed and rendered.
        setTimeout(runScenario, 0);
        return;
      }
      // Read-only "View Changes" on a historical commit block: the host serves
      // the frozen changeset for that id, regardless of the live overlay.
      if (msg && msg.type === 'openDiff' && msg.changesetId === 'cs-hist-1') {
        emit({ type: 'changeset', view: historicalView() });
      }
      // "Edit Selection" chip dismissed → the host clears the pinned selection.
      if (msg && msg.type === 'clearSelection') {
        emit({ type: 'selectionContext', context: null });
      }
    },
    onMessage(handler) {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
  };

  // --------------------------------------------------------------------------
  // Fixture builders
  // --------------------------------------------------------------------------
  const now = Date.now();

  function providers(withKeys) {
    return [
      {
        id: 'prov-ollama',
        name: 'Ollama (local)',
        kind: 'local',
        sdkType: 'openai-completions',
        baseUrl: 'http://localhost:11434/v1',
        requiresApiKey: false,
        models: [
          { id: 'qwen2.5-coder:32b', displayName: 'Qwen2.5 Coder 32B', contextWindow: 32768 },
          { id: 'llama3.1:8b', displayName: 'Llama 3.1 8B', contextWindow: 131072 },
        ],
      },
      {
        id: 'prov-anthropic',
        name: 'Anthropic',
        kind: 'api-key',
        sdkType: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        requiresApiKey: true,
        models: [
          { id: 'claude-sonnet-4', displayName: 'Claude Sonnet 4', contextWindow: 200000 },
        ],
      },
    ];
  }

  function settings(hasProviders) {
    return {
      type: 'settings',
      settings: {
        appearance: { fontFamily: 'JetBrains Mono', fontScale: 1, theme: 'fowlplay-light' },
        harness: { defaultMode: 'coop', qasRetryBudget: 2 },
        providers: hasProviders ? providers() : [],
        defaultModel: hasProviders ? { providerId: 'prov-ollama', modelId: 'qwen2.5-coder:32b' } : null,
        skills: [
          { name: 'commit-message', description: 'Write a clear, conventional commit message for a staged changeset.' },
          { name: 'test-writing', description: 'Write focused, deterministic tests that pin the behavior a change introduces.' },
        ],
      },
    };
  }

  const scoutGate = {
    id: 'gate-scout',
    role: 'scout',
    title: 'Scout — acceptance criteria',
    status: 'passed',
    evidence: 'Restated the request as testable criteria and produced a short task plan.',
    acceptanceCriteria: [
      'login() returns a typed Session on success',
      'Invalid credentials throw AuthError, not a generic Error',
      'Existing callers keep compiling (no signature break)',
    ],
  };

  const inspectorGate = {
    id: 'gate-inspector',
    role: 'inspector',
    title: 'Inspector — QA validation',
    status: 'passed',
    attempt: 1,
    evidence:
      'Re-read the staged diff independently.\n\n- `login()` now returns `Session` ✓\n- `AuthError` thrown on 401 ✓\n- `authService.test.ts` covers both paths ✓',
  };

  const sentryGate = {
    id: 'gate-sentry',
    role: 'sentry',
    title: 'Sentry — security review',
    status: 'passed',
    evidence: 'No secrets, no injection sinks, no unsafe `eval`/`child_process` usage introduced.',
  };

  function assistantBlocks() {
    return [
      { type: 'thinking', text: 'The caller wants a typed session and a dedicated error. I will update `login()` and add `AuthError`, then cover it with a test.', durationMs: 12300 },
      {
        type: 'tool_call',
        call: {
          id: 't1',
          name: 'search',
          args: { query: 'function login', glob: 'src/**/*.ts' },
          resultSummary: 'Found `login()` in `src/auth/authService.ts:14`',
          ok: true,
        },
      },
      {
        type: 'tool_call',
        call: {
          id: 't2',
          name: 'apply_edits',
          args: { edits: [{ path: 'src/auth/authService.ts', anchor: 'return token;' }] },
          resultSummary: 'Applied 2 edits across 2 files',
          ok: true,
        },
      },
      { type: 'gate', card: scoutGate },
      { type: 'gate', card: inspectorGate },
      { type: 'gate', card: sentryGate },
      { type: 'text', text: 'I refactored `login()` to return a typed `Session` and introduced an `AuthError`. A new test in `authService.test.ts` covers both the success and the `401` paths.\n\n```ts\nexport async function login(u: string, p: string): Promise<Session> {\n  const res = await api.post("/login", { u, p });\n  if (res.status === 401) throw new AuthError("invalid credentials");\n  return res.data as Session;\n}\n```' },
      { type: 'changes', summary: { changesetId: 'cs-1', filesChanged: 3, additions: 30, deletions: 9 } },
    ];
  }

  function conversation() {
    const u = {
      id: 'u1', parentId: null, role: 'user',
      blocks: [{ type: 'text', text: 'Refactor `login()` in the auth service to return a typed **Session** and throw a dedicated `AuthError` on bad credentials. Add a test.' }],
      createdAt: now - 60000,
    };
    const a = {
      id: 'a1', parentId: 'u1', role: 'assistant',
      blocks: assistantBlocks(),
      createdAt: now - 30000,
      model: { providerId: 'prov-ollama', modelId: 'qwen2.5-coder:32b' },
      usage: { inputTokens: 8450, outputTokens: 1120, cachedTokens: 6000 },
    };
    return {
      type: 'conversation',
      conversation: {
        id: 'conv-1',
        title: 'Refactor login() → typed Session',
        nodes: { u1: u, a1: a },
        rootIds: ['u1'],
        currentLeafId: 'a1',
        model: { providerId: 'prov-ollama', modelId: 'qwen2.5-coder:32b' },
        harnessMode: 'coop',
        createdAt: now - 60000,
        updatedAt: now,
        usageTotals: { inputTokens: 8450, outputTokens: 1120, cachedTokens: 6000 },
      },
    };
  }

  function changeset() {
    return {
      type: 'changeset',
      view: {
        id: 'cs-1',
        additions: 30,
        deletions: 9,
        totalChanges: 6,
        files: [
          {
            path: 'src/auth/authService.ts',
            kind: 'modify',
            additions: 22,
            deletions: 6,
            hunks: [
              {
                id: 'h1', path: 'src/auth/authService.ts',
                baseStart: 12, stagedStart: 12,
                baseLines: ['export async function login(u: string, p: string) {', '  const res = await api.post("/login", { u, p });', '  return res.data.token;'],
                stagedLines: ['export async function login(u: string, p: string): Promise<Session> {', '  const res = await api.post("/login", { u, p });', '  if (res.status === 401) throw new AuthError("invalid credentials");', '  return res.data as Session;'],
                contextBefore: ['import { api } from "./client";', ''],
                contextAfter: ['}', ''],
                reverted: false,
              },
              {
                id: 'h2', path: 'src/auth/authService.ts',
                baseStart: 30, stagedStart: 31,
                baseLines: ['export function logout() {'],
                stagedLines: ['/** Ends the current session. */', 'export function logout() {'],
                contextBefore: ['', ''],
                contextAfter: ['  clearToken();', '}'],
                reverted: false,
                comment: 'Nice — keep this doc comment.',
              },
              {
                id: 'h5', path: 'src/auth/authService.ts',
                baseStart: 3, stagedStart: 3,
                baseLines: ['import { api } from "./client";'],
                stagedLines: ['import { api } from "./client";', 'import { AuthError } from "./errors";', 'import type { Session } from "./types";'],
                contextBefore: ['/* eslint-disable */', ''],
                contextAfter: ['', ''],
                reverted: false,
              },
              {
                id: 'h6', path: 'src/auth/authService.ts',
                baseStart: 45, stagedStart: 47,
                baseLines: ['  return null;'],
                stagedLines: ['  throw new AuthError("no active session");'],
                contextBefore: ['export function currentSession(): Session {', '  const s = read();', '  if (s) return s;'],
                contextAfter: ['}', ''],
                reverted: false,
              },
            ],
          },
          {
            path: 'src/auth/errors.ts',
            kind: 'create',
            additions: 8,
            deletions: 0,
            hunks: [
              {
                id: 'h3', path: 'src/auth/errors.ts',
                baseStart: 1, stagedStart: 1,
                baseLines: [],
                stagedLines: ['export class AuthError extends Error {', '  constructor(message: string) {', '    super(message);', '    this.name = "AuthError";', '  }', '}'],
                contextBefore: [],
                contextAfter: [],
                reverted: false,
              },
            ],
          },
          {
            path: 'src/auth/legacyToken.ts',
            kind: 'delete',
            additions: 0,
            deletions: 3,
            hunks: [
              {
                id: 'h4', path: 'src/auth/legacyToken.ts',
                baseStart: 1, stagedStart: 1,
                baseLines: ['export function legacyToken() {', '  return localStorage.getItem("token");', '}'],
                stagedLines: [],
                contextBefore: [],
                contextAfter: [],
                reverted: false,
              },
            ],
          },
        ],
      },
    };
  }

  // A frozen changeset captured at commit time — served read-only when the user
  // clicks "View Changes" on a historical commit block.
  function historicalView() {
    return {
      id: 'cs-hist-1',
      additions: 6,
      deletions: 0,
      totalChanges: 1,
      files: [
        {
          path: 'src/auth/errors.ts',
          kind: 'create',
          additions: 6,
          deletions: 0,
          hunks: [
            {
              id: 'hh1', path: 'src/auth/errors.ts',
              baseStart: 1, stagedStart: 1,
              baseLines: [],
              stagedLines: ['export class AuthError extends Error {', '  constructor(message: string) {', '    super(message);', '    this.name = "AuthError";', '  }', '}'],
              contextBefore: [], contextAfter: [], reverted: false,
            },
          ],
        },
      ],
    };
  }

  // A conversation whose assistant turn ended in an applied commit — carries a
  // commit block with a frozen changeset id, plus the persisted frozen view.
  function commitBlockConversation() {
    const u = {
      id: 'u1', parentId: null, role: 'user',
      blocks: [{ type: 'text', text: 'Add a dedicated `AuthError` type and commit it.' }],
      createdAt: now - 60000,
    };
    const a = {
      id: 'a1', parentId: 'u1', role: 'assistant',
      blocks: [
        { type: 'text', text: 'Added `AuthError` and committed the change.' },
        { type: 'commit', commit: { sha: 'abc1234def5678', message: 'feat(auth): add AuthError', changesetId: 'cs-hist-1', filesChanged: 1 } },
      ],
      createdAt: now - 30000,
      model: { providerId: 'prov-ollama', modelId: 'qwen2.5-coder:32b' },
      usage: { inputTokens: 320, outputTokens: 96, cachedTokens: 0 },
    };
    return {
      type: 'conversation',
      conversation: {
        id: 'conv-hist',
        title: 'Committed: add AuthError',
        nodes: { u1: u, a1: a },
        rootIds: ['u1'],
        currentLeafId: 'a1',
        model: { providerId: 'prov-ollama', modelId: 'qwen2.5-coder:32b' },
        harnessMode: 'solo',
        createdAt: now - 60000,
        updatedAt: now,
        usageTotals: { inputTokens: 320, outputTokens: 96, cachedTokens: 0 },
        committedChangesets: { 'cs-hist-1': historicalView() },
      },
    };
  }

  function conversationList() {
    return {
      type: 'conversationList',
      items: [
        { id: 'conv-1', title: 'Refactor login() → typed Session', updatedAt: now, messageCount: 2 },
        { id: 'conv-2', title: 'Add pagination to /users endpoint', updatedAt: now - 86400000, messageCount: 6 },
        { id: 'conv-3', title: 'Fix flaky websocket reconnect test', updatedAt: now - 2 * 86400000, messageCount: 4 },
      ],
    };
  }

  // --------------------------------------------------------------------------
  // Scenarios
  // --------------------------------------------------------------------------
  function setView(v) {
    if (window.__fowlplayStore) window.__fowlplayStore.setView(v);
  }

  function runScenario() {
    const hash = (location.hash || '#chat').replace('#', '');
    switch (hash) {
      case 'history-diff':
        emit(settings(true));
        emit(commitBlockConversation());
        break;
      case 'diff':
        emit(settings(true));
        emit(conversation());
        emit(changeset());
        emit({ type: 'rebaseState', state: { needed: false, conflictedPaths: [] } });
        break;
      case 'settings':
        emit(settings(true));
        emit({ type: 'modelsFetched', providerId: 'prov-ollama', models: [{ id: 'qwen2.5-coder:32b' }, { id: 'llama3.1:8b' }, { id: 'deepseek-r1:14b' }] });
        setView('settings');
        break;
      case 'onboarding':
        emit(settings(false));
        break;
      case 'stream':
        runStreamScenario();
        break;
      case 'history':
        emit(settings(true));
        emit(conversationList());
        setView('history');
        break;
      case 'selection':
        emit(settings(true));
        emit(conversation());
        emit({
          type: 'selectionContext',
          context: {
            path: 'src/auth/authService.ts',
            startLine: 12,
            endLine: 20,
            text: 'export async function login(u, p) {\n  return api.post("/login", { u, p });\n}',
            languageId: 'typescript',
          },
        });
        break;
      case 'chat':
      default:
        emit(settings(true));
        emit(conversation());
        break;
    }
  }

  function runStreamScenario() {
    emit(settings(true));
    // Base conversation: just the user prompt.
    emit({
      type: 'conversation',
      conversation: {
        id: 'conv-s', title: 'Streaming demo',
        nodes: {
          u1: { id: 'u1', parentId: null, role: 'user', blocks: [{ type: 'text', text: 'Add an `AuthError` and make `login()` return a typed Session.' }], createdAt: now },
        },
        rootIds: ['u1'], currentLeafId: 'u1',
        model: { providerId: 'prov-ollama', modelId: 'qwen2.5-coder:32b' },
        harnessMode: 'coop', createdAt: now, updatedAt: now,
        usageTotals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      },
    });

    const steps = [];
    steps.push(() => emit({ type: 'turnStarted', nodeId: 'a1' }));
    'Thinking through the change: the caller needs a typed session and a dedicated error type. '.match(/.{1,14}/g).forEach((chunk) => {
      steps.push(() => emit({ type: 'stream', event: { type: 'thinking', delta: chunk } }));
    });
    steps.push(() => emit({ type: 'stream', event: { type: 'tool_call_start', id: 't1', name: 'search' } }));
    steps.push(() => emit({ type: 'stream', event: { type: 'tool_call_args', id: 't1', delta: '{"query":"function login"}' } }));
    steps.push(() => emit({ type: 'stream', event: { type: 'tool_call_end', id: 't1' } }));
    steps.push(() => emit({ type: 'gateUpdate', card: { ...scoutGate, status: 'running' } }));
    steps.push(() => emit({ type: 'gateUpdate', card: scoutGate }));
    'Refactored `login()` to return a `Session` and added `AuthError`. Tests cover both paths.'.match(/.{1,10}/g).forEach((chunk) => {
      steps.push(() => emit({ type: 'stream', event: { type: 'text', delta: chunk } }));
    });
    steps.push(() => emit({ type: 'gateUpdate', card: inspectorGate }));
    steps.push(() => emit({ type: 'gateUpdate', card: sentryGate }));
    steps.push(() => emit({ type: 'stream', event: { type: 'usage', usage: { inputTokens: 8450, outputTokens: 1120, cachedTokens: 6000 } } }));
    steps.push(() => emit({ type: 'stream', event: { type: 'done', stopReason: 'end' } }));
    // Real host order: turnFinished fires BEFORE the authoritative conversation
    // (the conversation carries the correct totals and overwrites node state).
    steps.push(() => emit({ type: 'turnFinished', nodeId: 'a1', usage: { inputTokens: 8450, outputTokens: 1120, cachedTokens: 6000 } }));
    steps.push(() =>
      emit({
        type: 'conversation',
        conversation: {
          id: 'conv-s', title: 'Streaming demo',
          nodes: {
            u1: { id: 'u1', parentId: null, role: 'user', blocks: [{ type: 'text', text: 'Add an `AuthError` and make `login()` return a typed Session.' }], createdAt: now },
            a1: {
              id: 'a1', parentId: 'u1', role: 'assistant',
              blocks: assistantBlocks(),
              createdAt: now + 1, model: { providerId: 'prov-ollama', modelId: 'qwen2.5-coder:32b' },
              usage: { inputTokens: 8450, outputTokens: 1120, cachedTokens: 6000 },
            },
          },
          rootIds: ['u1'], currentLeafId: 'a1',
          model: { providerId: 'prov-ollama', modelId: 'qwen2.5-coder:32b' },
          harnessMode: 'coop', createdAt: now, updatedAt: now + 1,
          usageTotals: { inputTokens: 8450, outputTokens: 1120, cachedTokens: 6000 },
        },
      }),
    );

    let i = 0;
    const tick = () => {
      if (i >= steps.length) return;
      steps[i++]();
      setTimeout(tick, 45);
    };
    tick();
  }

  // Re-run scenario if the hash changes (handy while iterating in a browser).
  window.addEventListener('hashchange', () => location.reload());
})();
