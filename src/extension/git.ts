/**
 * Git — commit support via child-process `git` in the first workspace folder.
 *
 * Error-tolerant: when there is no repository the session degrades "Apply &
 * Commit" to a plain apply with a toast. Only the paths FowlPlay applied are
 * staged, so unrelated working-tree changes are left untouched.
 */

import { exec } from 'node:child_process';
import * as vscode from 'vscode';
import type { GitPort } from './session';

const CO_AUTHOR_TRAILER = 'Co-authored-by: FowlPlay <noreply@fowlplay.dev>';

export class Git implements GitPort {
  constructor(private readonly cwd: string) {}

  static forActiveWorkspace(): Git | null {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || folder.uri.scheme !== 'file') return null;
    return new Git(folder.uri.fsPath);
  }

  async isRepo(): Promise<boolean> {
    try {
      const out = await this.run(['rev-parse', '--is-inside-work-tree']);
      return out.trim() === 'true';
    } catch {
      return false;
    }
  }

  async head(): Promise<{ sha: string; branch: string } | null> {
    try {
      const sha = (await this.run(['rev-parse', 'HEAD'])).trim();
      const branch = (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      return { sha, branch };
    } catch {
      return null;
    }
  }

  async commit(paths: string[], message: string, coAuthor: boolean): Promise<{ sha: string }> {
    if (paths.length > 0) {
      await this.run(['add', '--', ...paths]);
    }
    const fullMessage = coAuthor ? `${message}\n\n${CO_AUTHOR_TRAILER}` : message;
    await this.run(['commit', '-m', fullMessage]);
    const sha = (await this.run(['rev-parse', '--short', 'HEAD'])).trim();
    return { sha };
  }

  private run(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(quote(['git', ...args]), { cwd: this.cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim() || err.message));
        else resolve(stdout);
      });
    });
  }
}

/** Shell-quote arguments so paths with spaces / special chars are safe. */
function quote(args: string[]): string {
  return args.map((a) => (/^[A-Za-z0-9_./:=-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}
