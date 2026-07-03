/**
 * Conversation tree — branches, rewind, rerun, fork, sibling navigation.
 *
 * A {@link Conversation} is a tree of {@link MessageNode}s plus a
 * `currentLeafId`; the active path is root -> currentLeaf. All operations here
 * are immutable-style: they return a NEW Conversation and never mutate the one
 * passed in (nodes are treated as immutable and replaced wholesale). This keeps
 * branching safe — editing a past message forks a sibling while the original
 * path stays intact.
 */

import type {
  Conversation,
  ContentBlock,
  HarnessMode,
  MessageNode,
  ModelRef,
  TokenUsage,
} from '../../shared/types';

// ---------------------------------------------------------------------------
// Id / timestamp helpers
//
// `now()` is monotonic (strictly increasing) so sibling creation order can be
// recovered from createdAt even when several nodes are made within one ms.
// ---------------------------------------------------------------------------

let _lastNow = 0;
let _seq = 0;

function now(): number {
  const t = Date.now();
  _lastNow = t > _lastNow ? t : _lastNow + 1;
  return _lastNow;
}

function uid(prefix: string): string {
  _seq++;
  return `${prefix}_${now().toString(36)}_${_seq.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
}

/** Shallow-immutable clone of a conversation (containers copied, nodes shared). */
function cloneConv(c: Conversation): Conversation {
  return {
    ...c,
    nodes: { ...c.nodes },
    rootIds: [...c.rootIds],
    usageTotals: { ...c.usageTotals },
    stagingSnapshots: c.stagingSnapshots ? { ...c.stagingSnapshots } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Construction & appends
// ---------------------------------------------------------------------------

export function createConversation(model: ModelRef | null, harnessMode: HarnessMode): Conversation {
  const t = now();
  return {
    id: uid('conv'),
    title: 'New Conversation',
    nodes: {},
    rootIds: [],
    currentLeafId: null,
    model,
    harnessMode,
    createdAt: t,
    updatedAt: t,
    usageTotals: emptyUsage(),
    stagingSnapshots: {},
  };
}

export function appendUser(
  conv: Conversation,
  blocks: ContentBlock[],
): { conv: Conversation; nodeId: string } {
  const c = cloneConv(conv);
  const id = uid('msg');
  const node: MessageNode = {
    id,
    parentId: c.currentLeafId,
    role: 'user',
    blocks,
    createdAt: now(),
  };
  c.nodes[id] = node;
  if (node.parentId === null) c.rootIds.push(id);
  c.currentLeafId = id;
  c.updatedAt = now();
  if (c.title === 'New Conversation') {
    const t = firstText(blocks);
    if (t) c.title = truncate(t, 48);
  }
  return { conv: c, nodeId: id };
}

export function appendAssistant(
  conv: Conversation,
  blocks: ContentBlock[] = [],
  opts?: { parentId?: string; model?: ModelRef; usage?: TokenUsage },
): { conv: Conversation; nodeId: string } {
  const c = cloneConv(conv);
  const parentId = opts?.parentId ?? c.currentLeafId;
  const id = uid('msg');
  const node: MessageNode = {
    id,
    parentId,
    role: 'assistant',
    blocks,
    createdAt: now(),
    model: opts?.model,
    usage: opts?.usage,
  };
  c.nodes[id] = node;
  if (parentId === null) c.rootIds.push(id);
  c.currentLeafId = id;
  if (opts?.usage) {
    c.usageTotals = {
      inputTokens: c.usageTotals.inputTokens + opts.usage.inputTokens,
      outputTokens: c.usageTotals.outputTokens + opts.usage.outputTokens,
      cachedTokens: c.usageTotals.cachedTokens + opts.usage.cachedTokens,
    };
  }
  c.updatedAt = now();
  return { conv: c, nodeId: id };
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Root -> current leaf. Empty when there is no current leaf. */
export function activePath(conv: Conversation): MessageNode[] {
  const path: MessageNode[] = [];
  let cur: string | null = conv.currentLeafId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n: MessageNode | undefined = conv.nodes[cur];
    if (!n) break;
    path.push(n);
    cur = n.parentId;
  }
  return path.reverse();
}

/** Children of a node (or roots when parentId is null), in creation order. */
function childrenOf(conv: Conversation, parentId: string | null): MessageNode[] {
  const nodes =
    parentId === null
      ? conv.rootIds.map((id) => conv.nodes[id])
      : Object.values(conv.nodes).filter((n) => n.parentId === parentId);
  return nodes.filter(Boolean).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/** Deepest descendant of `id`, preferring the most recent child at each step. */
function deepestDescendant(conv: Conversation, id: string): string {
  let cur = id;
  const seen = new Set<string>();
  while (!seen.has(cur)) {
    seen.add(cur);
    const kids = childrenOf(conv, cur);
    if (kids.length === 0) return cur;
    cur = kids[kids.length - 1].id; // most recent (sorted ascending)
  }
  return cur;
}

export function siblings(conv: Conversation, nodeId: string): { index: number; count: number } {
  const node = conv.nodes[nodeId];
  if (!node) return { index: 0, count: 0 };
  const sibs = childrenOf(conv, node.parentId);
  return { index: sibs.findIndex((n) => n.id === nodeId), count: sibs.length };
}

/** Move the current leaf onto the previous/next sibling branch of `nodeId`. */
export function switchBranch(
  conv: Conversation,
  nodeId: string,
  dir: 'prev' | 'next',
): Conversation {
  const node = conv.nodes[nodeId];
  if (!node) return conv;
  const sibs = childrenOf(conv, node.parentId);
  const idx = sibs.findIndex((n) => n.id === nodeId);
  if (idx < 0) return conv;
  const target = dir === 'next' ? sibs[idx + 1] : sibs[idx - 1];
  if (!target) return conv; // no sibling in that direction
  const c = cloneConv(conv);
  c.currentLeafId = deepestDescendant(conv, target.id);
  c.updatedAt = now();
  return c;
}

// ---------------------------------------------------------------------------
// Editing / branching
// ---------------------------------------------------------------------------

/** Edit a past message: create a sibling branch with new blocks and move to it. */
export function editMessage(
  conv: Conversation,
  nodeId: string,
  newBlocks: ContentBlock[],
): { conv: Conversation; nodeId: string } {
  const orig = conv.nodes[nodeId];
  if (!orig) throw new Error(`editMessage: unknown node ${nodeId}`);
  const c = cloneConv(conv);
  const id = uid('msg');
  const node: MessageNode = {
    id,
    parentId: orig.parentId,
    role: orig.role,
    blocks: newBlocks,
    createdAt: now(),
    model: orig.model,
  };
  c.nodes[id] = node;
  if (node.parentId === null) c.rootIds.push(id);
  c.currentLeafId = id;
  c.updatedAt = now();
  return { conv: c, nodeId: id };
}

/**
 * Prepare to regenerate an assistant response as a sibling. Moves the current
 * leaf to the parent user node and returns it; the caller then appendAssistant
 * (with that node as parent) to add the sibling response.
 */
export function rerun(
  conv: Conversation,
  assistantNodeId: string,
): { conv: Conversation; parent: MessageNode } {
  const node = conv.nodes[assistantNodeId];
  if (!node) throw new Error(`rerun: unknown node ${assistantNodeId}`);
  if (!node.parentId) throw new Error('rerun: assistant node has no parent to regenerate from');
  const parent = conv.nodes[node.parentId];
  if (!parent) throw new Error('rerun: parent node missing');
  const c = cloneConv(conv);
  c.currentLeafId = parent.id;
  c.updatedAt = now();
  return { conv: c, parent };
}

/** Move the current leaf back to an earlier node (branches remain in the tree). */
export function rewindTo(conv: Conversation, nodeId: string): Conversation {
  if (!conv.nodes[nodeId]) throw new Error(`rewindTo: unknown node ${nodeId}`);
  const c = cloneConv(conv);
  c.currentLeafId = nodeId;
  c.updatedAt = now();
  return c;
}

/**
 * Fork the path root->nodeId into a brand new conversation with fresh ids.
 * Only the path is copied (not sibling branches). Any staging snapshots on the
 * copied nodes are carried over under their new ids; the caller is responsible
 * for cloning the live overlay itself.
 */
export function forkAt(conv: Conversation, nodeId: string): Conversation {
  const path: MessageNode[] = [];
  let cur: string | null = nodeId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const n: MessageNode | undefined = conv.nodes[cur];
    if (!n) break;
    path.unshift(n);
    cur = n.parentId;
  }

  const t = now();
  const fork: Conversation = {
    id: uid('conv'),
    title: conv.title,
    nodes: {},
    rootIds: [],
    currentLeafId: null,
    model: conv.model,
    harnessMode: conv.harnessMode,
    createdAt: t,
    updatedAt: t,
    usageTotals: { ...conv.usageTotals },
    stagingSnapshots: {},
  };

  const idMap = new Map<string, string>();
  let lastId: string | null = null;
  for (const n of path) {
    const nid = uid('msg');
    idMap.set(n.id, nid);
    const parentId = n.parentId ? idMap.get(n.parentId) ?? null : null;
    fork.nodes[nid] = {
      id: nid,
      parentId,
      role: n.role,
      blocks: n.blocks,
      createdAt: now(),
      model: n.model,
      usage: n.usage,
    };
    if (parentId === null) fork.rootIds.push(nid);
    if (conv.stagingSnapshots?.[n.id]) fork.stagingSnapshots![nid] = conv.stagingSnapshots[n.id];
    lastId = nid;
  }
  fork.currentLeafId = lastId;
  return fork;
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

export function autoTitle(conv: Conversation): string {
  for (const n of activePath(conv)) {
    if (n.role === 'user') {
      const t = firstText(n.blocks);
      if (t) return truncate(t, 48);
    }
  }
  const users = Object.values(conv.nodes)
    .filter((n) => n.role === 'user')
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const n of users) {
    const t = firstText(n.blocks);
    if (t) return truncate(t, 48);
  }
  return conv.title || 'New Conversation';
}

function firstText(blocks: ContentBlock[]): string | null {
  for (const b of blocks) {
    if (b.type === 'text' && b.text.trim()) return b.text.trim();
  }
  return null;
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length <= n ? clean : `${clean.slice(0, n - 1).trimEnd()}…`;
}
