import { describe, it, expect } from 'vitest';
import { applyHunksToBase, computeFileDiff, renderHunkDiff } from '../src/core/diff/compute';

/** Round-trip property: replaying all hunks reconstructs staged exactly. */
function roundTrip(base: string, staged: string): void {
  const fd = computeFileDiff('f.ts', 'modify', base, staged);
  expect(applyHunksToBase(base, fd.hunks, false)).toBe(staged);
}

describe('computeFileDiff round-trip', () => {
  const fixtures: [string, string, string][] = [
    ['identical', 'a\nb\nc', 'a\nb\nc'],
    ['single line change', 'a\nb\nc', 'a\nB\nc'],
    ['insertion', 'a\nc', 'a\nb\nc'],
    ['deletion', 'a\nb\nc', 'a\nc'],
    ['append at end', 'a\nb', 'a\nb\nc\nd'],
    ['prepend at start', 'b\nc', 'a\nb\nc'],
    ['adjacent hunks', 'a\nb\nc\nd\ne\nf\ng', 'a\nB\nc\nd\ne\nF\ng'],
    ['trailing newline added', 'a\nb', 'a\nb\n'],
    ['trailing newline removed', 'a\nb\n', 'a\nb'],
    ['empty to content', '', 'x\ny\nz'],
    ['content to empty', 'x\ny\nz', ''],
    ['multi-line replace', 'a\nb\nc\nd', 'a\nX\nY\nZ\nd'],
    ['everything different', 'a\nb\nc', 'x\ny\nz'],
  ];

  for (const [name, base, staged] of fixtures) {
    it(name, () => roundTrip(base, staged));
  }
});

describe('computeFileDiff hunks', () => {
  it('produces 1-based positions and correct add/del counts', () => {
    const fd = computeFileDiff('f.ts', 'modify', 'a\nb\nc\nd\ne', 'a\nb\nX\nd\ne');
    expect(fd.hunks).toHaveLength(1);
    const h = fd.hunks[0];
    expect(h.baseStart).toBe(3);
    expect(h.stagedStart).toBe(3);
    expect(h.baseLines).toEqual(['c']);
    expect(h.stagedLines).toEqual(['X']);
    expect(h.contextBefore).toEqual(['a', 'b']);
    expect(h.contextAfter).toEqual(['d', 'e']);
    expect(fd.additions).toBe(1);
    expect(fd.deletions).toBe(1);
  });

  it('caps context at 3 lines', () => {
    const fd = computeFileDiff('f.ts', 'modify', '1\n2\n3\n4\n5\nX\n6\n7\n8\n9', '1\n2\n3\n4\n5\nY\n6\n7\n8\n9');
    const h = fd.hunks[0];
    expect(h.contextBefore).toEqual(['3', '4', '5']);
    expect(h.contextAfter).toEqual(['6', '7', '8']);
  });

  it('groups separated changes into distinct hunks', () => {
    const fd = computeFileDiff('f.ts', 'modify', 'a\nb\nc\nd\ne\nf\ng', 'a\nB\nc\nd\ne\nF\ng');
    expect(fd.hunks).toHaveLength(2);
  });

  it('gives stable, content-derived ids that survive unrelated edits', () => {
    const base = 'a\nb\nc\nd\ne\nf\ng';
    const fd1 = computeFileDiff('f.ts', 'modify', base, 'a\nB\nc\nd\ne\nF\ng');
    // Change only the first hunk; the second hunk's content is unchanged.
    const fd2 = computeFileDiff('f.ts', 'modify', base, 'a\nBB\nc\nd\ne\nF\ng');
    const secondId1 = fd1.hunks[1].id;
    const secondId2 = fd2.hunks[1].id;
    expect(secondId2).toBe(secondId1);
    // The changed hunk gets a different id.
    expect(fd2.hunks[0].id).not.toBe(fd1.hunks[0].id);
  });

  it('C4: identical-content hunks with different context get distinct, stable ids', () => {
    const base = 'x\nfoo\ny\nfoo\nz';
    // Both foo -> bar: two byte-identical hunks in different surrounding context.
    const both = computeFileDiff('f.ts', 'modify', base, 'x\nbar\ny\nbar\nz');
    expect(both.hunks).toHaveLength(2);
    const firstId = both.hunks[0].id;
    const secondId = both.hunks[1].id;
    expect(firstId).not.toBe(secondId);

    // Recompute with ONLY the second foo -> bar applied; the first is dropped.
    const onlySecond = computeFileDiff('f.ts', 'modify', base, 'x\nfoo\ny\nbar\nz');
    expect(onlySecond.hunks).toHaveLength(1);
    // The survivor keeps ITS OWN id and does not inherit the first hunk's id,
    // so review state stays attached to the correct hunk.
    expect(onlySecond.hunks[0].id).toBe(secondId);
    expect(onlySecond.hunks[0].id).not.toBe(firstId);
  });

  it('create uses empty base, delete uses empty staged', () => {
    const create = computeFileDiff('n.ts', 'create', '', 'hello\nworld');
    expect(applyHunksToBase('', create.hunks, false)).toBe('hello\nworld');
    const del = computeFileDiff('n.ts', 'delete', 'hello\nworld', '');
    expect(applyHunksToBase('hello\nworld', del.hunks, false)).toBe('');
  });
});

describe('applyHunksToBase selective revert', () => {
  it('drops reverted hunks, keeping the rest', () => {
    const base = 'a\nb\nc\nd\ne\nf\ng';
    const staged = 'a\nB\nc\nd\ne\nF\ng';
    const fd = computeFileDiff('f.ts', 'modify', base, staged);
    // Revert the first hunk only.
    fd.hunks[0].reverted = true;
    const result = applyHunksToBase(base, fd.hunks, true);
    expect(result).toBe('a\nb\nc\nd\ne\nF\ng');
  });

  it('reverting all hunks restores base', () => {
    const base = 'a\nb\nc';
    const fd = computeFileDiff('f.ts', 'modify', base, 'a\nX\nY');
    for (const h of fd.hunks) h.reverted = true;
    expect(applyHunksToBase(base, fd.hunks, true)).toBe(base);
  });
});

describe('renderHunkDiff', () => {
  it('renders unified-diff markers', () => {
    const fd = computeFileDiff('f.ts', 'modify', 'a\nb\nc', 'a\nB\nc');
    const text = renderHunkDiff(fd.hunks[0]);
    expect(text).toContain('-b');
    expect(text).toContain('+B');
    expect(text).toContain(' a');
    expect(text).toContain(' c');
  });
});
