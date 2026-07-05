/**
 * Live e2e host — the REAL SessionCore, wired to in-memory ports and a scripted
 * dual-model ProviderAdapter, exposed to the real webview bundle through the same
 * `window.__fowlplayBridge` seam the MockBridge uses.
 *
 * Unlike e2e/mockBridge.js (which fakes the host and scripts UI messages), this
 * harness runs the production `createSessionCore`: the webview's posts are handed
 * to `session.handle(msg)`, and the session's `deps.post` is delivered back to the
 * webview's message handlers. The only fakes are the narrow SessionDeps ports
 * (disk / secrets / settings / history) and the ProviderAdapter, whose responses
 * depend on BOTH the modelId and the role system prompt so per-role routing is
 * genuinely exercised.
 *
 * Bundled to dist/liveHost.js by esbuild and loaded by e2e/liveHarness.html BEFORE
 * dist/webview.js, so the bridge is installed before the webview calls getBridge().
 *
 * window.__live      — the scripted adapter's ordered call log (role + modelId).
 * window.__liveReady  — resolves once the session has been constructed.
 */

import { createSessionCore, type SessionCore } from '../src/extension/session';
import type {
  DiskIo,
  SecretsPort,
  SettingsPort,
  HistoryPort,
  SessionDeps,
} from '../src/extension/session';
import type {
  Conversation,
  ConversationSummary,
  FowlPlaySettings,
  ModelRef,
  StreamEvent,
  ProviderKind,
  SdkType,
  AppearanceSettings,
  HarnessSettings,
  ProviderConfig,
} from '../src/shared/types';
import type { HostToWebview, WebviewToHost, WebviewBridge } from '../src/shared/protocol';
import type { ProviderAdapter, ChatRequest, WireMessage } from '../src/core/providers/adapter';
import type { DirEntry, GrepMatch } from '../src/core/agent/tools';

// ===========================================================================
// Model identity
// ===========================================================================

const QWEN = 'qwen3.6-35b-moe';
const QWEN_LABEL = 'Qwen3.6-35B-MoE';
const GEMMA = 'gemma-3-26b';
const GEMMA_LABEL = 'Gemma 3 26B';
const CONTEXT_WINDOW = 32768;

// ===========================================================================
// Seed PRD (small — 3 features)
// ===========================================================================

const PRD_PATH = 'pomodoro-prd.md';
const PRD_MARKDOWN = `# Pomodoro Timer — PRD

A tiny single-page Pomodoro timer app. No build step; plain HTML/CSS/JS.

## Feature 1 — Page scaffold + header
- A single \`index.html\` that loads the app.
- A visible header titled "Pomodoro".
- A container element where the timer will render.

## Feature 2 — Timer logic
- A 25:00 countdown that renders as MM:SS.
- Start, Pause, and Reset controls.
- Pause freezes the remaining time; Reset returns it to 25:00.

## Feature 3 — Styling / dark theme
- A dark theme (dark background, light foreground).
- The countdown is the visual focus (large, centered).
- Controls are clearly tappable buttons.
`;

// ===========================================================================
// In-memory ports
// ===========================================================================

/** Convert a glob pattern to a RegExp anchored to a full workspace-relative path. */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // "**/" → any number of leading dirs (incl. none); "**" → anything.
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '.';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

class MemDisk implements DiskIo {
  readonly files = new Map<string, string>();

  constructor(seed: Record<string, string>) {
    for (const [k, v] of Object.entries(seed)) this.files.set(k, v);
  }

  async read(path: string): Promise<string | null> {
    return this.files.has(path) ? this.files.get(path)! : null;
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
  async listDir(path: string): Promise<DirEntry[]> {
    const prefix = path === '' || path === '.' ? '' : path.replace(/\/$/, '') + '/';
    const names = new Set<string>();
    const entries: DirEntry[] = [];
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        if (!names.has(rest)) { names.add(rest); entries.push({ name: rest, kind: 'file' }); }
      } else {
        const dir = rest.slice(0, slash);
        if (!names.has(dir)) { names.add(dir); entries.push({ name: dir, kind: 'dir' }); }
      }
    }
    return entries;
  }
  async glob(pattern: string): Promise<string[]> {
    const re = globToRegExp(pattern);
    return [...this.files.keys()].filter((k) => re.test(k)).sort();
  }
  async grep(_pattern: string, _opts: unknown): Promise<GrepMatch[]> {
    return [];
  }
  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content);
  }
  async remove(path: string): Promise<void> {
    this.files.delete(path);
  }
}

class MemSecrets implements SecretsPort {
  private readonly map = new Map<string, string>();
  async get(id: string): Promise<string | undefined> { return this.map.get(id); }
  async set(id: string, key: string): Promise<void> { this.map.set(id, key); }
  async delete(id: string): Promise<void> { this.map.delete(id); }
}

class MemHistory implements HistoryPort {
  private readonly map = new Map<string, Conversation>();
  async list(query?: string): Promise<ConversationSummary[]> {
    const q = (query ?? '').toLowerCase();
    return [...this.map.values()]
      .filter((c) => !q || c.title.toLowerCase().includes(q))
      .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, messageCount: Object.keys(c.nodes).length }));
  }
  async load(id: string): Promise<Conversation | null> { return this.map.get(id) ?? null; }
  async save(conv: Conversation): Promise<void> { this.map.set(conv.id, conv); }
  async rename(id: string, title: string): Promise<void> {
    const c = this.map.get(id);
    if (c) this.map.set(id, { ...c, title });
  }
  async remove(id: string): Promise<void> { this.map.delete(id); }
}

class MemSettings implements SettingsPort {
  private settings: FowlPlaySettings;
  constructor(initial: FowlPlaySettings) { this.settings = initial; }
  async load(): Promise<FowlPlaySettings> { return this.settings; }
  async saveAppearance(a: AppearanceSettings): Promise<void> {
    this.settings = { ...this.settings, appearance: a };
  }
  async saveHarness(h: HarnessSettings): Promise<void> {
    this.settings = { ...this.settings, harness: h };
  }
  async saveProviders(providers: ProviderConfig[]): Promise<void> {
    this.settings = { ...this.settings, providers };
  }
  async saveDefaultModel(model: ModelRef | null): Promise<void> {
    this.settings = { ...this.settings, defaultModel: model };
  }
}

// ===========================================================================
// Scripted dual-model adapter
// ===========================================================================

type RoleGuess = 'foreman' | 'scout' | 'inspector' | 'sentry' | 'builder' | 'commit';

interface CallRecord {
  seq: number;
  role: RoleGuess;
  modelId: string;
  story: number | null;
  note: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function guessRole(system: string): RoleGuess {
  if (system.includes('You are FOREMAN')) return 'foreman';
  if (system.includes('You are SCOUT')) return 'scout';
  if (system.includes('You are INSPECTOR')) return 'inspector';
  if (system.includes('You are SENTRY')) return 'sentry';
  // Precise: the commit-message system prompt. A loose "commit message" check
  // would false-match the Builder, whose skill catalog lists a `commit-message`
  // skill (its description contains that phrase).
  if (system.includes('You write concise git commit messages')) return 'commit';
  return 'builder';
}

/** Last "Story N of M" in the user turns of a request, or null. */
function parseStory(messages: WireMessage[]): number | null {
  let found: number | null = null;
  for (const m of messages) {
    if (m.role !== 'user') continue;
    for (const part of m.content) {
      if (part.type !== 'text') continue;
      const re = /Story (\d+) of \d+/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(part.text)) !== null) found = Number(mm[1]);
    }
  }
  return found;
}

function lastIsToolResult(messages: WireMessage[]): boolean {
  const last = messages[messages.length - 1];
  return !!last && last.role === 'tool';
}

function fence(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
}

function chunk(text: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += n) out.push(text.slice(i, i + n));
  return out;
}

const STORY_FILES: Record<number, string> = { 1: 'index.html', 2: 'timer.js', 3: 'styles.css' };

function fileContentFor(story: number, fixed: boolean): string {
  switch (story) {
    case 1:
      return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Pomodoro</title></head>
  <body>
    <header><h1>Pomodoro</h1></header>
    <main id="app"><div id="timer"></div></main>
    <script src="timer.js"></script>
  </body>
</html>
`;
    case 2:
      // Attempt 1 has two defects the Inspector catches; the fix (fixed=true) repairs them.
      return fixed
        ? `let remaining = 25 * 60; // 25:00
let handle = null;
function render() {
  const m = String(Math.floor(remaining / 60)).padStart(2, '0');
  const s = String(remaining % 60).padStart(2, '0');
  document.getElementById('timer').textContent = m + ':' + s;
}
function start() { if (!handle) handle = setInterval(tick, 1000); }
function pause() { clearInterval(handle); handle = null; }
function reset() { pause(); remaining = 25 * 60; render(); }
function tick() { if (remaining > 0) { remaining -= 1; render(); } else pause(); }
render();
`
        : `let remaining = 1500;
let handle = null;
function render() {
  document.getElementById('timer').textContent = remaining; // BUG: not MM:SS
}
function start() { handle = setInterval(tick, 1000); } // BUG: double-start not guarded
function tick() { remaining -= 1; render(); }
render();
`;
    case 3:
      return `:root { color-scheme: dark; }
body { background: #10131a; color: #e6e8ee; font-family: system-ui, sans-serif; }
header h1 { text-align: center; }
#timer { font-size: 5rem; text-align: center; margin: 2rem auto; font-variant-numeric: tabular-nums; }
button { padding: 0.6rem 1.2rem; border-radius: 999px; border: 0; cursor: pointer; }
`;
    default:
      return `/* story ${story} */\n`;
  }
}

class ScriptedAdapter implements ProviderAdapter {
  readonly calls: CallRecord[] = [];
  private seq = 0;
  /** Builder ATTEMPTS started per story (round-1 calls only). */
  private builderAttempts = new Map<number, number>();
  /** Inspector reviews performed per story. */
  private inspectorReviews = new Map<number, number>();
  private currentStory = 0;

  chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const role = guessRole(req.system);
    const story = parseStory(req.messages) ?? this.currentStory;
    if ((role === 'scout' || role === 'builder') && story) this.currentStory = story;
    const hasToolResult = lastIsToolResult(req.messages);
    return this.run(role, story, hasToolResult, req);
  }

  private record(role: RoleGuess, modelId: string, story: number | null, note: string): void {
    this.calls.push({ seq: (this.seq += 1), role, modelId, story, note });
  }

  private async *run(
    role: RoleGuess,
    story: number,
    hasToolResult: boolean,
    req: ChatRequest,
  ): AsyncGenerator<StreamEvent> {
    const D = 18; // inter-event delay so the UI visibly streams
    const usage = (out: number) => ({ inputTokens: 900, outputTokens: out, cachedTokens: 0 });
    const who = req.modelId === GEMMA ? GEMMA_LABEL : QWEN_LABEL;

    if (role === 'foreman') {
      this.record('foreman', req.modelId, null, 'decompose PRD → 3 stories');
      const stories = {
        stories: [
          {
            title: 'Scaffold the page and header',
            summary: `[${who}] A single index.html with a "Pomodoro" header and a timer container.`,
            criteria: [
              'index.html exists and loads the app',
              'A header titled "Pomodoro" is visible',
              'A #timer container element is present',
            ],
          },
          {
            title: 'Implement the timer logic',
            summary: `[${who}] A 25:00 countdown with start, pause, and reset.`,
            criteria: [
              'A 25:00 countdown renders as MM:SS',
              'Start, Pause, and Reset controls work',
              'Reset returns the countdown to 25:00',
            ],
          },
          {
            title: 'Style the app with a dark theme',
            summary: `[${who}] A dark theme where the countdown is the visual focus.`,
            criteria: [
              'The app uses a dark background with light text',
              'The countdown is large and centered',
              'Controls render as tappable buttons',
            ],
          },
        ],
      };
      yield* this.stream(fence(stories), D);
      yield { type: 'usage', usage: usage(320) };
      yield { type: 'done', stopReason: 'end' };
      return;
    }

    if (role === 'scout') {
      this.record('scout', req.modelId, story, `criteria for story ${story}`);
      const criteria = SCOUT_CRITERIA[story] ?? [`Story ${story} behaves as specified`];
      const plan = [`Read the spec for story ${story}`, `Create ${STORY_FILES[story] ?? 'the file'}`, 'Report which criterion each change serves'];
      yield* this.stream(
        fence({ criteria: criteria.map((c) => `[${who}] ${c}`), plan, ambiguous: false, question: '' }),
        D,
      );
      yield { type: 'usage', usage: usage(140) };
      yield { type: 'done', stopReason: 'end' };
      return;
    }

    if (role === 'inspector') {
      const n = (this.inspectorReviews.get(story) ?? 0) + 1;
      this.inspectorReviews.set(story, n);
      const reject = story === 2 && n === 1;
      this.record('inspector', req.modelId, story, reject ? 'reject (attempt 1)' : `approve (review ${n})`);
      const verdict = reject
        ? {
            verdict: 'reject',
            findings: [
              'criterion 1: the countdown renders raw seconds, not MM:SS — format as two-digit minutes:seconds',
              'criterion 2: Start is not guarded, so repeated clicks spawn multiple intervals (add a Pause/Reset and a running guard)',
            ],
            evidence: `[${who}] Reviewed timer.js from the diff; two acceptance criteria are unmet.`,
          }
        : {
            verdict: 'approve',
            findings: [],
            evidence: `[${who}] Every acceptance criterion for story ${story} is demonstrated by the diff.`,
          };
      yield* this.stream(fence(verdict), D);
      yield { type: 'usage', usage: usage(reject ? 180 : 120) };
      yield { type: 'done', stopReason: 'end' };
      return;
    }

    if (role === 'sentry') {
      this.record('sentry', req.modelId, story, 'approve (security)');
      yield* this.stream(
        fence({ verdict: 'approve', findings: [], evidence: `[${who}] No secrets, injection, or unsafe patterns in the diff.` }),
        D,
      );
      yield { type: 'usage', usage: usage(90) };
      yield { type: 'done', stopReason: 'end' };
      return;
    }

    if (role === 'commit') {
      this.record('commit', req.modelId, story, 'commit message');
      yield { type: 'text', delta: 'chore: apply staged changes' };
      yield { type: 'usage', usage: usage(12) };
      yield { type: 'done', stopReason: 'end' };
      return;
    }

    // --- Builder ---------------------------------------------------------
    if (hasToolResult) {
      // Round 2: summarize the edit the tool applied and finish.
      const file = STORY_FILES[story] ?? 'the file';
      yield* this.stream(
        `${who} implemented story ${story}: created \`${file}\` and mapped each change to its acceptance criterion.`,
        D,
      );
      yield { type: 'usage', usage: usage(160) };
      yield { type: 'done', stopReason: 'end' };
      return;
    }

    // Round 1 of a fresh Builder attempt.
    const attempt = (this.builderAttempts.get(story) ?? 0) + 1;
    this.builderAttempts.set(story, attempt);

    // Story 3's FIRST builder attempt runs away (unbounded thinking) to trip the
    // client-side RUNAWAY guard; the retry (attempt 2) builds cleanly.
    if (story === 3 && attempt === 1) {
      this.record('builder', req.modelId, story, 'RUNAWAY (unbounded thinking)');
      const blob = 'Reconsidering the dark-theme palette and re-deriving the contrast ratios once more. '.repeat(90);
      for (let i = 0; i < 300; i += 1) {
        if (req.signal?.aborted) return;
        yield { type: 'thinking', delta: blob };
        await sleep(12);
      }
      return; // never reached in practice — the guard aborts us first
    }

    // Clean build: stage the story's file via an edit_files tool call.
    const isFix = req.messages.some(
      (m) => m.role === 'user' && m.content.some((p) => p.type === 'text' && p.text.includes('The Inspector rejected the previous attempt')),
    );
    this.record('builder', req.modelId, story, isFix ? `edits (fix, attempt ${attempt})` : `edits (attempt ${attempt})`);
    const path = STORY_FILES[story] ?? `story-${story}.txt`;
    const content = fileContentFor(story, story !== 2 || isFix);
    const args = JSON.stringify({ edits: [{ path, create: content }] });
    yield* this.stream(`Creating \`${path}\` for story ${story}. `, D);
    const id = `call-${this.seq}-${story}-${attempt}`;
    yield { type: 'tool_call_start', id, name: 'edit_files' };
    for (const c of chunk(args, 60)) {
      yield { type: 'tool_call_args', id, delta: c };
      await sleep(8);
    }
    yield { type: 'tool_call_end', id };
    yield { type: 'usage', usage: usage(220) };
    yield { type: 'done', stopReason: 'tool_use' };
  }

  private async *stream(text: string, delay: number): AsyncGenerator<StreamEvent> {
    for (const c of chunk(text, 48)) {
      yield { type: 'text', delta: c };
      await sleep(delay);
    }
  }
}

const SCOUT_CRITERIA: Record<number, string[]> = {
  1: ['index.html exists and loads the app', 'A header titled "Pomodoro" is visible', 'A #timer container is present'],
  2: ['A 25:00 countdown renders as MM:SS', 'Start, Pause, and Reset controls work', 'Reset returns the countdown to 25:00'],
  3: ['The app uses a dark background with light text', 'The countdown is large and centered', 'Controls render as tappable buttons'],
};

// ===========================================================================
// Bridge wiring — webview.post → session.handle; deps.post → webview handlers
// ===========================================================================

function buildSettings(): FowlPlaySettings {
  const provider = (id: string, name: string, sdkType: SdkType, kind: ProviderKind, modelId: string, label: string): ProviderConfig => ({
    id,
    name,
    kind,
    sdkType,
    baseUrl: `http://localhost:1143${id === 'prov-qwen' ? '4' : '5'}/v1`,
    requiresApiKey: false,
    models: [{ id: modelId, displayName: label, contextWindow: CONTEXT_WINDOW }],
  });
  return {
    appearance: { fontFamily: 'JetBrains Mono', fontScale: 1, theme: 'fowlplay-light' },
    harness: { defaultMode: 'coop', qasRetryBudget: 2 },
    providers: [
      provider('prov-qwen', 'Local — Qwen', 'openai-completions', 'local', QWEN, QWEN_LABEL),
      provider('prov-gemma', 'Local — Gemma', 'openai-completions', 'local', GEMMA, GEMMA_LABEL),
    ],
    defaultModel: { providerId: 'prov-qwen', modelId: QWEN },
  };
}

declare global {
  interface Window {
    __live?: CallRecord[];
    __liveSession?: SessionCore;
    __liveDisk?: MemDisk;
  }
}

function install(): void {
  const handlers: Array<(msg: HostToWebview) => void> = [];
  const adapter = new ScriptedAdapter();
  const disk = new MemDisk({ [PRD_PATH]: PRD_MARKDOWN });

  const deps: SessionDeps = {
    io: disk,
    secrets: new MemSecrets(),
    settings: new MemSettings(buildSettings()),
    history: new MemHistory(),
    git: undefined,
    post(msg: HostToWebview) {
      for (const h of handlers) {
        try { h(msg); } catch (e) { console.error('live host: handler error', e); }
      }
    },
    createAdapter: () => adapter,
    fetchModels: async () => [
      { id: QWEN, contextWindow: CONTEXT_WINDOW },
      { id: GEMMA, contextWindow: CONTEXT_WINDOW },
    ],
    clock: () => Date.now(),
  };

  const session = createSessionCore(deps);

  const bridge: WebviewBridge = {
    post(msg: WebviewToHost) {
      // Fire-and-forget: the webview does not await the host.
      void session.handle(msg);
    },
    onMessage(handler: (msg: HostToWebview) => void) {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
  };

  window.__fowlplayBridge = bridge;
  window.__live = adapter.calls;
  window.__liveSession = session;
  window.__liveDisk = disk;
}

install();
