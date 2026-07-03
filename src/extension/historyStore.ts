/**
 * HistoryStore — conversations persisted as individual JSON files under
 * `context.globalStorageUri/conversations/`, plus an in-memory index rebuilt
 * from disk. Loading is schema-tolerant: a malformed file is skipped rather than
 * crashing the panel.
 */

import * as vscode from 'vscode';
import type { Conversation, ConversationSummary } from '../shared/types';
import { toSummary } from '../core/conversation/serialize';
import type { HistoryPort } from './session';

export class HistoryStore implements HistoryPort {
  private readonly dir: vscode.Uri;

  constructor(private readonly globalStorage: vscode.Uri) {
    this.dir = vscode.Uri.joinPath(globalStorage, 'conversations');
  }

  private async ensureDir(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.dir);
    } catch {
      /* already exists */
    }
  }

  private file(id: string): vscode.Uri {
    return vscode.Uri.joinPath(this.dir, `${sanitize(id)}.json`);
  }

  async list(query?: string): Promise<ConversationSummary[]> {
    await this.ensureDir();
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(this.dir);
    } catch {
      return [];
    }
    const summaries: ConversationSummary[] = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !name.endsWith('.json')) continue;
      const conv = await this.readFile(vscode.Uri.joinPath(this.dir, name));
      if (conv) summaries.push(toSummary(conv));
    }
    const q = query?.trim().toLowerCase();
    const filtered = q ? summaries.filter((s) => s.title.toLowerCase().includes(q)) : summaries;
    return filtered.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async load(id: string): Promise<Conversation | null> {
    return this.readFile(this.file(id));
  }

  async save(conv: Conversation): Promise<void> {
    await this.ensureDir();
    const bytes = new TextEncoder().encode(JSON.stringify(conv));
    await vscode.workspace.fs.writeFile(this.file(conv.id), bytes);
  }

  async rename(id: string, title: string): Promise<void> {
    const conv = await this.load(id);
    if (!conv) return;
    await this.save({ ...conv, title, updatedAt: Date.now() });
  }

  async remove(id: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.file(id), { useTrash: false });
    } catch {
      /* already gone */
    }
  }

  private async readFile(uri: vscode.Uri): Promise<Conversation | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Conversation;
      if (parsed && typeof parsed.id === 'string' && parsed.nodes && typeof parsed.nodes === 'object') {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_');
}
