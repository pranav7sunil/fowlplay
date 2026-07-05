import { describe, it, expect } from 'vitest';
import { previewCandidates, detectPreviewEntry } from '../src/core/staging/preview';
import { sanitizePreviewPath, mimeFor } from '../src/extension/previewHttp';
import type { FileOp } from '../src/shared/types';

describe('previewCandidates', () => {
  it('orders by extension priority: html > htm > svg > md', () => {
    const ordered = previewCandidates(['a.md', 'b.svg', 'c.htm', 'd.html']);
    expect(ordered).toEqual(['d.html', 'c.htm', 'b.svg', 'a.md']);
  });

  it('prefers index.html over other html pages', () => {
    const ordered = previewCandidates(['about.html', 'index.html', 'contact.html']);
    expect(ordered[0]).toBe('index.html');
  });

  it('prefers a shallower path when extension and index-ness tie', () => {
    const ordered = previewCandidates(['deep/nested/page.html', 'top.html']);
    expect(ordered[0]).toBe('top.html');
  });

  it('breaks remaining ties alphabetically', () => {
    const ordered = previewCandidates(['b.html', 'a.html']);
    expect(ordered).toEqual(['a.html', 'b.html']);
  });

  it('drops non-previewable extensions', () => {
    expect(previewCandidates(['main.ts', 'style.css', 'page.html'])).toEqual(['page.html']);
  });

  it('matches extensions case-insensitively', () => {
    expect(previewCandidates(['PAGE.HTML'])).toEqual(['PAGE.HTML']);
  });
});

describe('detectPreviewEntry', () => {
  const create = (path: string): FileOp => ({ kind: 'create', path, staged: '' });

  it('returns the best entry among non-deleted ops', () => {
    const ops: FileOp[] = [create('notes.md'), create('index.html')];
    expect(detectPreviewEntry(ops)).toBe('index.html');
  });

  it('excludes deleted ops', () => {
    const ops: FileOp[] = [{ kind: 'delete', path: 'index.html', base: '<html/>' }, create('notes.md')];
    expect(detectPreviewEntry(ops)).toBe('notes.md');
  });

  it('returns null when nothing is previewable', () => {
    expect(detectPreviewEntry([create('main.ts')])).toBeNull();
  });

  it('returns null for an empty op list', () => {
    expect(detectPreviewEntry([])).toBeNull();
  });
});

describe('sanitizePreviewPath', () => {
  const token = 'tok';

  it('resolves the token root to the entry path', () => {
    expect(sanitizePreviewPath('/tok/', token, 'site/index.html')).toBe('site/index.html');
  });

  it('returns the requested asset path under the token', () => {
    expect(sanitizePreviewPath('/tok/site/style.css', token, 'site/index.html')).toBe('site/style.css');
  });

  it('rejects a missing token', () => {
    expect(sanitizePreviewPath('/site/index.html', token, 'index.html')).toBeNull();
  });

  it('rejects a wrong token', () => {
    expect(sanitizePreviewPath('/nope/index.html', token, 'index.html')).toBeNull();
  });

  it('rejects raw .. traversal', () => {
    expect(sanitizePreviewPath('/tok/../secret.txt', token, 'index.html')).toBeNull();
  });

  it('rejects URL-encoded .. traversal', () => {
    expect(sanitizePreviewPath('/tok/%2e%2e/secret.txt', token, 'index.html')).toBeNull();
  });

  it('rejects backslashes', () => {
    expect(sanitizePreviewPath('/tok/..\\secret.txt', token, 'index.html')).toBeNull();
  });

  it('strips query strings', () => {
    expect(sanitizePreviewPath('/tok/app.js?v=2', token, 'index.html')).toBe('app.js');
  });

  it('decodes %20', () => {
    expect(sanitizePreviewPath('/tok/my%20page.html', token, 'index.html')).toBe('my page.html');
  });
});

describe('mimeFor', () => {
  it('serves html as text/html with charset', () => {
    expect(mimeFor('index.html')).toBe('text/html; charset=utf-8');
  });
  it('serves svg as image/svg+xml with charset', () => {
    expect(mimeFor('logo.svg')).toBe('image/svg+xml; charset=utf-8');
  });
  it('serves js as text/javascript with charset', () => {
    expect(mimeFor('app.mjs')).toBe('text/javascript; charset=utf-8');
  });
  it('serves png without charset', () => {
    expect(mimeFor('icon.png')).toBe('image/png');
  });
  it('falls back to octet-stream for unknown extensions', () => {
    expect(mimeFor('data.bin')).toBe('application/octet-stream');
  });
});
