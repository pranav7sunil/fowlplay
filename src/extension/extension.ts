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
      const uri = editor.document.uri;
      // asRelativePath returns the (absolute) path unchanged for files outside
      // any workspace folder — which would leak the home dir to the model. Use a
      // basename in that case.
      const inWorkspace = vscode.workspace.getWorkspaceFolder(uri) !== undefined;
      const path = inWorkspace
        ? vscode.workspace.asRelativePath(uri, false)
        : uri.path.replace(/^.*\//, '');
      // A whole-line selection ends at column 0 of the line *after* the last
      // highlighted line; don't count that trailing line in the reported range.
      const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
      const ctx: SelectionContext = {
        path,
        startLine: sel.start.line + 1,
        endLine,
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
