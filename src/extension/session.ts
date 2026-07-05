/**
 * Session — the per-tab heart of FowlPlay.
 *
 * One `SessionCore` instance backs one webview tab. It owns a conversation tree,
 * a staging overlay + changeset, the current model / harness mode, and an
 * AbortController per turn. It implements the full `WebviewToHost` message switch
 * and emits `HostToWebview` messages.
 *
 * IMPORTANT — testability: this module imports ONLY from `src/core` and
 * `src/shared` (never `vscode`), so it can be unit-tested under vitest. All host
 * concerns (filesystem, secret storage, persistence, git, posting messages to a
 * real webview) are injected as narrow ports via `createSessionCore(deps)`. The
 * thin vscode glue that constructs those ports lives in `tabManager.ts`.
 */

import type {
  AppearanceSettings,
  ChangeSetView,
  CommitRecord,
  Conversation,
  ContentBlock,
  ConversationSummary,
  CoopRole,
  FowlPlaySettings,
  GateCard,
  HarnessMode,
  HarnessSettings,
  MessageNode,
  ModelRef,
  ProviderConfig,
  SdkType,
  SelectionContext,
  SerializedOverlay,
  Skill,
  SkillMeta,
  StreamEvent,
  TokenUsage,
  ToolSpec,
} from '../shared/types';
import type { Attachment, HostToWebview, WebviewToHost } from '../shared/protocol';

import { createAdapter as coreCreateAdapter, type ProviderAdapter, type WireAssistantPart, type WireMessage, type WireUserPart } from '../core/providers/adapter';
import { fetchModels as coreFetchModels, type FetchModelsConfig } from '../core/providers/registry';
import { runAgentLoop } from '../core/agent/loop';
import { buildToolSpecs, type DirEntry, type GrepMatch, type GrepOptions, type StageOp, type ToolHost } from '../core/agent/tools';
import { BUNDLED_SKILLS, formatSkillCatalog, parseSkill } from '../core/agent/skills';
import { gcHistory } from '../core/agent/contextGc';
import { trimWireToBudget, wireTokens } from '../core/agent/contextBudget';
import { StagingOverlay, type DiskReader } from '../core/staging/overlay';
import { ChangeSet } from '../core/staging/changeset';
import { detectDrift, rebase as coreRebase } from '../core/staging/rebase';
import { renderHunkDiff } from '../core/diff/compute';
import {
  ContextExceededError,
  runCoopPipeline,
  type ChangesetInspector,
  type CoopResult,
  type RoleRunner,
} from '../core/harness/coop';
import {
  FOREMAN_SYSTEM,
  composeStoryPrompt,
  parseForeman,
  renderSpecMarkdown,
  specRelPath,
  type PrdPlan,
  type PrdStory,
} from '../core/harness/prd';
import {
  createCard,
  joinSections,
  numberedList,
  section,
  transition,
} from '../core/harness/evidence';
import {
  appendAssistant,
  appendUser,
  createConversation,
  editMessage as treeEditMessage,
  forkAt,
  rerun as treeRerun,
  rewindTo as treeRewindTo,
  switchBranch as treeSwitchBranch,
} from '../core/conversation/tree';
import { toJSON, toMarkdown } from '../core/conversation/serialize';
import {
  isDirectiveOnly,
  matchModels,
  parseModelMentions,
  type MentionRole,
  type ModelMatch,
} from '../core/agent/modelMentions';

// ---------------------------------------------------------------------------
// Injected ports (implemented by the vscode layer or by test fakes)
// ---------------------------------------------------------------------------

/** Filesystem the session reads/writes through. `read`/`exists` also satisfy DiskReader. */
export interface DiskIo extends DiskReader {
  listDir(path: string): Promise<DirEntry[]>;
  glob(pattern: string): Promise<string[]>;
  grep(pattern: string, opts: GrepOptions): Promise<GrepMatch[]>;
  /** Write a file, creating parent directories as needed. */
  write(path: string, content: string): Promise<void>;
  /** Delete a file (no error if it is already gone). */
  remove(path: string): Promise<void>;
}

export interface SecretsPort {
  get(providerId: string): Promise<string | undefined>;
  set(providerId: string, key: string): Promise<void>;
  delete(providerId: string): Promise<void>;
}

export interface SettingsPort {
  load(): Promise<FowlPlaySettings>;
  saveAppearance(a: AppearanceSettings): Promise<void>;
  saveHarness(h: HarnessSettings): Promise<void>;
  saveProviders(providers: ProviderConfig[]): Promise<void>;
  saveDefaultModel(model: ModelRef | null): Promise<void>;
}

export interface HistoryPort {
  list(query?: string): Promise<ConversationSummary[]>;
  load(id: string): Promise<Conversation | null>;
  save(conv: Conversation): Promise<void>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface GitPort {
  isRepo(): Promise<boolean>;
  commit(paths: string[], message: string, coAuthor: boolean): Promise<{ sha: string }>;
  head(): Promise<{ sha: string; branch: string } | null>;
}

export interface SessionDeps {
  io: DiskIo;
  secrets: SecretsPort;
  settings: SettingsPort;
  history: HistoryPort;
  git?: GitPort;
  /** Emit a message to the webview. */
  post(msg: HostToWebview): void;
  /**
   * Called after this session commits a settings mutation (provider add/update/
   * delete, default-model change, appearance, harness). Lets the host broadcast a
   * reload to sibling sessions so they refresh their own settings caches. Fired
   * after the save + local re-send, so the shared store on disk is current when
   * siblings reload. Never invoked by `reloadSettings` (that would loop).
   */
  onSettingsChanged?: () => void;
  /** Open a new tab seeded with a forked conversation + copied staging. */
  openTab?: (conv: Conversation, overlay: SerializedOverlay) => void;
  /** Injectable for tests; defaults to the real core factory. */
  createAdapter?: (sdk: SdkType) => ProviderAdapter;
  fetchModels?: (cfg: FetchModelsConfig, apiKey?: string) => Promise<{ id: string; contextWindow?: number }[]>;
  clock?: () => number;
}

// ---------------------------------------------------------------------------
// System prompts
// ---------------------------------------------------------------------------

const SOLO_SYSTEM = `You are FowlPlay, an AI coding partner working inside a VS Code workspace.
You have tools to read, search, and edit files. All edits go to an in-memory staging
layer that the user reviews as a diff before anything touches disk — never claim a file
was written to disk. Locate files yourself with glob/grep/list_dir; read before you edit;
keep edits precise and anchored. Batch multiple file opens or edits into a single tool call
when you can. When you are done, briefly summarize what you changed.`;

const READONLY_TOOL_NAMES = new Set(['open_files', 'list_dir', 'glob', 'grep']);

// ---------------------------------------------------------------------------
// Session core
// ---------------------------------------------------------------------------

export class SessionCore {
  private readonly deps: SessionDeps;
  private readonly createAdapter: (sdk: SdkType) => ProviderAdapter;
  private readonly fetchModels: (cfg: FetchModelsConfig, apiKey?: string) => Promise<{ id: string; contextWindow?: number }[]>;
  private readonly clock: () => number;

  private conv: Conversation;
  private overlay: StagingOverlay;
  private changeset: ChangeSet;
  private settingsCache: FowlPlaySettings | null = null;
  private abort: AbortController | null = null;
  /** Monotonic counter for disk-only applies that have no commit sha. */
  private appliedSeq = 0;

  /** A highlighted editor region pinned as scoped context for the NEXT prompt. */
  private pendingSelection: SelectionContext | null = null;

  /**
   * A prompt held while the webview disambiguates one or more model mentions that
   * matched more than one configured model. `queue[0]` is the choice currently
   * surfaced; each `resolveModelMention` shifts it. When the queue drains the held
   * prompt is released (run as a turn, or applied silently if directive-only).
   */
  private heldMention: {
    text: string;
    attachments?: Attachment[];
    queue: { role: MentionRole; query: string; candidates: ModelMatch[] }[];
    assignments: string[];
    /** Carried through the disambiguation so a held PRD prompt still decomposes on release. */
    prd?: boolean;
  } | null = null;

  /**
   * Skills available for the current turn (bundled defaults + workspace
   * `.fowlplay/skills/*.md`), rediscovered at the start of each turn. Consumed by
   * `toolHost()` (for `load_skill`) and the system-prompt catalog injection.
   */
  private turnSkills: Skill[] = [];

  /** Full (un-GC'd) wire history ending at each assistant node id, for follow-up turns. */
  private wireByNode = new Map<string, WireMessage[]>();

  private readonly allTools: ToolSpec[] = buildToolSpecs();
  private readonly readOnlyTools: ToolSpec[] = this.allTools.filter((t) => READONLY_TOOL_NAMES.has(t.name));

  constructor(deps: SessionDeps, initial?: { conversation?: Conversation; overlay?: SerializedOverlay }) {
    this.deps = deps;
    this.createAdapter = deps.createAdapter ?? coreCreateAdapter;
    this.fetchModels = deps.fetchModels ?? coreFetchModels;
    this.clock = deps.clock ?? Date.now;

    this.conv = initial?.conversation ?? createConversation(null, 'coop');
    this.overlay = initial?.overlay
      ? StagingOverlay.deserialize(initial.overlay, deps.io)
      : new StagingOverlay(deps.io);
    this.changeset = new ChangeSet(this.overlay, 'changeset');
  }

  /** Current conversation (used by the tab manager for fork/duplicate). */
  get conversation(): Conversation {
    return this.conv;
  }

  /**
   * Pin a highlighted editor region as scoped context for the next prompt
   * ("Edit Selection"). Stored host-side so it survives even if the webview
   * misses the chip message; consumed once by the next `sendPrompt`.
   */
  receiveSelection(ctx: SelectionContext): void {
    this.pendingSelection = ctx;
    this.deps.post({ type: 'selectionContext', context: ctx });
  }

  // -------------------------------------------------------------------------
  // Message dispatch
  // -------------------------------------------------------------------------

  async handle(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this.onReady();
        return;
      case 'sendPrompt':
        await this.onSendPrompt(msg.text, msg.attachments, msg.prd);
        return;
      case 'continueStoryLoop':
        await this.onContinueStoryLoop();
        return;
      case 'cancelResponse':
        this.abort?.abort();
        return;
      case 'clearSelection':
        this.pendingSelection = null;
        this.deps.post({ type: 'selectionContext', context: null });
        return;
      case 'editMessage':
        await this.onEditMessage(msg.nodeId, msg.text);
        return;
      case 'rerunMessage':
        await this.onRerun(msg.nodeId);
        return;
      case 'rewindTo':
        this.applyTreeChange(treeRewindTo(this.conv, msg.nodeId));
        return;
      case 'switchBranch':
        this.applyTreeChange(treeSwitchBranch(this.conv, msg.nodeId, msg.direction));
        return;
      case 'forkConversation':
        await this.onFork(msg.nodeId);
        return;
      case 'duplicateConversation':
        await this.onFork(this.conv.currentLeafId ?? undefined);
        return;
      case 'setModel':
        this.conv = { ...this.conv, model: msg.model, updatedAt: this.clock() };
        this.sendConversation();
        void this.persist();
        // Remember this as the default so new conversations (and onboarding's
        // model pick) inherit it instead of reopening on "Select model".
        void this.deps.settings.saveDefaultModel(msg.model);
        if (this.settingsCache) this.settingsCache = { ...this.settingsCache, defaultModel: msg.model };
        this.deps.onSettingsChanged?.();
        return;
      case 'setHarnessMode':
        this.conv = { ...this.conv, harnessMode: msg.mode, updatedAt: this.clock() };
        this.sendConversation();
        void this.persist();
        return;
      case 'resolveModelMention':
        await this.onResolveModelMention(msg.role, msg.model);
        return;
      case 'openDiff':
        this.sendChangeset(msg.changesetId);
        return;
      case 'toggleRevert':
        this.changeset.toggleRevert(msg.hunkId, msg.reverted);
        this.sendChangeset();
        return;
      case 'setComment':
        this.changeset.setComment(msg.hunkId, msg.comment);
        this.sendChangeset();
        return;
      case 'sendFeedback':
        await this.onSendFeedback();
        return;
      case 'applyToDisk':
        await this.onApply(false, undefined, false);
        return;
      case 'applyAndCommit':
        await this.onApply(true, msg.message, msg.coAuthor);
        return;
      case 'requestCommitMessage':
        await this.onRequestCommitMessage();
        return;
      case 'rebase':
        await this.onRebase();
        return;
      case 'listConversations':
        this.deps.post({ type: 'conversationList', items: await this.deps.history.list(msg.query) });
        return;
      case 'openConversation':
        await this.onOpenConversation(msg.id);
        return;
      case 'renameConversation':
        await this.deps.history.rename(msg.id, msg.title);
        if (msg.id === this.conv.id) {
          this.conv = { ...this.conv, title: msg.title };
          this.sendConversation();
        }
        return;
      case 'deleteConversation':
        await this.onDeleteConversation(msg.id);
        return;
      case 'exportConversation':
        this.deps.post({
          type: 'exported',
          format: msg.format,
          content: msg.format === 'markdown' ? toMarkdown(this.conv) : toJSON(this.conv),
        });
        return;
      case 'newConversation':
        await this.onNewConversation();
        return;
      case 'getSettings':
        // Force a disk read: cheap, and it guards against any missed broadcast
        // (e.g. a settings mutation in a sibling surface that never reached here).
        await this.sendSettings(true);
        return;
      case 'saveAppearance':
        await this.deps.settings.saveAppearance(msg.appearance);
        await this.sendSettings(true);
        this.deps.onSettingsChanged?.();
        return;
      case 'saveHarnessSettings':
        await this.deps.settings.saveHarness(msg.harness);
        await this.sendSettings(true);
        this.deps.onSettingsChanged?.();
        return;
      case 'addProvider':
      case 'updateProvider':
        await this.onSaveProvider(msg.provider, msg.apiKey);
        return;
      case 'deleteProvider':
        await this.onDeleteProvider(msg.providerId);
        return;
      case 'fetchModels':
        await this.onFetchModels(msg.providerId);
        return;
      default:
        return;
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle / sync
  // -------------------------------------------------------------------------

  private async onReady(): Promise<void> {
    await this.sendSettings();
    // A brand-new conversation inherits the default model / harness mode.
    if (this.conv.currentLeafId === null && this.conv.model === null && this.settingsCache) {
      this.conv = {
        ...this.conv,
        model: this.settingsCache.defaultModel,
        harnessMode: this.settingsCache.harness.defaultMode,
      };
    }
    this.sendConversation();
    if (!this.overlay.isEmpty()) this.sendChangeset();
    // A selection delivered before the webview mounted (freshly opened tab) had
    // its chip message dropped; re-surface it now that the webview is listening.
    if (this.pendingSelection) this.deps.post({ type: 'selectionContext', context: this.pendingSelection });
  }

  /**
   * Force-reload settings from the shared store and re-send them, then — if this
   * session's conversation is still brand-new and modelless — adopt the freshly
   * loaded default model / harness mode (mirroring `onReady`'s inheritance) and
   * re-send the conversation. This is how a sibling surface (e.g. the sidebar
   * stuck on "Select model") flips to ready the moment a provider is added in a
   * tab. Must NOT invoke `onSettingsChanged` — that would loop the broadcast.
   */
  async reloadSettings(): Promise<void> {
    await this.sendSettings(true);
    if (this.conv.currentLeafId === null && this.conv.model === null && this.settingsCache) {
      this.conv = {
        ...this.conv,
        model: this.settingsCache.defaultModel,
        harnessMode: this.settingsCache.harness.defaultMode,
      };
      this.sendConversation();
    }
  }

  private async ensureSettings(): Promise<FowlPlaySettings> {
    if (!this.settingsCache) this.settingsCache = await this.deps.settings.load();
    return this.settingsCache;
  }

  private async sendSettings(forceReload = false): Promise<void> {
    if (forceReload) this.settingsCache = null;
    const settings = await this.ensureSettings();
    // Attach discovered skills so the Settings UI can show what is available.
    // Not part of the persisted settings — recomputed on demand, never cached.
    const skills = toSkillMetas(await this.discoverSkills());
    this.deps.post({ type: 'settings', settings: { ...settings, skills } });
  }

  private sendConversation(): void {
    this.deps.post({ type: 'conversation', conversation: this.conv });
  }

  /**
   * Post a changeset to the webview. With no id (or an id that is not a frozen
   * historical changeset) this serves the live staging layer. When `changesetId`
   * names a frozen committed changeset it serves that immutable snapshot instead,
   * regardless of the live overlay's state — the entry point for read-only
   * "View Changes" on a historical commit block.
   */
  private sendChangeset(changesetId?: string): void {
    if (changesetId) {
      const frozen = this.conv.committedChangesets?.[changesetId];
      if (frozen) {
        this.deps.post({ type: 'changeset', view: frozen });
        return;
      }
    }
    this.deps.post({ type: 'changeset', view: this.overlay.isEmpty() ? null : this.changeset.view() });
  }

  private async persist(): Promise<void> {
    this.conv = { ...this.conv, stagingSnapshots: this.conv.stagingSnapshots };
    try {
      await this.deps.history.save(this.conv);
    } catch {
      /* persistence is best-effort */
    }
  }

  // -------------------------------------------------------------------------
  // Turn flow
  // -------------------------------------------------------------------------

  /**
   * Entry point for a user prompt. Before anything is appended to the tree, the
   * text is scanned for per-role model directives ("qwen to orchestrate",
   * "use glm for review", role-less "switch to qwen"). Each mention resolves to
   * 0, 1, or >1 configured models:
   *   0  → warn and ignore that mention.
   *   1  → apply it (conversation model or a per-role override).
   *   >1 → hold the ENTIRE prompt and ask the webview to disambiguate.
   * Once mentions are settled, a directive-ONLY message applies without running a
   * turn; otherwise the turn runs with the ORIGINAL full text (mentions are not
   * stripped from what the model sees — keeping history honest is harmless).
   */
  private async onSendPrompt(text: string, attachments?: Attachment[], prd?: boolean): Promise<void> {
    const trimmed = text.trim();
    const atts = attachments ?? [];
    if (!trimmed && atts.length === 0) return;

    // A new prompt supersedes any prompt still held behind an unanswered
    // disambiguation — otherwise answering the stale picker later would
    // release (and run) the abandoned message.
    this.heldMention = null;

    const settings = await this.ensureSettings();
    const mentions = parseModelMentions(text);
    const assignments: string[] = [];
    const queue: { role: MentionRole; query: string; candidates: ModelMatch[] }[] = [];

    for (const mention of mentions) {
      const candidates = matchModels(mention.query, settings.providers);
      if (candidates.length === 0) {
        this.toast('warn', `No configured model matches "${mention.query}"`);
        continue;
      }
      if (candidates.length === 1) {
        this.applyMention(mention.role, refOf(candidates[0]));
        assignments.push(assignmentLabel(mention.role, candidates[0].label));
        continue;
      }
      queue.push({ role: mention.role, query: mention.query, candidates });
    }

    if (queue.length > 0) {
      // Hold the whole prompt (selection stays pinned) until every ambiguity is
      // resolved; surface the first choice now.
      this.heldMention = { text, attachments, queue, assignments, prd };
      const first = queue[0];
      this.deps.post({
        type: 'modelMentionChoice',
        role: first.role,
        query: first.query,
        candidates: first.candidates.map((c) => ({ providerId: c.providerId, modelId: c.modelId, label: c.label })),
      });
      return;
    }

    await this.finishMentions(text, attachments, assignments, prd);
  }

  /** Resolve one held ambiguity, then advance the queue or release the prompt. */
  private async onResolveModelMention(role: MentionRole, model: ModelRef | null): Promise<void> {
    const held = this.heldMention;
    if (!held) return;
    if (model) {
      const label = this.labelForRef(model);
      this.applyMention(role, model);
      held.assignments.push(assignmentLabel(role, label));
    } else {
      this.toast('info', `Sent without changing the ${roleWord(role)} model`);
    }
    held.queue.shift();
    if (held.queue.length > 0) {
      const next = held.queue[0];
      this.deps.post({
        type: 'modelMentionChoice',
        role: next.role,
        query: next.query,
        candidates: next.candidates.map((c) => ({ providerId: c.providerId, modelId: c.modelId, label: c.label })),
      });
      return;
    }
    this.heldMention = null;
    await this.finishMentions(held.text, held.attachments, held.assignments, held.prd);
  }

  /** Apply a resolved mention to the conversation (role override or the model itself). */
  private applyMention(role: MentionRole, model: ModelRef): void {
    if (role === 'conversation') {
      // setModel semantics WITHOUT saving as the global default — a chat directive
      // steers this conversation only.
      this.conv = { ...this.conv, model, updatedAt: this.clock() };
    } else {
      const roleModelOverrides = { ...(this.conv.roleModelOverrides ?? {}), [role]: model };
      this.conv = { ...this.conv, roleModelOverrides, updatedAt: this.clock() };
    }
  }

  /**
   * After mentions are settled: persist any assignments, then either apply-only
   * (directive-only message: no turn, just a confirmation toast) or run the turn
   * with the original full text.
   */
  private async finishMentions(text: string, attachments: Attachment[] | undefined, assignments: string[], prd?: boolean): Promise<void> {
    if (assignments.length > 0) {
      this.sendConversation();
      await this.persist();
    }
    // Only short-circuit when something was actually applied AND nothing but
    // directives remain. A message whose "mentions" all matched nothing (e.g.
    // "use the foo skill") still runs as an ordinary turn.
    if (assignments.length > 0 && isDirectiveOnly(text)) {
      this.toast('info', assignments.join(', '));
      return;
    }
    await this.runPromptTurn(text, attachments, prd);
  }

  private async runPromptTurn(text: string, attachments?: Attachment[], prd?: boolean): Promise<void> {
    const trimmed = text.trim();
    const atts = attachments ?? [];
    if (!trimmed && atts.length === 0) return;

    // A pinned "Edit Selection" region applies to exactly one turn. Consume it
    // now so a follow-up prompt without a fresh selection is unscoped.
    const selection = this.pendingSelection;
    this.pendingSelection = null;

    // Text-like files are inlined into the prompt so they persist in the tree
    // and replay on branch/resume; images are passed as image wire parts for
    // this turn (there is no image content block to persist them in).
    const images = atts.filter((a) => a.mimeType.startsWith('image/'));
    const textFiles = atts.filter((a) => !a.mimeType.startsWith('image/'));

    // Prepend the highlighted region as a pinned context block (mirrors the
    // attachment-inlining style) so it folds into the user node's text and
    // naturally persists / replays on branch or resume.
    let displayText = trimmed;
    if (selection) {
      const label = selection.languageId || selection.path;
      const header = `The user highlighted lines ${selection.startLine}–${selection.endLine} of \`${selection.path}\`. Scope the change to this selection unless related code must change too.`;
      displayText = `${header}\n\n${fencedBlock(label, selection.text)}\n\n${displayText}`;
    }
    for (const f of textFiles) {
      displayText += `\n\n${fencedBlock(f.name, f.data)}`;
    }
    for (const img of images) {
      displayText += `\n\n_[Attached image: ${img.name}]_`;
    }

    const imageParts: WireUserPart[] = images.map((a) => ({
      type: 'image',
      image: { mimeType: a.mimeType, data: a.data },
    }));

    // The selection has been folded into this turn's prompt — clear the chip.
    if (selection) this.deps.post({ type: 'selectionContext', context: null });

    const { conv, nodeId } = appendUser(this.conv, [{ type: 'text', text: displayText || '(see attachments)' }]);
    this.conv = conv;
    await this.runAssistantTurn(nodeId, imageParts, { prd });
  }

  private async onEditMessage(nodeId: string, text: string): Promise<void> {
    const node = this.conv.nodes[nodeId];
    if (!node) return;
    const { conv, nodeId: newId } = treeEditMessage(this.conv, nodeId, [{ type: 'text', text: text.trim() }]);
    this.conv = conv;
    this.restoreOverlayFor(newId);
    await this.runAssistantTurn(newId);
  }

  private async onRerun(assistantNodeId: string): Promise<void> {
    try {
      const { conv, parent } = treeRerun(this.conv, assistantNodeId);
      this.conv = conv;
      this.restoreOverlayFor(parent.id);
      await this.runAssistantTurn(parent.id);
    } catch {
      this.toast('warn', 'Cannot rerun this message.');
    }
  }

  /**
   * The shared turn engine: given a user node, produce an assistant response.
   *
   * `opts.prd` runs the PRD front-end (Foreman decomposition → write specs → build story 1);
   * `opts.storyIndex` runs one story of an existing plan (used by `continueStoryLoop`).
   * With neither, the turn runs an ordinary Coop or Solo response.
   */
  private async runAssistantTurn(
    userNodeId: string,
    imageParts: WireUserPart[] = [],
    opts: { prd?: boolean; storyIndex?: number } = {},
  ): Promise<void> {
    const settings = await this.ensureSettings();
    const resolved = await this.resolveModel();
    if (!resolved) {
      this.toast('error', 'No model configured. Add a provider and pick a model first.');
      this.sendConversation();
      return;
    }

    // Discover skills once for this turn (bundled + workspace). Both run modes
    // read this via `toolHost()` and the system-prompt catalog.
    this.turnSkills = await this.discoverSkills();

    const userNode = this.conv.nodes[userNodeId];
    const userText = firstText(userNode?.blocks ?? []) ?? '';
    const baseWire = this.wireBaseFor(userNodeId);

    // Surface the user's message (and any new branch) before streaming begins,
    // so the prompt is visible for the whole turn and the streaming assistant
    // node parents onto it rather than a stale leaf.
    this.sendConversation();

    const assistant = appendAssistant(this.conv, [], { parentId: userNodeId, model: this.conv.model ?? undefined });
    this.conv = assistant.conv;
    const assistantId = assistant.nodeId;
    this.deps.post({ type: 'turnStarted', nodeId: assistantId });

    this.abort = new AbortController();
    const signal = this.abort.signal;

    let blocks: ContentBlock[] = [];
    let usage: TokenUsage = emptyUsage();
    try {
      if (opts.prd) {
        const out = await this.runPrd(userText, imageParts, baseWire, resolved, settings.harness, signal);
        blocks = out.blocks;
        usage = out.usage;
      } else if (opts.storyIndex !== undefined) {
        const out = await this.runStory(opts.storyIndex, baseWire, resolved, settings.harness, signal);
        blocks = out.blocks;
        usage = out.usage;
      } else if (this.conv.harnessMode === 'coop') {
        const out = await this.runCoop(userText, imageParts, baseWire, resolved, settings.harness, signal);
        blocks = out.blocks;
        usage = out.usage;
      } else {
        const out = await this.runSolo(userText, imageParts, baseWire, resolved, assistantId, signal);
        blocks = out.blocks;
        usage = out.usage;
      }
    } catch (err) {
      blocks = [{ type: 'error', message: errMessage(err) }];
    }

    if (signal.aborted) {
      this.deps.post({ type: 'stream', event: { type: 'done', stopReason: 'cancelled' } });
    }

    // Append a "Review Changes" block when the turn left staged edits.
    if (!this.overlay.isEmpty()) {
      blocks = [...blocks, { type: 'changes', summary: this.changeset.summary() }];
    }

    this.finalizeAssistant(assistantId, blocks, usage);
    this.snapshotOverlay(assistantId);
    await this.persist();

    this.deps.post({ type: 'turnFinished', nodeId: assistantId, usage });
    this.sendConversation();
    this.abort = null;
  }

  private async runSolo(
    userText: string,
    imageParts: WireUserPart[],
    baseWire: WireMessage[],
    resolved: ResolvedModel,
    assistantId: string,
    signal: AbortSignal,
  ): Promise<{ blocks: ContentBlock[]; usage: TokenUsage }> {
    const settings = await this.ensureSettings();
    const fullHistory: WireMessage[] = [
      ...baseWire,
      { role: 'user', content: [{ type: 'text', text: userText }, ...imageParts] },
    ];
    let sent = gcHistory(fullHistory);

    // Hard context-window management: trim oldest turns to fit the conversation
    // model's payload budget. If the newest turn alone still overruns, surface a
    // friendly error block instead of letting the provider 400 on us.
    const budget = this.payloadBudget(settings);
    if (budget !== undefined) {
      const trimmed = trimWireToBudget(sent, budget);
      sent = trimmed.messages;
      if (wireTokens(sent) > budget) {
        const label = this.roleModelLabel(settings) ?? 'the selected model';
        const window = this.roleWindow(settings);
        return {
          blocks: [{ type: 'error', message: contextExceededMessage(label, window) }],
          usage: emptyUsage(),
        };
      }
    }

    const result = await runAgentLoop({
      adapter: resolved.adapter,
      baseUrl: resolved.baseUrl,
      apiKey: resolved.apiKey,
      modelId: resolved.modelId,
      system: this.systemWithSkills(SOLO_SYSTEM),
      history: sent,
      tools: this.toolsWithSkills(),
      toolHost: this.toolHost(),
      onEvent: (e) => this.deps.post({ type: 'stream', event: e }),
      signal,
    });

    // Store the full (un-GC'd) history so the next turn keeps real context.
    const appended = result.wireHistory.slice(sent.length);
    this.wireByNode.set(assistantId, [...fullHistory, ...appended]);
    return { blocks: result.blocks, usage: result.usage };
  }

  private async runCoop(
    userText: string,
    imageParts: WireUserPart[],
    baseWire: WireMessage[],
    resolved: ResolvedModel,
    harness: HarnessSettings,
    signal: AbortSignal,
  ): Promise<{ blocks: ContentBlock[]; usage: TokenUsage }> {
    const cards: GateCard[] = [];
    const result = await this.runCoopCore(userText, imageParts, baseWire, resolved, harness, signal, cards);

    const blocks: ContentBlock[] = cards.map((card) => ({ type: 'gate', card }));
    const text = this.coopOutcomeText(result);
    if (text) blocks.push({ type: 'text', text });
    return { blocks, usage: result.usage };
  }

  /**
   * Wire up the Coop collaborators (per-role model runner, changeset inspector, Builder
   * loop) and run the pipeline once for `userPrompt`. Emitted gate cards are pushed onto
   * `cards` and streamed to the webview. Shared by ordinary Coop turns and per-story PRD
   * builds — the caller maps the returned outcome to blocks / plan status.
   */
  private async runCoopCore(
    userPrompt: string,
    imageParts: WireUserPart[],
    baseWire: WireMessage[],
    resolved: ResolvedModel,
    harness: HarnessSettings,
    signal: AbortSignal,
    cards: GateCard[],
  ): Promise<CoopResult> {
    const settings = await this.ensureSettings();
    const runner: RoleRunner = {
      run: async ({ role, system, userPrompt: rolePrompt, readOnly, signal: s }) => {
        // Each role resolves its own model through the override chain, falling
        // back to the turn's conversation model.
        const rm = (await this.resolveModel(role)) ?? resolved;
        const res = await runAgentLoop({
          adapter: rm.adapter,
          baseUrl: rm.baseUrl,
          apiKey: rm.apiKey,
          modelId: rm.modelId,
          system,
          history: [{ role: 'user', content: [{ type: 'text', text: rolePrompt }] }],
          tools: readOnly ? this.readOnlyTools : this.allTools,
          toolHost: this.toolHost(),
          onEvent: () => {}, // role calls are summarized as gate cards, not streamed
          maxRounds: 8,
          signal: s,
        });
        return { text: joinText(res.blocks), usage: res.usage };
      },
    };

    const inspector: ChangesetInspector = {
      unifiedDiff: () => renderUnifiedDiff(this.changeset.view()),
      summary: () => {
        const s = this.changeset.summary();
        return { filesChanged: s.filesChanged, additions: s.additions, deletions: s.deletions };
      },
    };

    const buildStage = async (instructions: string, s?: AbortSignal): Promise<TokenUsage> => {
      // The Builder stage uses the `builder` role's resolution.
      const rm = (await this.resolveModel('builder')) ?? resolved;
      const base: WireMessage[] = [
        ...baseWire,
        { role: 'user', content: [{ type: 'text', text: instructions }, ...imageParts] },
      ];
      let history = gcHistory(base);

      // Trim oldest turns to the Builder model's payload budget. If the newest
      // turn alone overruns, throw — the pipeline turns this into a Context limit
      // gate and a `context-exceeded` outcome.
      const budget = this.payloadBudget(settings, 'builder');
      if (budget !== undefined) {
        const trimmed = trimWireToBudget(history, budget);
        history = trimmed.messages;
        const needed = wireTokens(history);
        if (needed > budget) {
          throw new ContextExceededError({
            role: 'builder',
            modelLabel: this.roleModelLabel(settings, 'builder'),
            windowTokens: this.roleWindow(settings, 'builder'),
            neededTokens: needed,
            budgetTokens: budget,
          });
        }
      }

      const res = await runAgentLoop({
        adapter: rm.adapter,
        baseUrl: rm.baseUrl,
        apiKey: rm.apiKey,
        modelId: rm.modelId,
        system: this.systemWithSkills(SOLO_SYSTEM),
        history,
        tools: this.toolsWithSkills(),
        toolHost: this.toolHost(),
        onEvent: (e) => this.deps.post({ type: 'stream', event: e }),
        signal: s,
      });
      // Return the Builder's usage so the pipeline counts it — it is usually the
      // dominant cost of a Coop turn.
      return res.usage;
    };

    return runCoopPipeline({
      userPrompt,
      runner,
      inspector,
      buildStage,
      settings: harness,
      onGate: (card) => {
        upsertCard(cards, card);
        this.deps.post({ type: 'gateUpdate', card });
      },
      modelLabelFor: (role) => this.roleModelLabel(settings, role),
      diffBudgetFor: (role) => this.payloadBudget(settings, role),
      signal,
    });
  }

  /** The explanatory text block for a non-ready Coop outcome (empty for ready-for-review). */
  private coopOutcomeText(result: CoopResult): string {
    switch (result.outcome) {
      case 'blocked':
        return result.question ?? 'The request needs clarification before work can begin.';
      case 'qas-failed':
        return 'The Inspector could not approve the changes within the retry budget. They remain staged for your review.';
      case 'security-blocked':
        return 'Sentry flagged a security concern. The changes remain staged — review carefully before applying.';
      case 'context-exceeded':
        return contextExceededMessage(result.context?.modelLabel ?? 'the selected model', result.context?.windowTokens);
      case 'cancelled':
        return 'Cancelled.';
      case 'ready-for-review':
        return '';
    }
  }

  // -------------------------------------------------------------------------
  // PRD builds (Foreman decomposition → per-story build loop)
  // -------------------------------------------------------------------------

  /**
   * A PRD turn: the Foreman decomposes the PRD into ordered stories (read-only, Scout's
   * model), each story is written to disk as a spec, the plan is stored on the conversation,
   * and story 1 is built immediately within this same turn. A decomposition failure (<2
   * stories, or unparseable output) blocks the Foreman card and creates no plan.
   */
  private async runPrd(
    userText: string,
    imageParts: WireUserPart[],
    baseWire: WireMessage[],
    resolved: ResolvedModel,
    harness: HarnessSettings,
    signal: AbortSignal,
  ): Promise<{ blocks: ContentBlock[]; usage: TokenUsage }> {
    const settings = await this.ensureSettings();
    const usage: TokenUsage = emptyUsage();
    const cards: GateCard[] = [];
    const emit = (card: GateCard): GateCard => {
      upsertCard(cards, card);
      this.deps.post({ type: 'gateUpdate', card });
      return card;
    };
    const gateBlocks = (): ContentBlock[] => cards.map((card) => ({ type: 'gate', card }));

    // --- Foreman gate: decompose the PRD (Scout's model, read-only) ---
    let foremanCard = emit(
      createCard('gate-foreman-1', {
        role: 'foreman',
        title: 'Foreman — PRD decomposition',
        evidence: 'Decomposing the PRD into ordered, independently-buildable stories…',
        modelLabel: this.roleModelLabel(settings, 'scout'),
      }),
    );
    if (signal.aborted) {
      emit(transition(foremanCard, 'failed', { evidence: joinSections(foremanCard.evidence, '_Cancelled by user._') }));
      return { blocks: [...gateBlocks(), { type: 'text', text: 'Cancelled.' }], usage };
    }

    const rm = (await this.resolveModel('scout')) ?? resolved;
    const res = await runAgentLoop({
      adapter: rm.adapter,
      baseUrl: rm.baseUrl,
      apiKey: rm.apiKey,
      modelId: rm.modelId,
      system: FOREMAN_SYSTEM,
      history: [{ role: 'user', content: [{ type: 'text', text: userText }, ...imageParts] }],
      tools: this.readOnlyTools,
      toolHost: this.toolHost(),
      onEvent: () => {},
      maxRounds: 8,
      signal,
    });
    addUsageInPlace(usage, res.usage);
    const foremanUsage = res.usage;

    if (signal.aborted) {
      emit(transition(foremanCard, 'failed', { usage: foremanUsage, evidence: joinSections(foremanCard.evidence, '_Cancelled by user._') }));
      return { blocks: [...gateBlocks(), { type: 'text', text: 'Cancelled.' }], usage };
    }

    const stories = parseForeman(joinText(res.blocks));
    if (stories.length < 2) {
      emit(
        transition(foremanCard, 'blocked', {
          usage: foremanUsage,
          evidence: joinSections(
            section('Could not decompose', 'The PRD did not yield at least two ordered, buildable stories.'),
            section('What to do', 'Rephrase the PRD, split it into clearer deliverables, or send it as a normal request.'),
          ),
        }),
      );
      return {
        blocks: [...gateBlocks(), { type: 'text', text: 'Could not decompose the PRD into stories — rephrase or split it, or send it as a normal request.' }],
        usage,
      };
    }

    // --- Build the plan + write each spec to disk (direct meta-artifacts) ---
    const total = stories.length;
    const plan: PrdPlan = { stories: [], cursor: 0 };
    for (let i = 0; i < total; i += 1) {
      const s = stories[i];
      const specPath = specRelPath(this.conv.id, i + 1, s.title);
      const story: PrdStory = { title: s.title, summary: s.summary, criteria: s.criteria, specPath, status: 'pending' };
      plan.stories.push(story);
      await this.writeSpec(story, i + 1, total);
    }
    this.conv = { ...this.conv, prdPlan: plan };

    emit(
      transition(foremanCard, 'passed', {
        usage: foremanUsage,
        evidence: joinSections(
          section(`Decomposed into ${total} stories`, numberedList(plan.stories.map((s) => s.title))),
          section('Next', 'Building story 1 now; you review between stories.'),
        ),
      }),
    );

    // --- Build story 1 immediately, within this same turn ---
    const story1 = await this.runStory(0, baseWire, resolved, harness, signal);
    addUsageInPlace(usage, story1.usage);

    // Blocks: Foreman gate, the plan marker (renders live), then story 1's cards + outcome.
    return { blocks: [...gateBlocks(), { type: 'plan' }, ...story1.blocks], usage };
  }

  /**
   * Run the Coop pipeline for one story of the current plan, mapping the outcome to the
   * story's status and the explanatory blocks. Updates the story's spec file on disk after
   * each transition (best-effort; rebuilt from plan data if it went missing).
   */
  private async runStory(
    storyIndex: number,
    baseWire: WireMessage[],
    resolved: ResolvedModel,
    harness: HarnessSettings,
    signal: AbortSignal,
  ): Promise<{ blocks: ContentBlock[]; usage: TokenUsage }> {
    const plan = this.conv.prdPlan;
    const story = plan?.stories[storyIndex];
    if (!plan || !story) {
      return { blocks: [{ type: 'text', text: 'No story to build — the plan is missing.' }], usage: emptyUsage() };
    }

    const total = plan.stories.length;
    this.setStoryStatus(storyIndex, 'building');
    await this.writeSpec(this.conv.prdPlan!.stories[storyIndex], storyIndex + 1, total);

    const specMarkdown = renderSpecMarkdown(this.conv.prdPlan!.stories[storyIndex], storyIndex + 1, total);
    const userPrompt = composeStoryPrompt(specMarkdown, storyIndex + 1, total);

    const cards: GateCard[] = [];
    const result = await this.runCoopCore(userPrompt, [], baseWire, resolved, harness, signal, cards);

    const status: PrdStory['status'] =
      result.outcome === 'ready-for-review' ? 'awaiting-review' : result.outcome === 'cancelled' ? 'pending' : 'failed';
    this.setStoryStatus(storyIndex, status);
    await this.writeSpec(this.conv.prdPlan!.stories[storyIndex], storyIndex + 1, total);

    const blocks: ContentBlock[] = cards.map((card) => ({ type: 'gate', card }));
    const text = this.coopOutcomeText(result);
    if (text) blocks.push({ type: 'text', text });
    return { blocks, usage: result.usage };
  }

  /**
   * Advance a PRD build to the next story. Ignored while a turn is streaming. Marks the
   * cursor story done (a failed story continued past is also marked done — the human decided
   * to move on; the `(skipped review)` nuance is recorded only in the spec file). If no
   * stories remain, appends a completion summary; otherwise appends a synthetic user node
   * and runs the next story as a fresh turn (so rewind/branching stay coherent).
   */
  private async onContinueStoryLoop(): Promise<void> {
    if (this.abort) return; // a turn is in flight — ignore
    const plan = this.conv.prdPlan;
    if (!plan) return;
    const i = plan.cursor;
    const current = plan.stories[i];
    if (!current) return;
    if (current.status === 'building') return; // defensive — a turn should be in flight

    // A pending cursor story was cancelled (or never started): Continue means
    // RETRY it, not mark it done and skip past work that never happened.
    if (current.status === 'pending') {
      const { conv, nodeId } = appendUser(this.conv, [
        { type: 'text', text: `Resume story ${i + 1}: ${current.title}` },
      ]);
      this.conv = conv;
      await this.runAssistantTurn(nodeId, [], { storyIndex: i });
      return;
    }

    const skippedReview = current.status === 'failed';
    const stories = plan.stories.map((s, idx) => (idx === i ? { ...s, status: 'done' as const } : s));
    const nextCursor = i + 1;
    this.conv = { ...this.conv, prdPlan: { stories, cursor: nextCursor } };
    // Record the skipped-review nuance in the spec file only (state machine stays simple).
    await this.writeSpec(stories[i], i + 1, stories.length, skippedReview ? 'skipped review' : undefined);

    if (nextCursor >= stories.length) {
      // Plan complete — summarize the final statuses in a short assistant block.
      const summary = this.renderPlanSummary(stories);
      const { conv } = appendAssistant(this.conv, [{ type: 'text', text: summary }], {
        parentId: this.conv.currentLeafId ?? undefined,
        model: this.conv.model ?? undefined,
      });
      this.conv = conv;
      await this.persist();
      this.sendConversation();
      return;
    }

    // Run the next story as a new turn, parented on a synthetic "Continue" user node.
    const next = stories[nextCursor];
    const { conv, nodeId } = appendUser(this.conv, [
      { type: 'text', text: `Continue to story ${nextCursor + 1}: ${next.title}` },
    ]);
    this.conv = conv;
    await this.runAssistantTurn(nodeId, [], { storyIndex: nextCursor });
  }

  /** Set a story's status immutably on the conversation's plan (no-op if the plan is gone). */
  private setStoryStatus(index: number, status: PrdStory['status']): void {
    const plan = this.conv.prdPlan;
    if (!plan || !plan.stories[index]) return;
    const stories = plan.stories.map((s, idx) => (idx === index ? { ...s, status } : s));
    this.conv = { ...this.conv, prdPlan: { ...plan, stories } };
  }

  /**
   * Write (or rewrite) a story's spec file. A direct meta-artifact — NOT staged through the
   * overlay. Best-effort: swallows write errors so a spec-write hiccup never fails a build.
   */
  private async writeSpec(story: PrdStory, index: number, total: number, note?: string): Promise<void> {
    try {
      await this.deps.io.write(story.specPath, renderSpecMarkdown(story, index, total, undefined, note));
    } catch {
      /* spec files are best-effort meta-artifacts */
    }
  }

  /** A one-line-per-story completion summary for a finished PRD build. */
  private renderPlanSummary(stories: PrdStory[]): string {
    const glyph: Record<PrdStory['status'], string> = {
      pending: '○',
      building: '…',
      'awaiting-review': '◉',
      done: '✓',
      failed: '✕',
    };
    const done = stories.filter((s) => s.status === 'done').length;
    const lines = stories.map((s, i) => `${i + 1}. ${glyph[s.status]} ${s.title}`);
    return `PRD build complete — ${done} of ${stories.length} stories done.\n\n${lines.join('\n')}`;
  }

  private finalizeAssistant(nodeId: string, blocks: ContentBlock[], usage: TokenUsage): void {
    const node = this.conv.nodes[nodeId];
    if (!node) return;
    const nodes = { ...this.conv.nodes, [nodeId]: { ...node, blocks, usage, model: this.conv.model ?? undefined } };
    this.conv = {
      ...this.conv,
      nodes,
      usageTotals: addUsage(this.conv.usageTotals, usage),
      updatedAt: this.clock(),
    };
  }

  // -------------------------------------------------------------------------
  // Diff review
  // -------------------------------------------------------------------------

  private async onSendFeedback(): Promise<void> {
    const prompt = this.changeset.feedbackPrompt();
    if (!prompt) {
      this.toast('info', 'Add a comment or revert a change before sending feedback.');
      return;
    }
    // Physically materialize the user's reverts out of the overlay before the
    // revision turn, so a reverted change actually disappears from the staged
    // state regardless of whether the (possibly weak/local) model honors the
    // prose instruction. This also drops stale comment/revert state.
    this.materializeReverts();
    const { conv, nodeId } = appendUser(this.conv, [{ type: 'text', text: prompt }]);
    this.conv = conv;
    this.sendConversation();
    await this.runAssistantTurn(nodeId);
  }

  /** Rebuild the overlay from the changeset's effective ops (reverted hunks removed). */
  private materializeReverts(): void {
    const eff = this.changeset.effectiveOps();
    this.overlay.discard();
    for (const op of eff) this.overlay.setOp(op);
    this.changeset = new ChangeSet(this.overlay, 'changeset');
  }

  private async onApply(commit: boolean, message: string | undefined, coAuthor: boolean): Promise<void> {
    const drift = await detectDrift(this.overlay, this.deps.io);
    if (drift.needed) {
      this.deps.post({ type: 'rebaseState', state: drift });
      this.toast('warn', 'Files changed on disk since these edits were staged. Rebase before applying.');
      return;
    }

    const ops = this.changeset.effectiveOps();
    if (ops.length === 0) {
      this.deps.post({ type: 'applied', committed: false, error: 'Nothing to apply.' });
      return;
    }

    const paths: string[] = [];
    try {
      for (const op of ops) {
        if (op.kind === 'delete') await this.deps.io.remove(op.path);
        else await this.deps.io.write(op.path, op.staged);
        paths.push(op.path);
      }
    } catch (err) {
      this.deps.post({ type: 'applied', committed: false, error: `Failed to write: ${errMessage(err)}` });
      return;
    }

    // Freeze the diff BEFORE discarding the overlay, so this applied changeset
    // can be re-opened read-only later from its commit block in the transcript.
    const frozen = this.changeset.view();
    const filesChanged = frozen.files.length;

    let commitInfo: { sha: string; message: string } | null = null;
    if (commit) {
      // commit() posts its own applied/error result. Even if the commit fails,
      // the files were already written to disk above, so the staged copy is now
      // stale and must be cleared — otherwise the next apply sees spurious drift
      // against the user's own just-written content.
      commitInfo = await this.commit(paths, message, coAuthor, ops.length);
    } else {
      this.deps.post({ type: 'applied', committed: false });
    }

    // A commit gets a sha-stable id; a disk-only apply (or a failed/no-repo
    // commit that still wrote to disk) gets a monotonic id so it stays browsable.
    const id = commitInfo ? `cs-${commitInfo.sha}` : `cs-applied-${++this.appliedSeq}`;
    this.recordCommit(id, { ...frozen, id }, {
      sha: commitInfo?.sha ?? '',
      message: commitInfo?.message ?? 'Applied to disk',
      changesetId: id,
      filesChanged,
    });

    // Applied changes are on disk now — no longer staged.
    this.overlay.discard();
    this.changeset = new ChangeSet(this.overlay, 'changeset');
    this.sendChangeset();
  }

  /**
   * Persist a frozen changeset and append a commit block to the transcript, then
   * sync + save. The block lands on the current leaf when it is an assistant node
   * (the common case: apply follows a turn); otherwise a fresh assistant node
   * carries it so it is never dropped.
   */
  private recordCommit(id: string, view: ChangeSetView, record: CommitRecord): void {
    const committedChangesets = { ...(this.conv.committedChangesets ?? {}), [id]: view };
    const leafId = this.conv.currentLeafId;
    const leaf = leafId ? this.conv.nodes[leafId] : undefined;
    if (leaf && leaf.role === 'assistant') {
      const nodes = {
        ...this.conv.nodes,
        [leafId!]: { ...leaf, blocks: [...leaf.blocks, { type: 'commit' as const, commit: record }] },
      };
      this.conv = { ...this.conv, nodes, committedChangesets, updatedAt: this.clock() };
    } else {
      const { conv } = appendAssistant(
        { ...this.conv, committedChangesets },
        [{ type: 'commit', commit: record }],
        { parentId: leafId ?? undefined, model: this.conv.model ?? undefined },
      );
      this.conv = conv;
    }
    void this.persist();
    this.sendConversation();
  }

  /**
   * Commit the written paths. Returns the sha + final message on success, or
   * null when no commit was made (no repo, or the commit failed) — the caller
   * treats null as a disk-only apply for the purposes of the frozen changeset.
   */
  private async commit(
    paths: string[],
    message: string | undefined,
    coAuthor: boolean,
    fileCount: number,
  ): Promise<{ sha: string; message: string } | null> {
    const git = this.deps.git;
    if (!git || !(await git.isRepo())) {
      this.deps.post({ type: 'applied', committed: false });
      this.toast('warn', 'No git repository — changes were applied to disk without a commit.');
      return null;
    }
    const finalMessage = (message && message.trim()) || (await this.generateCommitMessage()) || heuristicMessage(paths, fileCount);
    try {
      const { sha } = await git.commit(paths, finalMessage, coAuthor);
      this.deps.post({ type: 'applied', committed: true, sha });
      return { sha, message: finalMessage };
    } catch (err) {
      this.deps.post({ type: 'applied', committed: false, error: `Commit failed: ${errMessage(err)}` });
      return null;
    }
  }

  private async onRequestCommitMessage(): Promise<void> {
    const generated = (await this.generateCommitMessage()) || heuristicMessage(this.changeset.effectiveOps().map((o) => o.path), this.changeset.summary().filesChanged);
    this.deps.post({ type: 'commitMessage', message: generated });
  }

  /** Ask the model for a one-line commit message; returns null if unavailable. */
  private async generateCommitMessage(): Promise<string | null> {
    const resolved = await this.resolveModel();
    if (!resolved) return null;
    const diff = renderUnifiedDiff(this.changeset.view());
    if (!diff.trim()) return null;
    try {
      const controller = new AbortController();
      const stream = resolved.adapter.chat({
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        modelId: resolved.modelId,
        system: 'You write concise git commit messages. Reply with a single imperative subject line (<= 72 chars) and nothing else.',
        messages: [{ role: 'user', content: [{ type: 'text', text: `Summarize this diff as one commit subject line:\n\n${diff.slice(0, 8000)}` }] }],
        tools: [],
        maxTokens: 64,
        signal: controller.signal,
      });
      let text = '';
      for await (const e of stream) {
        if (e.type === 'text') text += e.delta;
        else if (e.type === 'error') return null;
      }
      const line = text.trim().split('\n').map((l) => l.trim()).find(Boolean);
      return line ? line.replace(/^["'`]|["'`]$/g, '').slice(0, 72) : null;
    } catch {
      return null;
    }
  }

  private async onRebase(): Promise<void> {
    const result = await coreRebase(this.overlay, this.deps.io);
    if (result.conflictedPaths.length > 0) {
      await this.resolveConflictsWithModel(result.conflictedPaths);
    }
    this.changeset = new ChangeSet(this.overlay, 'changeset');
    const drift = await detectDrift(this.overlay, this.deps.io);
    this.deps.post({ type: 'rebaseState', state: drift });
    this.sendChangeset();
  }

  /** Best-effort model-assisted merge for files the 3-way rebase could not merge. */
  private async resolveConflictsWithModel(paths: string[]): Promise<void> {
    const resolved = await this.resolveModel();
    if (!resolved) {
      this.toast('warn', `Could not auto-merge ${paths.length} file(s); no model available to resolve conflicts.`);
      return;
    }
    for (const path of paths) {
      const current = (await this.deps.io.read(path)) ?? '';
      const staged = (await this.overlay.read(path)) ?? '';
      try {
        const controller = new AbortController();
        const stream = resolved.adapter.chat({
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
          modelId: resolved.modelId,
          system: 'You merge code. Given the current on-disk file and an intended edited version, produce a single merged file that preserves the intended change on top of the current content. Reply with ONLY the full merged file contents, no fences, no commentary.',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: `CURRENT ON DISK (${path}):\n${current}\n\nINTENDED EDIT:\n${staged}\n\nProduce the merged file.` },
              ],
            },
          ],
          tools: [],
          signal: controller.signal,
        });
        let text = '';
        for await (const e of stream) if (e.type === 'text') text += e.delta;
        const merged = stripFences(text);
        if (merged.trim()) {
          this.overlay.setOp({ kind: 'modify', path, base: current, staged: merged });
        }
      } catch {
        /* leave the conflict for the human */
      }
    }
  }

  // -------------------------------------------------------------------------
  // Branch / conversation ops
  // -------------------------------------------------------------------------

  private applyTreeChange(conv: Conversation): void {
    this.conv = conv;
    this.restoreOverlayFor(conv.currentLeafId);
    this.sendConversation();
    // The overlay was swapped to the target branch's snapshot — refresh the diff
    // view (and changes indicator) so it doesn't show the previous branch's hunks
    // and so hunk-id-keyed review actions don't target a stale changeset.
    if (!this.overlay.isEmpty()) this.sendChangeset();
    else this.deps.post({ type: 'changeset', view: null });
    void this.persist();
  }

  private async onFork(nodeId?: string): Promise<void> {
    const target = nodeId ?? this.conv.currentLeafId;
    if (!target) return;
    const fork = forkAt(this.conv, target);
    // Copy the staging state as of the fork point so chat + workspace stay
    // consistent. Walk to the nearest ancestor snapshot (a user node has none of
    // its own) rather than defaulting to the live overlay, which may belong to a
    // different active branch than the fork target.
    const snapshot = this.snapshotAsOf(target);
    this.deps.openTab?.(fork, snapshot);
  }

  private async onNewConversation(): Promise<void> {
    const settings = await this.ensureSettings();
    this.conv = createConversation(settings.defaultModel, settings.harness.defaultMode);
    this.overlay = new StagingOverlay(this.deps.io);
    this.changeset = new ChangeSet(this.overlay, 'changeset');
    this.wireByNode.clear();
    this.sendConversation();
    this.deps.post({ type: 'changeset', view: null });
  }

  private async onOpenConversation(id: string): Promise<void> {
    const loaded = await this.deps.history.load(id);
    if (!loaded) {
      this.toast('error', 'Conversation not found.');
      return;
    }
    this.conv = loaded;
    this.wireByNode.clear();
    this.restoreOverlayFor(loaded.currentLeafId);
    this.sendConversation();
    if (!this.overlay.isEmpty()) this.sendChangeset();
    else this.deps.post({ type: 'changeset', view: null });
  }

  private async onDeleteConversation(id: string): Promise<void> {
    await this.deps.history.remove(id);
    if (id === this.conv.id) await this.onNewConversation();
    this.deps.post({ type: 'conversationList', items: await this.deps.history.list() });
  }

  // -------------------------------------------------------------------------
  // Providers & settings
  // -------------------------------------------------------------------------

  private async onSaveProvider(provider: ProviderConfig, apiKey?: string): Promise<void> {
    const settings = await this.ensureSettings();
    const providers = settings.providers.filter((p) => p.id !== provider.id);
    providers.push(provider);
    await this.deps.settings.saveProviders(providers);
    if (apiKey !== undefined && apiKey !== '') await this.deps.secrets.set(provider.id, apiKey);
    await this.sendSettings(true);
    this.deps.onSettingsChanged?.();
  }

  private async onDeleteProvider(providerId: string): Promise<void> {
    const settings = await this.ensureSettings();
    const providers = settings.providers.filter((p) => p.id !== providerId);
    await this.deps.settings.saveProviders(providers);
    await this.deps.secrets.delete(providerId);
    if (this.conv.model?.providerId === providerId) {
      this.conv = { ...this.conv, model: null };
      this.sendConversation();
    }
    await this.sendSettings(true);
    this.deps.onSettingsChanged?.();
  }

  private async onFetchModels(providerId: string): Promise<void> {
    const settings = await this.ensureSettings();
    const provider = settings.providers.find((p) => p.id === providerId);
    if (!provider) {
      this.deps.post({ type: 'modelsFetched', providerId, models: [], error: 'Unknown provider.' });
      return;
    }
    try {
      const key = provider.requiresApiKey ? await this.deps.secrets.get(providerId) : undefined;
      const models = await this.fetchModels(
        { sdkType: provider.sdkType, baseUrl: provider.baseUrl, kind: provider.kind },
        key,
      );
      this.deps.post({ type: 'modelsFetched', providerId, models });
    } catch (err) {
      this.deps.post({ type: 'modelsFetched', providerId, models: [], error: errMessage(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private toolHost(): ToolHost {
    const overlay = this.overlay;
    const io = this.deps.io;
    const skills = this.turnSkills;
    return {
      async readFile(path: string): Promise<string> {
        const content = await overlay.read(path);
        if (content === null) throw new Error(`file not found: ${path}`);
        return content;
      },
      listDir: (path) => io.listDir(path),
      glob: (pattern) => io.glob(pattern),
      grep: (pattern, opts) => io.grep(pattern, opts),
      async stageEdit(ops: StageOp[]): Promise<void> {
        for (const op of ops) {
          if (op.kind === 'create') await overlay.stageCreate(op.path, op.content);
          else if (op.kind === 'delete') await overlay.stageDelete(op.path);
          else await overlay.stageModify(op.path, op.content);
        }
      },
      async listStaged(): Promise<string[]> {
        return overlay.ops().map((o) => o.path);
      },
      skills: toSkillMetas(skills),
      async loadSkill(name: string): Promise<string | null> {
        const target = name.trim();
        const match =
          skills.find((s) => s.name === target) ??
          skills.find((s) => s.name.toLowerCase() === target.toLowerCase());
        return match ? match.body : null;
      },
    };
  }

  /**
   * Discover skills for a turn: the bundled defaults, overlaid by any workspace
   * skills under `.fowlplay/skills/*.md` (workspace wins on a name collision).
   */
  private async discoverSkills(): Promise<Skill[]> {
    const byName = new Map<string, Skill>();
    for (const s of BUNDLED_SKILLS) byName.set(s.name, s);
    try {
      const files = await this.deps.io.glob('.fowlplay/skills/*.md');
      for (const file of files) {
        const raw = await this.deps.io.read(file);
        if (raw === null) continue;
        const skill = parseSkill(file, raw);
        byName.set(skill.name, skill);
      }
    } catch {
      /* skills are best-effort; fall back to bundled defaults */
    }
    return [...byName.values()];
  }

  /** Prepend the skill catalog to a base system prompt (no-op when no skills). */
  private systemWithSkills(base: string): string {
    const catalog = formatSkillCatalog(toSkillMetas(this.turnSkills));
    return catalog ? `${catalog}\n\n${base}` : base;
  }

  /** The base toolset, plus `load_skill` when skills are available this turn. */
  private toolsWithSkills(): ToolSpec[] {
    const metas = toSkillMetas(this.turnSkills);
    return metas.length > 0 ? buildToolSpecs({ skills: metas }) : this.allTools;
  }

  /**
   * Resolve the model to run a given Coop `role` (or, with no role, the plain
   * conversation model). The chain is:
   *   conversation `roleModelOverrides[role]` → settings `harness.roleModelOverrides[role]`
   *   → conversation `model`.
   * Override layers that reference a deleted provider/model fall through to the
   * next layer; the final conversation-model layer only requires the provider to
   * still exist (mirroring the historical behavior). Returns null only when
   * nothing in the chain resolves.
   */
  private async resolveModel(role?: CoopRole): Promise<ResolvedModel | null> {
    const settings = await this.ensureSettings();
    const found = this.resolveRef(settings, role);
    if (!found) return null;
    const { provider, ref } = found;
    const apiKey = provider.requiresApiKey ? await this.deps.secrets.get(provider.id) : undefined;
    return {
      adapter: this.createAdapter(provider.sdkType),
      baseUrl: provider.baseUrl,
      apiKey,
      modelId: ref.modelId,
    };
  }

  /**
   * The provider + ModelRef that a role resolves to under the override chain, or
   * null. Override layers require the model to still exist; the conversation-model
   * fallback requires only the provider (a model list may lag behind a fetch).
   */
  private resolveRef(
    settings: FowlPlaySettings,
    role?: CoopRole,
  ): { provider: ProviderConfig; ref: ModelRef } | null {
    const layers: Array<{ ref: ModelRef | null | undefined; requireModel: boolean }> = [];
    if (role) {
      layers.push({ ref: this.conv.roleModelOverrides?.[role], requireModel: true });
      layers.push({ ref: settings.harness.roleModelOverrides?.[role], requireModel: true });
    }
    layers.push({ ref: this.conv.model, requireModel: false });

    for (const { ref, requireModel } of layers) {
      if (!ref) continue;
      const provider = settings.providers.find((p) => p.id === ref.providerId);
      if (!provider) continue;
      if (requireModel && !provider.models.some((m) => m.id === ref.modelId)) continue;
      return { provider, ref };
    }
    return null;
  }

  /** Display label for the model a role resolves to (for gate cards / status). */
  private roleModelLabel(settings: FowlPlaySettings, role?: CoopRole): string | undefined {
    const found = this.resolveRef(settings, role);
    if (!found) return undefined;
    const model = found.provider.models.find((m) => m.id === found.ref.modelId);
    return model?.displayName || model?.id || found.ref.modelId;
  }

  /** The known context window (tokens) of the model a role resolves to, if any. */
  private roleWindow(settings: FowlPlaySettings, role?: CoopRole): number | undefined {
    const found = this.resolveRef(settings, role);
    const model = found?.provider.models.find((m) => m.id === found.ref.modelId);
    const window = model?.contextWindow;
    return window && window > 0 ? window : undefined;
  }

  /**
   * The payload token budget for a role's model: the context window minus a
   * reserve for the system prompt, instructions, and response headroom
   * (`max(1500, 25% of window)`). Returns `undefined` when the window is unknown
   * — no hard budget, preserving today's behavior for such providers.
   */
  private payloadBudget(settings: FowlPlaySettings, role?: CoopRole): number | undefined {
    const window = this.roleWindow(settings, role);
    if (window === undefined) return undefined;
    const reserve = Math.max(1500, Math.floor(window * 0.25));
    return Math.max(0, window - reserve);
  }

  /** Display label for an explicit ModelRef (used in mention confirmations). */
  private labelForRef(ref: ModelRef): string {
    const provider = this.settingsCache?.providers.find((p) => p.id === ref.providerId);
    const model = provider?.models.find((m) => m.id === ref.modelId);
    return model?.displayName || model?.id || ref.modelId;
  }

  /** Wire history that a follow-up from `userNodeId` should build on. */
  private wireBaseFor(userNodeId: string): WireMessage[] {
    const parentId = this.conv.nodes[userNodeId]?.parentId ?? null;
    if (!parentId) return [];
    const cached = this.wireByNode.get(parentId);
    if (cached) return cached;
    return reconstructWire(this.chainTo(parentId));
  }

  /** Root → node path for the given node id. */
  private chainTo(nodeId: string): MessageNode[] {
    const out: MessageNode[] = [];
    let cur: string | null = nodeId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const n: MessageNode | undefined = this.conv.nodes[cur];
      if (!n) break;
      out.unshift(n);
      cur = n.parentId;
    }
    return out;
  }

  /**
   * The serialized staging state as of a node: the snapshot at that node, or the
   * nearest ancestor's, walking the real tree ancestry (not the active path).
   * Falls back to the live overlay only when no ancestor snapshot exists (e.g.
   * forking the current leaf mid-review, where the live overlay is correct).
   */
  private snapshotAsOf(nodeId: string): SerializedOverlay {
    const snapshots = this.conv.stagingSnapshots ?? {};
    let cur: string | null = nodeId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const snap = snapshots[cur];
      if (snap) return snap;
      cur = this.conv.nodes[cur]?.parentId ?? null;
    }
    return this.overlay.serialize();
  }

  private snapshotOverlay(nodeId: string): void {
    const snapshots = { ...(this.conv.stagingSnapshots ?? {}) };
    snapshots[nodeId] = this.overlay.serialize();
    this.conv = { ...this.conv, stagingSnapshots: snapshots };
  }

  /** Restore the overlay to the snapshot at (or nearest ancestor of) a leaf. */
  private restoreOverlayFor(leafId: string | null): void {
    const snapshots = this.conv.stagingSnapshots ?? {};
    let cur: string | null = leafId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const snap = snapshots[cur];
      if (snap) {
        this.overlay = StagingOverlay.deserialize(snap, this.deps.io);
        this.changeset = new ChangeSet(this.overlay, 'changeset');
        return;
      }
      cur = this.conv.nodes[cur]?.parentId ?? null;
    }
    this.overlay = new StagingOverlay(this.deps.io);
    this.changeset = new ChangeSet(this.overlay, 'changeset');
  }

  private toast(level: 'info' | 'warn' | 'error', message: string): void {
    this.deps.post({ type: 'toast', level, message });
  }
}

interface ResolvedModel {
  adapter: ProviderAdapter;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionCore(
  deps: SessionDeps,
  initial?: { conversation?: Conversation; overlay?: SerializedOverlay },
): SessionCore {
  return new SessionCore(deps, initial);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
}

/** User-facing message when a request + its context overruns the model's window. */
function contextExceededMessage(modelLabel: string, windowTokens?: number): string {
  const size = windowTokens ? ` (~${fmtTokensK(windowTokens)})` : '';
  return `The request plus its context exceeds ${modelLabel}'s context window${size}. Trim the request, start a fresh conversation, or pick a larger model.`;
}

/** Format a token count with a thousands suffix, e.g. 1234 → "1.2k". */
function fmtTokensK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

/** Strip skill bodies down to catalog metadata (name + description). */
function toSkillMetas(skills: Skill[]): SkillMeta[] {
  return skills.map(({ name, description }) => ({ name, description }));
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
  };
}

/** Accumulate `b` into `a` in place (for summing usage across sub-calls in one turn). */
function addUsageInPlace(a: TokenUsage, b: TokenUsage): void {
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.cachedTokens += b.cachedTokens;
}

function firstText(blocks: ContentBlock[]): string | null {
  for (const b of blocks) if (b.type === 'text' && b.text.trim()) return b.text;
  return null;
}

/**
 * Wrap arbitrary content in a fenced code block whose backtick run is longer
 * than any run inside the content, so selected text or a file that itself
 * contains ``` cannot break out of the fence (which would corrupt the pinned
 * context / open a prompt-injection seam).
 */
function fencedBlock(info: string, content: string): string {
  let longest = 0;
  for (const m of content.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${content}\n${fence}`;
}

function joinText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function reconstructWire(path: MessageNode[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const n of path) {
    if (n.role === 'user') {
      const text = n.blocks
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n\n');
      if (text) out.push({ role: 'user', content: [{ type: 'text', text }] });
    } else {
      const parts: WireAssistantPart[] = [];
      for (const b of n.blocks) {
        if (b.type === 'text') parts.push({ type: 'text', text: b.text });
        else if (b.type === 'thinking') parts.push({ type: 'thinking', text: b.text });
      }
      if (parts.length) out.push({ role: 'assistant', content: parts });
    }
  }
  return out;
}

function upsertCard(cards: GateCard[], card: GateCard): void {
  const idx = cards.findIndex((c) => c.id === card.id);
  if (idx >= 0) cards[idx] = card;
  else cards.push(card);
}

/** Render a changeset view as a unified diff for role prompts / commit messages. */
export function renderUnifiedDiff(view: ChangeSetView): string {
  const parts: string[] = [];
  for (const f of view.files) {
    parts.push(`--- a/${f.path}`);
    parts.push(`+++ b/${f.path}`);
    for (const h of f.hunks) {
      parts.push(`@@ -${h.baseStart},${h.baseLines.length} +${h.stagedStart},${h.stagedLines.length} @@`);
      parts.push(renderHunkDiff(h));
    }
  }
  return parts.join('\n');
}

function heuristicMessage(paths: string[], fileCount: number): string {
  const names = [...new Set(paths.map((p) => p.split('/').pop() ?? p))];
  if (names.length === 0) return 'Update workspace files';
  if (names.length === 1) return `Update ${names[0]}`;
  if (names.length <= 3) return `Update ${names.join(', ')}`;
  return `Update ${names.slice(0, 2).join(', ')} and ${fileCount - 2} more file(s)`;
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n```$/;
  const m = fence.exec(trimmed);
  return m ? m[1] : trimmed;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A ModelMatch as a bare ModelRef. */
function refOf(match: ModelMatch): ModelRef {
  return { providerId: match.providerId, modelId: match.modelId };
}

/** Human word for a mention target, e.g. "conversation" or "Builder". */
function roleWord(role: MentionRole): string {
  return role === 'conversation' ? 'conversation' : role;
}

/** "Builder → Qwen3.6-35B-MoE" / "Model → Qwen3.6-35B-MoE" for confirmation toasts. */
function assignmentLabel(role: MentionRole, modelLabel: string): string {
  const who = role === 'conversation' ? 'Model' : `${role[0].toUpperCase()}${role.slice(1)}`;
  return `${who} → ${modelLabel}`;
}
