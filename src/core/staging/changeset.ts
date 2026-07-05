/**
 * ChangeSet — the cumulative, reviewable diff built from a staging overlay.
 *
 * Turns each {@link FileOp} into a {@link FileDiff} via the diff engine, and
 * maintains per-hunk review state (reverted / comment) keyed by the stable
 * hunk id so state survives recomputation as the overlay changes. Supports
 * selective revert (materialize reverted hunks out of the applied content) and
 * renders review feedback into a single prompt for the model.
 */

import type {
  ChangeSetView,
  ChangesSummary,
  DiffHunk,
  FileDiff,
  FileOp,
} from '../../shared/types';
import { applyHunksToBase, computeFileDiff, renderHunkDiff } from '../diff/compute';
import { detectPreviewEntry } from './preview';
import type { StagingOverlay } from './overlay';

interface HunkState {
  reverted: boolean;
  comment?: string;
}

/** Decompose a file op into (kind, base, staged) for the diff engine. */
function opParts(op: FileOp): { kind: FileDiff['kind']; base: string; staged: string } {
  if (op.kind === 'create') return { kind: 'create', base: '', staged: op.staged };
  if (op.kind === 'delete') return { kind: 'delete', base: op.base, staged: '' };
  return { kind: 'modify', base: op.base, staged: op.staged };
}

export class ChangeSet {
  private state = new Map<string, HunkState>();

  constructor(
    private readonly overlay: StagingOverlay,
    public readonly id: string = 'changeset',
  ) {}

  /** Raw per-file diffs (no review state merged). */
  private fileDiffs(): FileDiff[] {
    return this.overlay.ops().map((op) => {
      const { kind, base, staged } = opParts(op);
      return computeFileDiff(op.path, kind, base, staged);
    });
  }

  /** Full changeset view with review state merged into each hunk. */
  view(): ChangeSetView {
    const files = this.fileDiffs().map((fd) => ({
      ...fd,
      hunks: fd.hunks.map((h) => this.applyState(h)),
    }));

    let additions = 0;
    let deletions = 0;
    let totalChanges = 0;
    for (const f of files) {
      additions += f.additions;
      deletions += f.deletions;
      totalChanges += f.hunks.length;
    }
    const previewPath = detectPreviewEntry(this.overlay.ops()) ?? undefined;
    return { id: this.id, files, totalChanges, additions, deletions, previewPath };
  }

  private applyState(h: DiffHunk): DiffHunk {
    const st = this.state.get(h.id);
    if (!st) return h;
    return { ...h, reverted: st.reverted, comment: st.comment };
  }

  toggleRevert(hunkId: string, reverted: boolean): void {
    const st = this.state.get(hunkId) ?? { reverted: false };
    st.reverted = reverted;
    this.state.set(hunkId, st);
  }

  setComment(hunkId: string, comment: string | null): void {
    const st = this.state.get(hunkId) ?? { reverted: false };
    st.comment = comment === null ? undefined : comment;
    this.state.set(hunkId, st);
  }

  /**
   * Clear all per-hunk review state (reverts + comments). Callers use this
   * after a Send-Feedback revision produces a fresh changeset, so stale
   * revert/comment state from the previous revision does not leak onto the new
   * hunks.
   */
  resetReviewState(): void {
    this.state.clear();
  }

  /**
   * Render all comments and reverted hunks into a single markdown prompt that
   * asks the model to revise the changeset. Returns null when there is nothing
   * to send (no comments, no reverts).
   */
  feedbackPrompt(): string | null {
    const view = this.view();
    const commented: { path: string; hunk: DiffHunk }[] = [];
    const reverted: { path: string; hunk: DiffHunk }[] = [];
    for (const f of view.files) {
      for (const h of f.hunks) {
        if (h.comment && h.comment.trim()) commented.push({ path: f.path, hunk: h });
        if (h.reverted) reverted.push({ path: f.path, hunk: h });
      }
    }
    if (commented.length === 0 && reverted.length === 0) return null;

    const parts: string[] = ['Revise your changes based on the following review feedback.'];

    if (commented.length > 0) {
      parts.push('\n## Comments to address');
      for (const c of commented) {
        parts.push(`\n**\`${c.path}\`** (around line ${c.hunk.stagedStart}):`);
        parts.push(`> ${c.hunk.comment!.replace(/\n/g, '\n> ')}`);
        parts.push('```diff');
        parts.push(renderHunkDiff(c.hunk));
        parts.push('```');
      }
    }

    if (reverted.length > 0) {
      parts.push('\n## Do not re-apply these reverted changes');
      for (const r of reverted) {
        const end = r.hunk.baseStart + Math.max(0, r.hunk.baseLines.length - 1);
        parts.push(`\n**\`${r.path}\`** (lines ${r.hunk.baseStart}-${end}):`);
        parts.push('```diff');
        parts.push(renderHunkDiff(r.hunk));
        parts.push('```');
      }
    }

    return parts.join('\n');
  }

  /**
   * Ops with reverted hunks materialized OUT. A file whose net effect is empty
   * (all hunks reverted, or a delete undone) drops out entirely.
   */
  effectiveOps(): FileOp[] {
    const result: FileOp[] = [];
    for (const op of this.overlay.ops()) {
      const { kind, base, staged } = opParts(op);
      const fd = computeFileDiff(op.path, kind, base, staged);
      const hunks = fd.hunks.map((h) => this.applyState(h));
      const effStaged = applyHunksToBase(base, hunks, true);

      if (kind === 'create') {
        if (effStaged === base) continue; // base '' -> nothing created
        result.push({ kind: 'create', path: op.path, staged: effStaged });
      } else if (kind === 'delete') {
        if (effStaged === base) continue; // deletion reverted -> keep file, no op
        result.push({ kind: 'delete', path: op.path, base });
      } else {
        if (effStaged === base) continue; // no net change
        result.push({ kind: 'modify', path: op.path, base, staged: effStaged });
      }
    }
    return result;
  }

  summary(): ChangesSummary {
    const v = this.view();
    return {
      changesetId: this.id,
      filesChanged: v.files.length,
      additions: v.additions,
      deletions: v.deletions,
      previewPath: v.previewPath,
    };
  }
}
