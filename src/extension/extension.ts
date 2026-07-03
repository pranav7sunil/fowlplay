/**
 * Extension entry point. Registers FowlPlay's commands and the activity-bar
 * webview view, all backed by a single {@link TabManager}.
 */

import * as vscode from 'vscode';
import type { SelectionContext } from '../shared/types';
import { TabManager } from './tabManager';

export function activate(context: vscode.ExtensionContext): void {
  const tabs = new TabManager(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('fowlplay.openTab', () => {
      tabs.openTab();
    }),
    vscode.commands.registerCommand('fowlplay.newConversation', () => {
      tabs.newConversationInActiveTab();
    }),
    vscode.commands.registerCommand('fowlplay.openSettings', () => {
      tabs.openSettings();
    }),
    vscode.commands.registerCommand('fowlplay.editSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        void vscode.window.showInformationMessage('Select some code (or Markdown) first, then run FowlPlay: Edit Selection.');
        return;
      }
      const sel = editor.selection;
      const ctx: SelectionContext = {
        path: vscode.workspace.asRelativePath(editor.document.uri, false),
        startLine: sel.start.line + 1,
        endLine: sel.end.line + 1,
        text: editor.document.getText(sel),
        languageId: editor.document.languageId,
      };
      tabs.editSelection(ctx);
    }),
    vscode.commands.registerCommand('fowlplay.resetSettings', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Reset FowlPlay settings and remove all providers and API keys? Conversation history is kept.',
        { modal: true },
        'Reset',
      );
      if (choice === 'Reset') {
        await tabs.resetSettings();
        void vscode.window.showInformationMessage('FowlPlay settings and providers were reset.');
      }
    }),
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'fowlplay.home',
      {
        resolveWebviewView(view) {
          tabs.resolveView(view);
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );
}

export function deactivate(): void {
  /* nothing to clean up — panels dispose themselves */
}
