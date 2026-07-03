/**
 * FowlPlay shared domain types.
 * Single source of truth for both the extension host and the webview,
 * and for all core modules. Keep this file dependency-free.
 */

// ---------------------------------------------------------------------------
// Providers & models
// ---------------------------------------------------------------------------

/** API wire formats FowlPlay can speak. */
export type SdkType = 'openai-completions' | 'anthropic';

export type ProviderKind = 'api-key' | 'local' | 'custom';

export interface ProviderConfig {
  id: string;                 // uuid
  name: string;               // display name, e.g. "Ollama"
  kind: ProviderKind;
  sdkType: SdkType;
  baseUrl: string;            // e.g. http://localhost:11434/v1
  /** Whether an API key is required. The key itself lives in SecretStorage. */
  requiresApiKey: boolean;
  models: ModelConfig[];
}

export interface ModelConfig {
  id: string;                 // provider model id, e.g. "qwen2.5-coder:32b"
  displayName?: string;
  contextWindow?: number;     // tokens, if known
}

export interface ModelRef {
  providerId: string;
  modelId: string;
}

/**
 * A region the user highlighted in the editor, passed to a session as scoped
 * context for the next change ("Edit Selection"). Line numbers are 1-based and
 * inclusive.
 */
export interface SelectionContext {
  path: string;               // workspace-relative
  startLine: number;
  endLine: number;
  text: string;
  languageId?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

// ---------------------------------------------------------------------------
// Chat / conversation tree
// ---------------------------------------------------------------------------

export type Role = 'user' | 'assistant';

/** One block within an assistant message, rendered in order. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; durationMs?: number }
  | { type: 'tool_call'; call: ToolCallRecord }
  | { type: 'gate'; card: GateCard }
  | { type: 'changes'; summary: ChangesSummary }          // "Review Changes" block
  | { type: 'commit'; commit: CommitRecord }               // historical commit block
  | { type: 'error'; message: string };

export interface ToolCallRecord {
  id: string;
  name: string;
  /** JSON arguments as sent by the model. */
  args: unknown;
  /** Result summary shown in the UI (full result may be GC'd from model context). */
  resultSummary: string;
  ok: boolean;
}

export interface ChangesSummary {
  changesetId: string;
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface CommitRecord {
  sha: string;
  message: string;
  changesetId: string;
  filesChanged: number;
}

/** A node in the conversation tree. */
export interface MessageNode {
  id: string;
  parentId: string | null;    // null for roots
  role: Role;
  blocks: ContentBlock[];
  createdAt: number;
  model?: ModelRef;           // model that produced an assistant message
  usage?: TokenUsage;
}

/**
 * Conversation = tree of nodes + the id of the current leaf.
 * The active path is leaf → root. Sibling order is creation order.
 */
export interface Conversation {
  id: string;
  title: string;
  nodes: Record<string, MessageNode>;
  rootIds: string[];
  currentLeafId: string | null;
  model: ModelRef | null;
  harnessMode: HarnessMode;
  createdAt: number;
  updatedAt: number;
  usageTotals: TokenUsage;
  /** Serialized staging layer keyed by node id — snapshot at that point in the tree. */
  stagingSnapshots?: Record<string, SerializedOverlay>;
  /**
   * Frozen changeset views captured at apply/commit time, keyed by a stable id
   * (`cs-<sha>` for commits, `cs-applied-<n>` for disk-only applies). Lets a
   * historical commit block be re-opened read-only long after the live staging
   * layer has moved on. Persists with the conversation.
   */
  committedChangesets?: Record<string, ChangeSetView>;
}

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
}

// ---------------------------------------------------------------------------
// Staging layer / changesets / diffs
// ---------------------------------------------------------------------------

/** File-level operation held in the overlay. */
export type FileOp =
  | { kind: 'modify'; path: string; base: string; staged: string }
  | { kind: 'create'; path: string; staged: string }
  | { kind: 'delete'; path: string; base: string };

export interface SerializedOverlay {
  ops: FileOp[];
}

/** One reviewable hunk in the diff viewer. */
export interface DiffHunk {
  id: string;                  // stable within a changeset
  path: string;
  /** 1-based line numbers in base/staged content. */
  baseStart: number;
  baseLines: string[];         // removed or context-context is not included
  stagedStart: number;
  stagedLines: string[];       // added
  /** Context lines shown around the hunk. */
  contextBefore: string[];
  contextAfter: string[];
  reverted: boolean;
  comment?: string;
}

export interface FileDiff {
  path: string;
  kind: 'modify' | 'create' | 'delete';
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface ChangeSetView {
  id: string;
  files: FileDiff[];
  totalChanges: number;        // number of hunks
  additions: number;
  deletions: number;
}

export interface RebaseState {
  needed: boolean;
  conflictedPaths: string[];
}

// ---------------------------------------------------------------------------
// Coop harness
// ---------------------------------------------------------------------------

export type HarnessMode = 'solo' | 'coop';

export type CoopRole = 'scout' | 'builder' | 'inspector' | 'sentry';

export type GateStatus = 'running' | 'passed' | 'failed' | 'blocked' | 'skipped' | 'awaiting';

/** Evidence-based delivery: every gate emits a card with its proof. */
export interface GateCard {
  id: string;
  role: CoopRole | 'stop-the-line' | 'hitl';
  title: string;               // e.g. "Inspector — QA validation"
  status: GateStatus;
  /** What was checked / produced. Markdown. */
  evidence: string;
  /** For scout: acceptance criteria. */
  acceptanceCriteria?: string[];
  /** For inspector/sentry: findings that routed work back. */
  findings?: string[];
  attempt?: number;            // builder/inspector retry round
}

export interface HarnessSettings {
  defaultMode: HarnessMode;
  qasRetryBudget: number;      // bounded route-backs, default 2
  roleModelOverrides?: Partial<Record<CoopRole, ModelRef>>;
}

// ---------------------------------------------------------------------------
// Skills (model-invoked, lazy-loaded instruction docs)
// ---------------------------------------------------------------------------

/**
 * A skill's catalog entry — name + one-line description. This is what is listed
 * in a system prompt so the model can decide, cheaply, whether to load a skill's
 * full instructions via the `load_skill` tool. Bodies are NOT included here (that
 * is the whole point — skills stay out of context until explicitly loaded).
 */
export interface SkillMeta {
  name: string;
  description: string;
}

/** A full skill: its catalog metadata plus the markdown instructions to inject on load. */
export interface Skill extends SkillMeta {
  body: string;
}

// ---------------------------------------------------------------------------
// Agent tools (model-facing)
// ---------------------------------------------------------------------------

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for arguments. */
  parameters: Record<string, unknown>;
}

/** Uniform result returned to the model for any tool call. */
export interface ToolResult {
  ok: boolean;
  /** Text payload for the model. */
  content: string;
  /** Set for read/open results so context GC can drop stale copies. */
  gcClass?: 'file-content' | 'search-result' | 'other';
}

// ---------------------------------------------------------------------------
// Streaming events (provider → loop → UI)
// ---------------------------------------------------------------------------

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_args'; id: string; delta: string }
  | { type: 'tool_call_end'; id: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; stopReason: 'end' | 'tool_use' | 'cancelled' | 'error' }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Settings / appearance
// ---------------------------------------------------------------------------

export type ThemeName = 'inherit' | 'fowlplay-dark' | 'fowlplay-light' | 'fowlplay-midnight';

export interface AppearanceSettings {
  fontFamily: string;          // default "JetBrains Mono"
  fontScale: number;           // 1.0 default
  theme: ThemeName;
}

export interface FowlPlaySettings {
  appearance: AppearanceSettings;
  harness: HarnessSettings;
  providers: ProviderConfig[]; // keys stored separately in SecretStorage
  defaultModel: ModelRef | null;
  /**
   * Skills discovered for the active workspace (bundled defaults + `.fowlplay/skills/*.md`),
   * attached by the host when it posts settings so the UI can show what is available.
   * Not persisted — recomputed on demand.
   */
  skills?: SkillMeta[];
}
