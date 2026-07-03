/**
 * WorkspaceIo — the real filesystem backing for a session's {@link DiskIo} port.
 *
 * All paths are workspace-relative (matching what glob/grep return), resolved
 * against the first workspace folder. Reads/writes go through `vscode.workspace.fs`
 * so they work over remote / virtual filesystems. Search uses `findFiles`
 * (which already honors `files.exclude` / `search.exclude` and `.gitignore` when
 * `search.useIgnoreFiles` is on).
 *
 * Limitations (kept deliberately simple): grep is a manual line scan of the
 * find-files result set, capped at 500 matches, skipping files over ~2 MB and
 * files that look binary (contain a NUL byte). `.gitignore` beyond VS Code's own
 * default excludes is not independently parsed.
 */

import * as vscode from 'vscode';
import type { DirEntry, GrepMatch, GrepOptions } from '../core/agent/tools';
import type { DiskIo } from './session';

const GREP_MATCH_CAP = 500;
const MAX_FILE_BYTES = 2_000_000;
const NUL = String.fromCharCode(0);

export class WorkspaceIo implements DiskIo {
  constructor(private readonly root: vscode.Uri) {}

  static forActiveWorkspace(): WorkspaceIo | null {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? new WorkspaceIo(folder.uri) : null;
  }

  /**
   * Resolve a workspace-relative path to an absolute URI, guaranteeing the
   * result stays inside the workspace root.
   *
   * `vscode.Uri.joinPath` normalizes `..` segments and will happily walk out of
   * the root (e.g. `../../etc/passwd`), so a containment check here is the
   * single choke point that keeps model-proposed paths — for both reads and
   * writes — confined to the workspace. Absolute-looking inputs are already
   * defused by dropping empty segments, but `..` must be rejected explicitly.
   */
  private uri(path: string): vscode.Uri {
    const resolved = vscode.Uri.joinPath(this.root, ...path.split('/').filter(Boolean));
    const rootPath = this.root.path.replace(/\/+$/, '');
    const resolvedPath = resolved.path.replace(/\/+$/, '');
    if (
      resolved.scheme !== this.root.scheme ||
      resolved.authority !== this.root.authority ||
      !(resolvedPath === rootPath || resolvedPath.startsWith(rootPath + '/'))
    ) {
      throw new Error(`Path escapes the workspace: ${path}`);
    }
    return resolved;
  }

  async read(path: string): Promise<string | null> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.uri(path));
      return new TextDecoder().decode(bytes);
    } catch {
      return null;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(this.uri(path));
      return true;
    } catch {
      return false;
    }
  }

  async listDir(path: string): Promise<DirEntry[]> {
    const entries = await vscode.workspace.fs.readDirectory(this.uri(path || '.'));
    return entries
      .map(([name, type]) => ({
        name,
        kind: type === vscode.FileType.Directory ? ('dir' as const) : ('file' as const),
      }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  }

  async glob(pattern: string): Promise<string[]> {
    const rel = new vscode.RelativePattern(this.root, pattern);
    const uris = await vscode.workspace.findFiles(rel, undefined, 5000);
    return uris.map((u) => this.toRelative(u)).sort();
  }

  async grep(pattern: string, opts: GrepOptions): Promise<GrepMatch[]> {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, opts.ignoreCase ? 'i' : undefined);
    } catch {
      regex = new RegExp(escapeRegExp(pattern), opts.ignoreCase ? 'i' : undefined);
    }

    const scope = opts.path && opts.path !== '.' ? `${opts.path.replace(/\/+$/, '')}/**/*` : '**/*';
    const include = new vscode.RelativePattern(this.root, scope);
    const uris = await vscode.workspace.findFiles(include, undefined, 5000);

    const matches: GrepMatch[] = [];
    for (const uri of uris) {
      if (matches.length >= GREP_MATCH_CAP) break;
      let text: string;
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) continue;
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        continue;
      }
      if (text.indexOf(NUL) !== -1) continue; // looks binary
      const relPath = this.toRelative(uri);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= GREP_MATCH_CAP) break;
        if (regex.test(lines[i])) {
          matches.push({ path: relPath, line: i + 1, text: lines[i].slice(0, 500) });
        }
      }
    }
    return matches;
  }

  async write(path: string, content: string): Promise<void> {
    const uri = this.uri(path);
    const dir = vscode.Uri.joinPath(uri, '..');
    try {
      await vscode.workspace.fs.createDirectory(dir);
    } catch {
      /* already exists */
    }
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  }

  async remove(path: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.uri(path), { recursive: false, useTrash: false });
    } catch {
      /* already gone */
    }
  }

  private toRelative(uri: vscode.Uri): string {
    const rootPath = this.root.path.replace(/\/+$/, '');
    let p = uri.path;
    if (p.startsWith(rootPath)) p = p.slice(rootPath.length);
    return p.replace(/^\/+/, '');
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
