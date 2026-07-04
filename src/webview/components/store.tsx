/**
 * Single app store. A thin external store fed by HostToWebview messages;
 * every user action posts a WebviewToHost message through the bridge.
 * The webview is a thin view over host state.
 */
import { useState, useEffect } from 'preact/hooks';
import type {
  Conversation,
  ChangeSetView,
  RebaseState,
  ConversationSummary,
  FowlPlaySettings,
  MessageNode,
  ContentBlock,
  SelectionContext,
  TokenUsage,
  ToolCallRecord,
} from '../../shared/types';
import type { HostToWebview, WebviewToHost } from '../../shared/protocol';
import { getBridge } from '../bridge';

export type View = 'chat' | 'diff' | 'settings' | 'history' | 'onboarding';

export interface Toast {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface AppState {
  view: View;
  settings: FowlPlaySettings | null;
  conversation: Conversation | null;
  streaming: boolean;
  streamNodeId: string | null;
  selectionContext: SelectionContext | null;
  changeset: ChangeSetView | null;
  diffReadOnly: boolean;
  rebase: RebaseState;
  commitMessage: string;
  historyItems: ConversationSummary[];
  modelsFetched: Record<string, { id: string; contextWindow?: number }[]>;
  modelsError: Record<string, string | undefined>;
  toasts: Toast[];
  bootstrapped: boolean;
}

const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

const initialState: AppState = {
  view: 'chat',
  settings: null,
  conversation: null,
  streaming: false,
  streamNodeId: null,
  selectionContext: null,
  changeset: null,
  diffReadOnly: false,
  rebase: { needed: false, conflictedPaths: [] },
  commitMessage: '',
  historyItems: [],
  modelsFetched: {},
  modelsError: {},
  toasts: [],
  bootstrapped: false,
};

// ---------------------------------------------------------------------------
// Store implementation
// ---------------------------------------------------------------------------

type Listener = () => void;

class Store {
  state: AppState = initialState;
  private listeners = new Set<Listener>();
  private toastSeq = 1;

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private set(next: AppState) {
    this.state = next;
    this.listeners.forEach((l) => l());
  }

  patch(p: Partial<AppState>) {
    this.set({ ...this.state, ...p });
  }

  setView(view: View) {
    this.patch({ view });
  }

  /** Open the diff viewer for a changeset (or the current one). */
  openReview(changesetId?: string, readOnly = false) {
    this.patch({ view: 'diff', diffReadOnly: readOnly });
    getBridge().post({ type: 'openDiff', changesetId });
  }

  pushToast(level: Toast['level'], message: string) {
    const t: Toast = { id: this.toastSeq++, level, message };
    this.patch({ toasts: [...this.state.toasts, t] });
    setTimeout(() => this.dismissToast(t.id), 4000);
  }

  dismissToast(id: number) {
    this.patch({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  // -- Host message handling --------------------------------------------------
  apply(msg: HostToWebview) {
    switch (msg.type) {
      case 'conversation':
        this.patch({
          conversation: msg.conversation,
          streaming: false,
          streamNodeId: null,
        });
        break;
      case 'turnStarted':
        this.beginTurn(msg.nodeId);
        break;
      case 'selectionContext':
        this.patch({ selectionContext: msg.context });
        break;
      case 'stream':
        this.applyStream(msg.event);
        break;
      case 'gateUpdate':
        this.upsertGate(msg.card);
        break;
      case 'turnFinished':
        this.finishTurn(msg.nodeId, msg.usage);
        break;
      case 'changeset':
        this.patch({ changeset: msg.view });
        // Host sends a changeset in response to an openDiff request → review it.
        if (msg.view && this.state.view === 'chat') this.patch({ view: 'diff' });
        // The changeset went away (e.g. applied/discarded) while reviewing it →
        // don't strand the user on an empty diff view.
        if (!msg.view && this.state.view === 'diff') this.patch({ view: 'chat' });
        break;
      case 'rebaseState':
        this.patch({ rebase: msg.state });
        break;
      case 'commitMessage':
        this.patch({ commitMessage: msg.message });
        break;
      case 'applied':
        if (msg.error) this.pushToast('error', msg.error);
        else this.pushToast('info', msg.committed ? `Committed ${msg.sha ?? ''}`.trim() : 'Applied to disk');
        break;
      case 'conversationList':
        this.patch({ historyItems: msg.items });
        break;
      case 'exported':
        void navigator.clipboard?.writeText(msg.content).catch(() => {});
        this.pushToast('info', `Copied as ${msg.format === 'markdown' ? 'Markdown' : 'JSON'}`);
        break;
      case 'settings':
        this.applySettings(msg.settings);
        break;
      case 'modelsFetched':
        this.patch({
          modelsFetched: { ...this.state.modelsFetched, [msg.providerId]: msg.models },
          modelsError: { ...this.state.modelsError, [msg.providerId]: msg.error },
        });
        break;
      case 'showView':
        this.setView(msg.view);
        break;
      case 'toast':
        this.pushToast(msg.level, msg.message);
        break;
    }
  }

  private applySettings(settings: FowlPlaySettings) {
    const firstBoot = !this.state.bootstrapped;
    let view = this.state.view;
    if (firstBoot && settings.providers.length === 0 && !this.state.conversation) {
      view = 'onboarding';
    }
    applyAppearance(settings.appearance);
    this.patch({ settings, bootstrapped: true, view });
  }

  // -- Streaming --------------------------------------------------------------
  private cloneConversation(): Conversation | null {
    const c = this.state.conversation;
    if (!c) return null;
    return { ...c, nodes: { ...c.nodes } };
  }

  private beginTurn(nodeId: string) {
    const conv = this.cloneConversation();
    if (!conv) {
      this.patch({ streaming: true, streamNodeId: nodeId });
      return;
    }
    if (!conv.nodes[nodeId]) {
      const node: MessageNode = {
        id: nodeId,
        parentId: conv.currentLeafId,
        role: 'assistant',
        blocks: [],
        createdAt: Date.now(),
        model: conv.model ?? undefined,
      };
      conv.nodes[nodeId] = node;
      conv.currentLeafId = nodeId;
    }
    this.patch({ conversation: conv, streaming: true, streamNodeId: nodeId });
  }

  private mutateStreamNode(fn: (node: MessageNode) => void) {
    const id = this.state.streamNodeId;
    const conv = this.cloneConversation();
    if (!conv || !id || !conv.nodes[id]) return;
    const node: MessageNode = { ...conv.nodes[id], blocks: [...conv.nodes[id].blocks] };
    fn(node);
    conv.nodes[id] = node;
    this.patch({ conversation: conv });
  }

  private applyStream(event: import('../../shared/types').StreamEvent) {
    switch (event.type) {
      case 'text':
        this.mutateStreamNode((node) => {
          const last = node.blocks[node.blocks.length - 1];
          if (last && last.type === 'text') {
            node.blocks[node.blocks.length - 1] = { type: 'text', text: last.text + event.delta };
          } else {
            node.blocks.push({ type: 'text', text: event.delta });
          }
        });
        break;
      case 'thinking':
        this.mutateStreamNode((node) => {
          const last = node.blocks[node.blocks.length - 1];
          if (last && last.type === 'thinking') {
            node.blocks[node.blocks.length - 1] = { type: 'thinking', text: last.text + event.delta };
          } else {
            node.blocks.push({ type: 'thinking', text: event.delta });
          }
        });
        break;
      case 'tool_call_start':
        this.mutateStreamNode((node) => {
          const call: ToolCallRecord = { id: event.id, name: event.name, args: '', resultSummary: '', ok: true };
          node.blocks.push({ type: 'tool_call', call });
        });
        break;
      case 'tool_call_args':
        this.mutateStreamNode((node) => {
          const idx = this.findToolBlock(node.blocks, event.id);
          if (idx >= 0) {
            const b = node.blocks[idx] as Extract<ContentBlock, { type: 'tool_call' }>;
            const prev = typeof b.call.args === 'string' ? b.call.args : '';
            node.blocks[idx] = { type: 'tool_call', call: { ...b.call, args: prev + event.delta } };
          }
        });
        break;
      case 'tool_call_end':
        break;
      case 'usage':
        this.mutateStreamNode((node) => {
          node.usage = event.usage;
        });
        break;
      case 'error':
        this.mutateStreamNode((node) => {
          node.blocks.push({ type: 'error', message: event.message });
        });
        break;
      case 'done':
        this.patch({ streaming: false });
        break;
    }
  }

  private findToolBlock(blocks: ContentBlock[], id: string): number {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.type === 'tool_call' && b.call.id === id) return i;
    }
    return -1;
  }

  private upsertGate(card: import('../../shared/types').GateCard) {
    const id = this.state.streamNodeId ?? this.state.conversation?.currentLeafId ?? null;
    const conv = this.cloneConversation();
    if (!conv || !id || !conv.nodes[id]) return;
    const node: MessageNode = { ...conv.nodes[id], blocks: [...conv.nodes[id].blocks] };
    const idx = node.blocks.findIndex((b) => b.type === 'gate' && b.card.id === card.id);
    if (idx >= 0) node.blocks[idx] = { type: 'gate', card };
    else node.blocks.push({ type: 'gate', card });
    conv.nodes[id] = node;
    this.patch({ conversation: conv });
  }

  private finishTurn(nodeId: string, usage: TokenUsage) {
    const conv = this.cloneConversation();
    if (conv && conv.nodes[nodeId]) {
      // Set the node's own usage for immediate display, but do NOT fold it into
      // usageTotals here: the host always sends the authoritative `conversation`
      // right after `turnFinished`, and it carries the correct totals. Adding
      // here too would double-count.
      conv.nodes[nodeId] = { ...conv.nodes[nodeId], usage };
      this.patch({ conversation: conv, streaming: false, streamNodeId: null });
    } else {
      this.patch({ streaming: false, streamNodeId: null });
    }
  }
}

export const store = new Store();

// Wire the bridge exactly once.
let wired = false;
export function initStore() {
  if (wired) return;
  wired = true;
  const bridge = getBridge();
  bridge.onMessage((msg) => store.apply(msg));
}

/** Post a message to the host. */
export function post(msg: WebviewToHost) {
  getBridge().post(msg);
}

/** Apply appearance settings to the document root (theme + font + scale). */
export function applyAppearance(a: import('../../shared/types').AppearanceSettings) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', a.theme);
  const fam = a.fontFamily || 'JetBrains Mono';
  root.style.setProperty('--fp-font', `"${fam}", "Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`);
  root.style.setProperty('--fp-scale', String(a.fontScale || 1));
}

/** Subscribe a component to the whole store. */
export function useStore<T>(selector: (s: AppState) => T): T {
  const [, setTick] = useState(0);
  useEffect(() => store.subscribe(() => setTick((t) => t + 1)), []);
  return selector(store.state);
}

// ---------------------------------------------------------------------------
// Conversation path helpers
// ---------------------------------------------------------------------------

export function activePath(conv: Conversation | null): MessageNode[] {
  if (!conv || !conv.currentLeafId) return [];
  const path: MessageNode[] = [];
  let id: string | null = conv.currentLeafId;
  const seen = new Set<string>();
  while (id && conv.nodes[id] && !seen.has(id)) {
    seen.add(id);
    path.unshift(conv.nodes[id]);
    id = conv.nodes[id].parentId;
  }
  return path;
}

/** Siblings of a node (nodes sharing its parent), in creation order. */
export function siblingInfo(conv: Conversation | null, node: MessageNode): { index: number; count: number; ids: string[] } {
  if (!conv) return { index: 0, count: 1, ids: [node.id] };
  const siblingIds = node.parentId === null
    ? conv.rootIds
    : Object.values(conv.nodes)
        .filter((n) => n.parentId === node.parentId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((n) => n.id);
  const ids = siblingIds.length ? siblingIds : [node.id];
  return { index: Math.max(0, ids.indexOf(node.id)), count: ids.length, ids };
}
