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
import { StagingOverlay, type DiskReader } from '../core/staging/overlay';
import { ChangeSet } from '../core/staging/changeset';
import { detectDrift, rebase as coreRebase } from '../core/staging/rebase';
import { renderHunkDiff } from '../core/diff/compute';
import {
  runCoopPipeline,
  type ChangesetInspector,
  type RoleRunner,
} from '../core/harness/coop';
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
        await this.onSendPrompt(msg.text, msg.attachments);
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

  private async onSendPrompt(text: string, attachments?: Attachment[]): Promise<void> {
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
    await this.runAssistantTurn(nodeId, imageParts);
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

  /** The shared turn engine: given a user node, produce an assistant response. */
  private async runAssistantTurn(userNodeId: string, imageParts: WireUserPart[] = []): Promise<void> {
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
      if (this.conv.harnessMode === 'coop') {
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
    const fullHistory: WireMessage[] = [
      ...baseWire,
      { role: 'user', content: [{ type: 'text', text: userText }, ...imageParts] },
    ];
    const sent = gcHistory(fullHistory);

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
    const runner: RoleRunner = {
      run: async ({ system, userPrompt, readOnly, signal: s }) => {
        const res = await runAgentLoop({
          adapter: resolved.adapter,
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
          modelId: resolved.modelId,
          system,
          history: [{ role: 'user', content: [{ type: 'text', text: userPrompt }] }],
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
      const base: WireMessage[] = [
        ...baseWire,
        { role: 'user', content: [{ type: 'text', text: instructions }, ...imageParts] },
      ];
      const res = await runAgentLoop({
        adapter: resolved.adapter,
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        modelId: resolved.modelId,
        system: this.systemWithSkills(SOLO_SYSTEM),
        history: gcHistory(base),
        tools: this.toolsWithSkills(),
        toolHost: this.toolHost(),
        onEvent: (e) => this.deps.post({ type: 'stream', event: e }),
        signal: s,
      });
      // Return the Builder's usage so the pipeline counts it — it is usually the
      // dominant cost of a Coop turn.
      return res.usage;
    };

    const result = await runCoopPipeline({
      userPrompt: userText,
      runner,
      inspector,
      buildStage,
      settings: harness,
      onGate: (card) => {
        upsertCard(cards, card);
        this.deps.post({ type: 'gateUpdate', card });
      },
      signal,
    });

    const blocks: ContentBlock[] = cards.map((card) => ({ type: 'gate', card }));
    switch (result.outcome) {
      case 'blocked':
        blocks.push({ type: 'text', text: result.question ?? 'The request needs clarification before work can begin.' });
        break;
      case 'qas-failed':
        blocks.push({ type: 'text', text: 'The Inspector could not approve the changes within the retry budget. They remain staged for your review.' });
        break;
      case 'security-blocked':
        blocks.push({ type: 'text', text: 'Sentry flagged a security concern. The changes remain staged — review carefully before applying.' });
        break;
      case 'cancelled':
        blocks.push({ type: 'text', text: 'Cancelled.' });
        break;
      case 'ready-for-review':
        break;
    }
    return { blocks, usage: result.usage };
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

  private async resolveModel(): Promise<ResolvedModel | null> {
    const settings = await this.ensureSettings();
    const ref = this.conv.model;
    if (!ref) return null;
    const provider = settings.providers.find((p) => p.id === ref.providerId);
    if (!provider) return null;
    const apiKey = provider.requiresApiKey ? await this.deps.secrets.get(provider.id) : undefined;
    return {
      adapter: this.createAdapter(provider.sdkType),
      baseUrl: provider.baseUrl,
      apiKey,
      modelId: ref.modelId,
    };
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
