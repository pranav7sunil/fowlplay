/**
 * PRD decomposition unit tests — the pure `core/harness/prd.ts`:
 * Foreman parsing (fenced / bare / invalid / caps + drop-empties), on-disk spec rendering,
 * spec-path slugging, and per-story prompt composition.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_STORIES,
  composeStoryPrompt,
  parseForeman,
  renderSpecMarkdown,
  specRelPath,
  type PrdStory,
} from '../src/core/harness/prd';

const story = (over: Partial<PrdStory> = {}): PrdStory => ({
  title: 'Add pagination',
  summary: 'Paginate the /users endpoint so large lists stay fast.',
  criteria: ['GET /users accepts ?page and ?limit', 'Response includes a total count'],
  specPath: '.fowlplay/specs/abcd1234/01-add-pagination.md',
  status: 'pending',
  ...over,
});

// ---------------------------------------------------------------------------
// parseForeman
// ---------------------------------------------------------------------------

describe('parseForeman', () => {
  it('parses a fenced JSON block of stories', () => {
    const text =
      'Here is the plan:\n```json\n' +
      JSON.stringify({
        stories: [
          { title: 'Story A', summary: 'first', criteria: ['a1', 'a2'] },
          { title: 'Story B', summary: 'second', criteria: ['b1'] },
        ],
      }) +
      '\n```\nThat covers it.';
    const stories = parseForeman(text);
    expect(stories).toHaveLength(2);
    expect(stories[0]).toEqual({ title: 'Story A', summary: 'first', criteria: ['a1', 'a2'] });
    expect(stories[1].title).toBe('Story B');
  });

  it('parses bare JSON with no fences', () => {
    const text = '{"stories":[{"title":"X","summary":"s","criteria":["c1","c2"]},{"title":"Y","criteria":["d1"]}]}';
    const stories = parseForeman(text);
    expect(stories.map((s) => s.title)).toEqual(['X', 'Y']);
    expect(stories[1].summary).toBe(''); // missing summary coerces to empty
  });

  it('returns [] for unparseable text', () => {
    expect(parseForeman('sorry, I could not break this down')).toEqual([]);
    expect(parseForeman('')).toEqual([]);
    // Valid JSON but no stories array.
    expect(parseForeman('{"foo":"bar"}')).toEqual([]);
  });

  it('drops empty stories (no title and no criteria)', () => {
    const text = JSON.stringify({
      stories: [
        { title: 'Keep me', criteria: ['c1'] },
        { title: '', summary: '', criteria: [] }, // dropped
        { criteria: ['only criteria'] }, // kept — falls back to a synthetic title
      ],
    });
    const stories = parseForeman(text);
    expect(stories).toHaveLength(2);
    expect(stories[0].title).toBe('Keep me');
    expect(stories[1].criteria).toEqual(['only criteria']);
    expect(stories[1].title).toBeTruthy();
  });

  it('caps the story count at MAX_STORIES', () => {
    const many = Array.from({ length: MAX_STORIES + 5 }, (_, i) => ({
      title: `S${i}`,
      criteria: [`c${i}`],
    }));
    const stories = parseForeman(JSON.stringify({ stories: many }));
    expect(stories).toHaveLength(MAX_STORIES);
    expect(stories[0].title).toBe('S0');
    expect(stories[MAX_STORIES - 1].title).toBe(`S${MAX_STORIES - 1}`);
  });

  it('tolerates a criteria string list on a single field', () => {
    const stories = parseForeman('{"stories":[{"title":"T","criteria":"c1\\nc2"}]}');
    expect(stories[0].criteria).toEqual(['c1', 'c2']);
  });
});

// ---------------------------------------------------------------------------
// renderSpecMarkdown
// ---------------------------------------------------------------------------

describe('renderSpecMarkdown', () => {
  it('renders title, status line, summary, criteria checklist, and the N-of-M footer', () => {
    const md = renderSpecMarkdown(story(), 1, 3);
    expect(md).toContain('# Add pagination');
    expect(md).toContain('**Status:** Pending');
    expect(md).toContain('Paginate the /users endpoint');
    expect(md).toContain('## Acceptance criteria');
    expect(md).toContain('- [ ] GET /users accepts ?page and ?limit');
    expect(md).toContain('- [ ] Response includes a total count');
    expect(md).toContain('_Story 1 of 3._');
  });

  it('reflects the story status in the status line and includes an optional PRD title', () => {
    const md = renderSpecMarkdown(story({ status: 'awaiting-review' }), 2, 4, 'My PRD');
    expect(md).toContain('**Status:** Awaiting review');
    expect(md).toContain('Decomposed from PRD: My PRD');
    expect(md).toContain('_Story 2 of 4._');
  });

  it('appends a note to the status line (e.g. skipped review)', () => {
    const md = renderSpecMarkdown(story({ status: 'done' }), 1, 2, undefined, 'skipped review');
    expect(md).toContain('**Status:** Done (skipped review)');
  });

  it('renders a placeholder when there are no criteria', () => {
    const md = renderSpecMarkdown(story({ criteria: [] }), 1, 1);
    expect(md).toContain('_none specified_');
  });
});

// ---------------------------------------------------------------------------
// specRelPath
// ---------------------------------------------------------------------------

describe('specRelPath', () => {
  it('uses the first 8 alphanumerics of the conv id, a zero-padded index, and a slug', () => {
    expect(specRelPath('abcd1234efgh5678', 1, 'Add the /users pagination endpoint')).toBe(
      '.fowlplay/specs/abcd1234/01-add-the-users-pagination-endpoint.md',
    );
    expect(specRelPath('abcd1234', 12, 'Wire it up!')).toBe('.fowlplay/specs/abcd1234/12-wire-it-up.md');
  });

  it('strips non-alphanumerics from the conv id segment', () => {
    // Hyphenated uuid-like id → first 8 alphanumerics only.
    expect(specRelPath('a1b2-c3d4-e5f6', 3, 'Title')).toBe('.fowlplay/specs/a1b2c3d4/03-title.md');
  });

  it('collapses and trims slug separators and caps length', () => {
    expect(specRelPath('conv0001', 1, '  Weird**Title -- with   junk  ')).toBe(
      '.fowlplay/specs/conv0001/01-weird-title-with-junk.md',
    );
    const long = 'a'.repeat(80);
    const path = specRelPath('conv0001', 1, long);
    // The slug is capped so the filename stays reasonable.
    expect(path.length).toBeLessThan('.fowlplay/specs/conv0001/01-.md'.length + 55);
  });

  it('falls back to a placeholder slug/dir when inputs are empty', () => {
    expect(specRelPath('', 1, '')).toBe('.fowlplay/specs/conv/01-story.md');
  });
});

// ---------------------------------------------------------------------------
// composeStoryPrompt
// ---------------------------------------------------------------------------

describe('composeStoryPrompt', () => {
  it('prepends the story-N-of-M preamble to the spec text', () => {
    const spec = '# Add pagination\n\n**Status:** Building\n';
    const prompt = composeStoryPrompt(spec, 2, 5);
    expect(prompt).toContain('Story 2 of 5 decomposed from a PRD');
    expect(prompt).toContain('Implement ONLY this story');
    expect(prompt).toContain('earlier stories are already staged/applied');
    expect(prompt).toContain('# Add pagination');
    // The spec text follows the preamble.
    expect(prompt.indexOf('Story 2 of 5')).toBeLessThan(prompt.indexOf('# Add pagination'));
  });
});
