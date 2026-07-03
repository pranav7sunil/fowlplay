/**
 * Staging overlay — the single write path for the agent.
 *
 * An in-memory virtual filesystem layered over a {@link DiskReader}. Edits
 * never touch disk; they accumulate here as {@link FileOp}s. Reads through the
 * overlay see staged content, so edits stack coherently across agent turns.
 *
 * Base snapshots are captured from disk on first touch of a file, so hunks can
 * always be computed against the original content and selective revert stays
 * meaningful even after several edits to the same file.
 */

import type { FileOp, SerializedOverlay } from '../../shared/types';

/** Disk abstraction. The overlay never imports node:fs or vscode directly. */
export interface DiskReader {
  read(path: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
}

export class StagingOverlay {
  private ops_ = new Map<string, FileOp>();

  constructor(private readonly disk: DiskReader) {}

  /** Staged content if the file is tracked, else disk content. `null` if deleted or absent. */
  async read(path: string): Promise<string | null> {
    const op = this.ops_.get(path);
    if (op) {
      if (op.kind === 'delete') return null;
      return op.staged;
    }
    return this.disk.read(path);
  }

  /** Stage a modification. Captures base from disk on first touch. */
  async stageModify(path: string, newContent: string): Promise<void> {
    const existing = this.ops_.get(path);
    if (existing) {
      switch (existing.kind) {
        case 'create':
          // create-then-modify stays a create with the new content.
          this.ops_.set(path, { kind: 'create', path, staged: newContent });
          return;
        case 'modify':
          this.ops_.set(path, { kind: 'modify', path, base: existing.base, staged: newContent });
          return;
        case 'delete':
          // Editing a staged-deleted file resurrects it as a modify off its base.
          this.ops_.set(path, { kind: 'modify', path, base: existing.base, staged: newContent });
          return;
      }
    }
    const base = await this.disk.read(path);
    if (base === null) {
      // Modifying a file that isn't on disk is really a create.
      this.ops_.set(path, { kind: 'create', path, staged: newContent });
    } else {
      this.ops_.set(path, { kind: 'modify', path, base, staged: newContent });
    }
  }

  /** Stage a new file. */
  async stageCreate(path: string, content: string): Promise<void> {
    const existing = this.ops_.get(path);
    if (existing) {
      if (existing.kind === 'delete') {
        // delete-then-create collapses to a modify against the original base.
        this.ops_.set(path, { kind: 'modify', path, base: existing.base, staged: content });
        return;
      }
      if (existing.kind === 'modify') {
        this.ops_.set(path, { kind: 'modify', path, base: existing.base, staged: content });
        return;
      }
      // existing create — update content, stays a create.
      this.ops_.set(path, { kind: 'create', path, staged: content });
      return;
    }
    this.ops_.set(path, { kind: 'create', path, staged: content });
  }

  /** Stage a deletion. */
  async stageDelete(path: string): Promise<void> {
    const existing = this.ops_.get(path);
    if (existing) {
      if (existing.kind === 'create') {
        // Deleting a staged-created file is a net no-op — drop it entirely.
        this.ops_.delete(path);
        return;
      }
      if (existing.kind === 'modify') {
        // modify-then-delete becomes a delete carrying the original base.
        this.ops_.set(path, { kind: 'delete', path, base: existing.base });
        return;
      }
      return; // already a delete
    }
    const base = await this.disk.read(path);
    if (base === null) return; // nothing on disk to delete
    this.ops_.set(path, { kind: 'delete', path, base });
  }

  /** Discard one file's staged changes, or all when `path` is omitted. */
  discard(path?: string): void {
    if (path === undefined) this.ops_.clear();
    else this.ops_.delete(path);
  }

  /** Snapshot of all ops (defensive copies), in insertion order. */
  ops(): FileOp[] {
    return [...this.ops_.values()].map((o) => ({ ...o }));
  }

  isEmpty(): boolean {
    return this.ops_.size === 0;
  }

  has(path: string): boolean {
    return this.ops_.has(path);
  }

  /**
   * Directly install an op (used by the rebase engine to restage a file
   * against a new base). Overwrites any existing op for the path.
   */
  setOp(op: FileOp): void {
    this.ops_.set(op.path, { ...op });
  }

  serialize(): SerializedOverlay {
    return { ops: this.ops() };
  }

  static deserialize(data: SerializedOverlay, disk: DiskReader): StagingOverlay {
    const overlay = new StagingOverlay(disk);
    for (const op of data.ops) overlay.ops_.set(op.path, { ...op });
    return overlay;
  }

  /** Deep, independent copy (for conversation forking / branching). */
  clone(): StagingOverlay {
    const overlay = new StagingOverlay(this.disk);
    for (const [p, op] of this.ops_) overlay.ops_.set(p, { ...op });
    return overlay;
  }
}
