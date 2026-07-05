import { describe, it, expect } from 'vitest';
import { StagingOverlay, type DiskReader } from '../src/core/staging/overlay';
import { ChangeSet } from '../src/core/staging/changeset';
import { detectDrift, rebase } from '../src/core/staging/rebase';

class MockDisk implements DiskReader {
  constructor(public files: Record<string, string> = {}) {}
  async read(path: string): Promise<string | null> {
    return path in this.files ? this.files[path] : null;
  }
  async exists(path: string): Promise<boolean> {
    return path in this.files;
  }
}

describe('StagingOverlay edge transitions', () => {
  it('read returns staged content over disk', async () => {
    const disk = new MockDisk({ 'a.ts': 'disk' });
    const o = new StagingOverlay(disk);
    expect(await o.read('a.ts')).toBe('disk');
    await o.stageModify('a.ts', 'staged');
    expect(await o.read('a.ts')).toBe('staged');
  });

  it('changeset view() and summary() expose the detected preview entry', async () => {
    const disk = new MockDisk();
    const o = new StagingOverlay(disk);
    await o.stageCreate('src/main.ts', 'export {};');
    await o.stageCreate('site/index.html', '<h1>hi</h1>');
    const cs = new ChangeSet(o, 'cs');
    expect(cs.view().previewPath).toBe('site/index.html');
    expect(cs.summary().previewPath).toBe('site/index.html');
  });

  it('changeset previewPath is undefined when nothing is previewable', async () => {
    const disk = new MockDisk();
    const o = new StagingOverlay(disk);
    await o.stageCreate('src/main.ts', 'export {};');
    const cs = new ChangeSet(o, 'cs');
    expect(cs.view().previewPath).toBeUndefined();
  });

  it('modify captures base from disk on first touch', async () => {
    const disk = new MockDisk({ 'a.ts': 'original' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'v1');
    await o.stageModify('a.ts', 'v2');
    const op = o.ops()[0];
    expect(op).toMatchObject({ kind: 'modify', base: 'original', staged: 'v2' });
  });

  it('modify-then-delete becomes delete with original base', async () => {
    const disk = new MockDisk({ 'a.ts': 'original' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'changed');
    await o.stageDelete('a.ts');
    expect(o.ops()[0]).toEqual({ kind: 'delete', path: 'a.ts', base: 'original' });
    expect(await o.read('a.ts')).toBeNull();
  });

  it('create-then-modify stays create', async () => {
    const disk = new MockDisk();
    const o = new StagingOverlay(disk);
    await o.stageCreate('new.ts', 'v1');
    await o.stageModify('new.ts', 'v2');
    expect(o.ops()[0]).toEqual({ kind: 'create', path: 'new.ts', staged: 'v2' });
  });

  it('create-then-delete removes the op entirely', async () => {
    const disk = new MockDisk();
    const o = new StagingOverlay(disk);
    await o.stageCreate('new.ts', 'v1');
    await o.stageDelete('new.ts');
    expect(o.isEmpty()).toBe(true);
  });

  it('delete-then-create becomes modify', async () => {
    const disk = new MockDisk({ 'a.ts': 'original' });
    const o = new StagingOverlay(disk);
    await o.stageDelete('a.ts');
    await o.stageCreate('a.ts', 'recreated');
    expect(o.ops()[0]).toEqual({ kind: 'modify', path: 'a.ts', base: 'original', staged: 'recreated' });
  });

  it('modify on a nonexistent file becomes a create', async () => {
    const disk = new MockDisk();
    const o = new StagingOverlay(disk);
    await o.stageModify('ghost.ts', 'content');
    expect(o.ops()[0]).toEqual({ kind: 'create', path: 'ghost.ts', staged: 'content' });
  });

  it('discard removes one or all', async () => {
    const disk = new MockDisk({ 'a.ts': '1', 'b.ts': '2' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'x');
    await o.stageModify('b.ts', 'y');
    o.discard('a.ts');
    expect(o.ops()).toHaveLength(1);
    o.discard();
    expect(o.isEmpty()).toBe(true);
  });

  it('serialize / deserialize round-trips', async () => {
    const disk = new MockDisk({ 'a.ts': 'orig' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'new');
    const data = o.serialize();
    const restored = StagingOverlay.deserialize(data, disk);
    expect(restored.ops()).toEqual(o.ops());
    expect(await restored.read('a.ts')).toBe('new');
  });
});

describe('StagingOverlay clone independence', () => {
  it('clone is deep and independent', async () => {
    const disk = new MockDisk({ 'a.ts': 'orig' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'v1');
    const c = o.clone();
    await c.stageModify('a.ts', 'v2');
    await c.stageModify('b.ts', 'created');
    expect(await o.read('a.ts')).toBe('v1');
    expect(o.has('b.ts')).toBe(false);
    expect(await c.read('a.ts')).toBe('v2');
  });
});

describe('ChangeSet selective revert', () => {
  it('view merges revert/comment state via stable ids', async () => {
    const disk = new MockDisk({ 'a.ts': 'a\nb\nc' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'a\nB\nc');
    const cs = new ChangeSet(o, 'cs1');
    const hunkId = cs.view().files[0].hunks[0].id;
    cs.toggleRevert(hunkId, true);
    cs.setComment(hunkId, 'please keep b');
    const h = cs.view().files[0].hunks[0];
    expect(h.reverted).toBe(true);
    expect(h.comment).toBe('please keep b');
  });

  it('effectiveOps materializes reverted hunks out', async () => {
    const disk = new MockDisk({ 'a.ts': 'a\nb\nc\nd\ne\nf\ng' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'a\nB\nc\nd\ne\nF\ng');
    const cs = new ChangeSet(o, 'cs1');
    const hunks = cs.view().files[0].hunks;
    expect(hunks).toHaveLength(2);
    cs.toggleRevert(hunks[0].id, true); // revert the "b -> B" change only
    const eff = cs.effectiveOps();
    expect(eff).toHaveLength(1);
    expect(eff[0]).toMatchObject({ kind: 'modify', path: 'a.ts', staged: 'a\nb\nc\nd\ne\nF\ng' });
  });

  it('a file with all hunks reverted drops out of effectiveOps', async () => {
    const disk = new MockDisk({ 'a.ts': 'a\nb\nc' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'a\nX\nc');
    const cs = new ChangeSet(o, 'cs1');
    for (const h of cs.view().files[0].hunks) cs.toggleRevert(h.id, true);
    expect(cs.effectiveOps()).toHaveLength(0);
  });

  it('reverting a delete keeps the file', async () => {
    const disk = new MockDisk({ 'a.ts': 'gone' });
    const o = new StagingOverlay(disk);
    await o.stageDelete('a.ts');
    const cs = new ChangeSet(o, 'cs1');
    for (const h of cs.view().files[0].hunks) cs.toggleRevert(h.id, true);
    expect(cs.effectiveOps()).toHaveLength(0);
  });

  it('feedbackPrompt renders comments and reverts, else null', async () => {
    const disk = new MockDisk({ 'a.ts': 'a\nb\nc\nd\ne\nf\ng' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'a\nB\nc\nd\ne\nF\ng');
    const cs = new ChangeSet(o, 'cs1');
    expect(cs.feedbackPrompt()).toBeNull();
    const hunks = cs.view().files[0].hunks;
    cs.setComment(hunks[0].id, 'use uppercase everywhere');
    cs.toggleRevert(hunks[1].id, true);
    const prompt = cs.feedbackPrompt()!;
    expect(prompt).toContain('Revise your changes');
    expect(prompt).toContain('use uppercase everywhere');
    expect(prompt).toContain('Do not re-apply');
    expect(prompt).toContain('a.ts');
    expect(prompt).toContain('```diff');
  });

  it('summary reports files and totals', async () => {
    const disk = new MockDisk({ 'a.ts': 'a\nb', 'b.ts': 'x' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'a\nB');
    await o.stageCreate('c.ts', 'new');
    const cs = new ChangeSet(o, 'cs1');
    const s = cs.summary();
    expect(s.changesetId).toBe('cs1');
    expect(s.filesChanged).toBe(2);
    expect(s.additions).toBeGreaterThan(0);
  });
});

describe('rebase / drift detection', () => {
  it('detects drift when disk changes under a staged edit', async () => {
    const disk = new MockDisk({ 'a.ts': 'a\nb\nc' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'a\nB\nc');
    expect((await detectDrift(o, disk)).needed).toBe(false);
    disk.files['a.ts'] = 'a\nb\nc\nEXTRA'; // external change
    const drift = await detectDrift(o, disk);
    expect(drift.needed).toBe(true);
    expect(drift.conflictedPaths).toContain('a.ts');
  });

  it('cleanly rebases a non-overlapping change onto drifted disk', async () => {
    // Staged edit changes line "b" -> "B". Disk gains an unrelated trailing line.
    const disk = new MockDisk({ 'a.ts': 'a\nb\nc' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'a\nB\nc');
    disk.files['a.ts'] = 'a\nb\nc\nd'; // appended after the edited region
    const res = await rebase(o, disk);
    expect(res.conflictedPaths).toHaveLength(0);
    expect(res.rebasedPaths).toContain('a.ts');
    expect(res.merged['a.ts']).toBe('a\nB\nc\nd');
    // Overlay restaged against the new disk base.
    expect(o.ops()[0]).toMatchObject({ kind: 'modify', base: 'a\nb\nc\nd', staged: 'a\nB\nc\nd' });
  });

  it('rebases with line-shift tolerance (edited region moved down)', async () => {
    const disk = new MockDisk({ 'a.ts': 'a\nb\nc' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'a\nB\nc');
    disk.files['a.ts'] = 'header1\nheader2\na\nb\nc'; // shifted by 2 lines
    const res = await rebase(o, disk);
    expect(res.conflictedPaths).toHaveLength(0);
    expect(res.merged['a.ts']).toBe('header1\nheader2\na\nB\nc');
  });

  it('reports a conflict when the edited context no longer exists', async () => {
    const disk = new MockDisk({ 'a.ts': 'a\nb\nc' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'a\nB\nc');
    disk.files['a.ts'] = 'totally\ndifferent\nfile\nbody'; // context gone
    const res = await rebase(o, disk);
    expect(res.conflictedPaths).toContain('a.ts');
    expect(res.rebasedPaths).not.toContain('a.ts');
  });

  it('R1: conflicts (not false-clean) when context is destroyed but a stray copy of the removed line survives', async () => {
    // base A/B/TARGET/C/D, edit TARGET -> CHANGED.
    const disk = new MockDisk({ 'a.ts': 'A\nB\nTARGET\nC\nD' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'A\nB\nCHANGED\nC\nD');
    // Disk drifts: all real context (A/B/C/D) is gone; an UNRELATED stray
    // TARGET now sits on line 1. The edit's context no longer exists.
    disk.files['a.ts'] = 'TARGET\nP\nQ\nR';
    const res = await rebase(o, disk);
    // Must be a conflict — must NOT silently rewrite the unrelated top line.
    expect(res.conflictedPaths).toContain('a.ts');
    expect(res.merged['a.ts']).toBeUndefined();
  });

  it('R1: a genuine clean shift with the edit context intact still merges', async () => {
    const disk = new MockDisk({ 'a.ts': 'A\nB\nTARGET\nC\nD' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'A\nB\nCHANGED\nC\nD');
    // Unrelated lines prepended; the edit's real context (A/B/C/D) survives.
    disk.files['a.ts'] = 'H1\nH2\nA\nB\nTARGET\nC\nD';
    const res = await rebase(o, disk);
    expect(res.conflictedPaths).toHaveLength(0);
    expect(res.merged['a.ts']).toBe('H1\nH2\nA\nB\nCHANGED\nC\nD');
  });

  it('a staged create conflicts once the file appears on disk (model-merge path)', async () => {
    const disk = new MockDisk();
    const o = new StagingOverlay(disk);
    await o.stageCreate('new.ts', 'staged content');
    expect((await detectDrift(o, disk)).needed).toBe(false);
    disk.files['new.ts'] = 'someone else created this'; // file appeared
    const res = await rebase(o, disk);
    // A create-onto-existing cannot be merged mechanically — it is a conflict for
    // the caller to route to the model; the overlay op is left untouched.
    expect(res.conflictedPaths).toContain('new.ts');
    expect(res.rebasedPaths).toHaveLength(0);
    expect(res.changedDeletes).toHaveLength(0);
    expect(o.ops()[0]).toMatchObject({ kind: 'create', path: 'new.ts', staged: 'staged content' });
  });

  it('a staged delete of a changed file stays a delete, re-based onto new disk', async () => {
    const disk = new MockDisk({ 'a.ts': 'original' });
    const o = new StagingOverlay(disk);
    await o.stageDelete('a.ts');
    expect((await detectDrift(o, disk)).needed).toBe(false);
    disk.files['a.ts'] = 'changed externally'; // the file we meant to delete changed
    const res = await rebase(o, disk);
    // Deleting a changed file is still a delete — kept as a delete, base re-based,
    // reported as a changed-delete (NOT a model conflict).
    expect(res.changedDeletes).toContain('a.ts');
    expect(res.conflictedPaths).toHaveLength(0);
    expect(o.ops()[0]).toEqual({ kind: 'delete', path: 'a.ts', base: 'changed externally' });
    // The drift is cleared: the delete now bases on current disk.
    expect((await detectDrift(o, disk)).needed).toBe(false);
    // read still reflects the delete intent.
    expect(await o.read('a.ts')).toBeNull();
  });
});

describe('ChangeSet.resetReviewState', () => {
  it('clears all revert and comment state', async () => {
    const disk = new MockDisk({ 'a.ts': 'a\nb\nc' });
    const o = new StagingOverlay(disk);
    await o.stageModify('a.ts', 'a\nB\nc');
    const cs = new ChangeSet(o, 'cs1');
    const hunkId = cs.view().files[0].hunks[0].id;
    cs.toggleRevert(hunkId, true);
    cs.setComment(hunkId, 'please keep b');
    cs.resetReviewState();
    const h = cs.view().files[0].hunks[0];
    expect(h.reverted).toBe(false);
    expect(h.comment).toBeUndefined();
  });
});
