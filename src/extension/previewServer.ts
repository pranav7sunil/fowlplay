/**
 * PreviewServer — the overlay-backed preview HTTP server (the `PreviewPort` impl).
 *
 * A tiny loopback `node:http` server that serves a staged artifact (and its
 * sibling assets) THROUGH the staging overlay: staged content wins, with a raw
 * disk fallback for untracked paths. This preserves the "model never touches
 * disk" invariant — the preview reads the same virtual filesystem the agent wrote
 * to, not the real workspace.
 *
 * Security: the server binds `127.0.0.1` on an ephemeral port and mints one random
 * token per instance. Every request must carry that token as its first path
 * segment (`/<token>/…`) or it 404s, so other local processes and drive-by web
 * pages can't read the workspace. The URL is run through `vscode.env.asExternalUri`
 * so remote / codespace setups get port forwarding for free.
 */

import * as vscode from 'vscode';
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { PreviewPort, PreviewSource } from './session';
import { mimeFor, sanitizePreviewPath } from './previewHttp';

export class PreviewServer implements PreviewPort {
  private server: http.Server | null = null;
  private port = 0;
  private readonly token = randomBytes(16).toString('hex');
  /** The source + entry the server currently reads through; swapped on re-`open`. */
  private target: { source: PreviewSource; entry: string } | null = null;

  constructor(private readonly root: vscode.Uri) {}

  /** (Re)point the server at a source + entry; returns the externally reachable URL of the entry. */
  async open(source: PreviewSource, entryPath: string): Promise<{ url: string }> {
    this.target = { source, entry: entryPath };
    await this.ensureStarted();
    const rel = entryPath.split('/').map(encodeURIComponent).join('/');
    const local = vscode.Uri.parse(`http://127.0.0.1:${this.port}/${this.token}/${rel}`);
    const external = await vscode.env.asExternalUri(local);
    return { url: external.toString() };
  }

  close(): void {
    this.server?.close();
    this.server = null;
    this.port = 0;
    this.target = null;
  }

  openExternal(url: string): void {
    void vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /** Start the server (once) on an ephemeral loopback port. */
  private ensureStarted(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        // Any exception in the async handler becomes a 500 — never an unhandled rejection.
        this.handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        this.server = server;
        resolve();
      });
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const target = this.target;
    if (!target) {
      res.writeHead(404);
      res.end();
      return;
    }
    const rel = sanitizePreviewPath(req.url ?? '', this.token, target.entry);
    if (rel === null) {
      res.writeHead(404);
      res.end();
      return;
    }

    const staged = await target.source.staged(rel);
    if (staged) {
      if (staged.content === null) {
        // Tracked as a staged DELETE — must 404, never fall through to disk.
        res.writeHead(404);
        res.end();
        return;
      }
      this.send(res, mimeFor(rel), Buffer.from(staged.content, 'utf-8'));
      return;
    }

    // Untracked → raw disk fallback, confined to the workspace root.
    const uri = this.resolveInRoot(rel);
    if (!uri) {
      res.writeHead(404);
      res.end();
      return;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.send(res, mimeFor(rel), Buffer.from(bytes));
    } catch {
      res.writeHead(404);
      res.end();
    }
  }

  /** Write a 200 with the standard hardening headers. */
  private send(res: http.ServerResponse, contentType: string, body: Buffer): void {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  }

  /**
   * Resolve a workspace-relative path to a URI inside the root, or null if it
   * escapes. Mirrors `WorkspaceIo.uri()`'s containment check (kept local so this
   * module stays independent of WorkspaceIo).
   */
  private resolveInRoot(path: string): vscode.Uri | null {
    const resolved = vscode.Uri.joinPath(this.root, ...path.split('/').filter(Boolean));
    const rootPath = this.root.path.replace(/\/+$/, '');
    const resolvedPath = resolved.path.replace(/\/+$/, '');
    if (
      resolved.scheme !== this.root.scheme ||
      resolved.authority !== this.root.authority ||
      !(resolvedPath === rootPath || resolvedPath.startsWith(rootPath + '/'))
    ) {
      return null;
    }
    return resolved;
  }
}
