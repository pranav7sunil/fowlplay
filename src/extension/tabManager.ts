/**
 * TabManager — owns the editor-area webview panels and the activity-bar view.
 *
 * Each panel gets one {@link SessionCore}, wired to the shared host ports
 * (filesystem, secrets, settings, history, git) with `post` bound to that
 * webview. Panels are tracked so sessions can request "open in a new tab"
 * (fork / duplicate), which seeds a fresh panel with a forked conversation and a
 * copy of the staging layer.
 */

import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type { Conversation, SelectionContext, SerializedOverlay } from '../shared/types';
import type { WebviewToHost } from '../shared/protocol';
import { createSessionCore, type SessionCore, type SessionDeps } from './session';
import { WorkspaceIo } from './workspaceIo';
import { SecretsStore } from './secrets';
import { SettingsStore } from './settingsStore';
import { HistoryStore } from './historyStore';
import { Git } from './git';

interface Seed {
  conversation: Conversation;
  overlay: SerializedOverlay;
}

export class TabManager {
  private readonly panels = new Set<vscode.WebviewPanel>();
  private readonly sessions = new WeakMap<vscode.WebviewPanel, SessionCore>();
  /** The activity-bar view (fowlplay.home) and its session, once resolved. */
  private homeView: vscode.WebviewView | null = null;
  private homeSession: SessionCore | null = null;
  private readonly secrets: SecretsStore;
  private readonly settings: SettingsStore;
  private readonly history: HistoryStore;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.secrets = new SecretsStore(context.secrets);
    this.settings = new SettingsStore(context.globalStorageUri);
    this.history = new HistoryStore(context.globalStorageUri);
  }

  /** Open (or focus) a webview panel tab. An optional seed forks an existing conversation. */
  openTab(seed?: Seed, viewColumn: vscode.ViewColumn = vscode.ViewColumn.Active): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      'fowlplay.tab',
      'FowlPlay',
      viewColumn,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.png');
    panel.webview.html = this.html(panel.webview);

    const session = this.attachSession(panel.webview, seed);
    this.sessions.set(panel, session);
    this.panels.add(panel);
    panel.onDidDispose(() => this.panels.delete(panel));
    return panel;
  }

  /** Resolve the activity-bar view (fowlplay.home) with its own session. */
  resolveView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    view.webview.html = this.html(view.webview);
    // Track the view + session so editSelection can target the sidebar chat.
    this.homeView = view;
    this.homeSession = this.attachSession(view.webview);
    view.onDidDispose(() => {
      if (this.homeView === view) {
        this.homeView = null;
        this.homeSession = null;
      }
    });
  }

  /** Open (or focus) a tab and switch its UI to the settings view. */
  openSettings(): void {
    const active = [...this.panels].find((p) => p.active) ?? [...this.panels].pop();
    const panel = active ?? this.openTab();
    panel.reveal();
    // A freshly created webview may not have subscribed yet and would drop the
    // message; the switch is idempotent, so post it a few times.
    for (const delay of [0, 600, 1500]) {
      setTimeout(() => void panel.webview.postMessage({ type: 'showView', view: 'settings' }), delay);
    }
  }

  /** Broadcast "new conversation" into the most recently focused panel, else open one. */
  newConversationInActiveTab(): void {
    const active = [...this.panels].find((p) => p.active) ?? [...this.panels].pop();
    if (active) {
      const session = this.sessions.get(active);
      active.reveal();
      void session?.handle({ type: 'newConversation' });
    } else {
      this.openTab();
    }
  }

  /**
   * Deliver a highlighted editor region to a session as scoped context for its
   * next change. Targets a FowlPlay surface the user can already see, so the
   * code being discussed is never covered:
   *   1. a visible editor-area panel (focused one first),
   *   2. the sidebar view when it is visible (true side-by-side),
   *   3. an existing hidden panel, revealed in a split beside the editor,
   *   4. a fresh panel opened beside the editor.
   * Focus moves to the chat so the user can type about the selection right away.
   */
  editSelection(ctx: SelectionContext): void {
    const visible = [...this.panels].find((p) => p.active) ?? [...this.panels].find((p) => p.visible);
    if (visible) {
      visible.reveal();
      this.sessions.get(visible)?.receiveSelection(ctx);
      return;
    }
    if (this.homeView?.visible && this.homeSession) {
      this.homeView.show(false);
      this.homeSession.receiveSelection(ctx);
      return;
    }
    const recent = [...this.panels].pop();
    if (recent) {
      // Reveal beside the editor rather than in place — its remembered column
      // may be the one holding the file the user just selected in.
      recent.reveal(vscode.ViewColumn.Beside);
      this.sessions.get(recent)?.receiveSelection(ctx);
      return;
    }
    const panel = this.openTab(undefined, vscode.ViewColumn.Beside);
    panel.reveal();
    // The session stores the selection immediately; the chip message it posts is
    // dropped because the new webview hasn't subscribed yet, but the session
    // re-surfaces the pending selection on the webview's `ready` handshake. No
    // timer retry — that could re-arm a selection the user already sent or
    // dismissed in the interim.
    this.sessions.get(panel)?.receiveSelection(ctx);
  }

  /** Reset providers + keys + workspace settings (history is preserved). */
  async resetSettings(): Promise<void> {
    const settings = await this.settings.load();
    for (const p of settings.providers) await this.secrets.delete(p.id);
    await this.settings.clearProviders();
    const cfg = vscode.workspace.getConfiguration('fowlplay');
    const t = vscode.ConfigurationTarget.Global;
    for (const key of [
      'appearance.fontFamily',
      'appearance.fontScale',
      'appearance.theme',
      'harness.defaultMode',
      'harness.qasRetryBudget',
    ]) {
      await cfg.update(key, undefined, t);
    }
    // Re-sync any open tabs.
    for (const panel of this.panels) {
      void this.sessions.get(panel)?.handle({ type: 'getSettings' });
    }
  }

  private attachSession(webview: vscode.Webview, seed?: Seed): SessionCore {
    const io = WorkspaceIo.forActiveWorkspace();
    const deps: SessionDeps = {
      io: io ?? nullIo(),
      secrets: this.secrets,
      settings: this.settings,
      history: this.history,
      git: Git.forActiveWorkspace() ?? undefined,
      post: (msg) => {
        void webview.postMessage(msg);
      },
      openTab: (conversation, overlay) => {
        this.openTab({ conversation, overlay });
      },
    };
    const session = createSessionCore(deps, seed ? { conversation: seed.conversation, overlay: seed.overlay } : undefined);
    webview.onDidReceiveMessage((msg: WebviewToHost) => {
      void session.handle(msg);
    });
    return session;
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.css'));
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>FowlPlay</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  // CSP nonce must be unpredictable — use a CSPRNG, not Math.random.
  return randomBytes(24).toString('base64').replace(/[^A-Za-z0-9]/g, '');
}

/** Fallback IO when there is no workspace folder open — every op is a safe no-op. */
function nullIo(): SessionDeps['io'] {
  return {
    read: async () => null,
    exists: async () => false,
    listDir: async () => [],
    glob: async () => [],
    grep: async () => [],
    write: async () => {},
    remove: async () => {},
  };
}
