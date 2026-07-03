/**
 * Host ⇄ Webview message protocol.
 * The webview talks to the extension host exclusively through these messages.
 * e2e tests implement a MockBridge speaking the same protocol.
 */

import type {
  AppearanceSettings,
  ChangeSetView,
  Conversation,
  ConversationSummary,
  FowlPlaySettings,
  GateCard,
  HarnessMode,
  ModelRef,
  ProviderConfig,
  RebaseState,
  StreamEvent,
  TokenUsage,
} from './types';

// ---------------------------------------------------------------------------
// Webview → Host
// ---------------------------------------------------------------------------

export type WebviewToHost =
  // lifecycle
  | { type: 'ready' }
  // chat
  | { type: 'sendPrompt'; text: string; attachments?: Attachment[] }
  | { type: 'cancelResponse' }
  | { type: 'editMessage'; nodeId: string; text: string }        // branches
  | { type: 'rerunMessage'; nodeId: string }                      // sibling response
  | { type: 'rewindTo'; nodeId: string }
  | { type: 'switchBranch'; nodeId: string; direction: 'prev' | 'next' }
  | { type: 'forkConversation'; nodeId?: string }                 // new tab from point
  | { type: 'duplicateConversation' }
  // model & harness
  | { type: 'setModel'; model: ModelRef }
  | { type: 'setHarnessMode'; mode: HarnessMode }
  // diff review
  | { type: 'openDiff'; changesetId?: string }                    // omit = current
  | { type: 'toggleRevert'; hunkId: string; reverted: boolean }
  | { type: 'setComment'; hunkId: string; comment: string | null }
  | { type: 'sendFeedback' }                                      // comments+reverts → prompt
  | { type: 'applyToDisk' }
  | { type: 'applyAndCommit'; message?: string; coAuthor: boolean }
  | { type: 'requestCommitMessage' }                              // auto-generate
  | { type: 'rebase' }
  // history
  | { type: 'listConversations'; query?: string }
  | { type: 'openConversation'; id: string }
  | { type: 'renameConversation'; id: string; title: string }
  | { type: 'deleteConversation'; id: string }
  | { type: 'exportConversation'; format: 'markdown' | 'json' }
  | { type: 'newConversation' }
  // providers & settings
  | { type: 'getSettings' }
  | { type: 'saveAppearance'; appearance: AppearanceSettings }
  | { type: 'saveHarnessSettings'; harness: FowlPlaySettings['harness'] }
  | { type: 'addProvider'; provider: ProviderConfig; apiKey?: string }
  | { type: 'updateProvider'; provider: ProviderConfig; apiKey?: string }
  | { type: 'deleteProvider'; providerId: string }
  | { type: 'fetchModels'; providerId: string };

export interface Attachment {
  name: string;
  mimeType: string;
  /** base64 for images; utf8 text for text files */
  data: string;
}

// ---------------------------------------------------------------------------
// Host → Webview
// ---------------------------------------------------------------------------

export type HostToWebview =
  // full state sync (on ready / conversation switch / branch ops)
  | { type: 'conversation'; conversation: Conversation }
  // streaming during a turn
  | { type: 'stream'; event: StreamEvent }
  | { type: 'gateUpdate'; card: GateCard }
  | { type: 'turnStarted'; nodeId: string }                       // assistant node created
  | { type: 'turnFinished'; nodeId: string; usage: TokenUsage }
  // diff review
  | { type: 'changeset'; view: ChangeSetView | null }
  | { type: 'rebaseState'; state: RebaseState }
  | { type: 'commitMessage'; message: string }
  | { type: 'applied'; committed: boolean; sha?: string; error?: string }
  // history
  | { type: 'conversationList'; items: ConversationSummary[] }
  | { type: 'exported'; format: 'markdown' | 'json'; content: string }
  // settings & providers
  | { type: 'settings'; settings: FowlPlaySettings }
  | { type: 'modelsFetched'; providerId: string; models: { id: string }[]; error?: string }
  // misc
  | { type: 'showView'; view: 'chat' | 'diff' | 'settings' | 'history' }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string };

// ---------------------------------------------------------------------------
// Bridge interfaces (implemented by real host wiring and by the e2e mock)
// ---------------------------------------------------------------------------

export interface WebviewBridge {
  post(msg: WebviewToHost): void;
  onMessage(handler: (msg: HostToWebview) => void): () => void;
}
