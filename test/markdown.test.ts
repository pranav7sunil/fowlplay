import { describe, it, expect } from 'vitest';
import { escapeHtml, highlightCode, renderMarkdown } from '../src/webview/markdown';

describe('renderMarkdown lists', () => {
  it('keeps consecutive numbered items with nested bullets in one <ol>', () => {
    const src = [
      '1. **Scout**',
      '   - **Role:** reads request',
      '2. **Builder**',
      '   - **Role:** writes code',
    ].join('\n');
    const html = renderMarkdown(src);

    // Exactly one <ol> wrapping the whole thing.
    expect(html.match(/<ol\b/g)?.length ?? 0).toBe(1);
    expect(html.match(/<\/ol>/g)?.length ?? 0).toBe(1);
    // Each numbered item carries a nested <ul>.
    expect(html.match(/<ul>/g)?.length ?? 0).toBe(2);
    expect(html).toContain('<strong>Scout</strong>');
    expect(html).toContain('<strong>Builder</strong>');
    expect(html).toContain('<strong>Role:</strong> reads request');
    expect(html).toContain('<strong>Role:</strong> writes code');
    // Structure: <ol><li>...<ul>...</ul></li><li>...<ul>...</ul></li></ol>
    expect(html).toMatch(
      /<ol><li><strong>Scout<\/strong><ul><li><strong>Role:<\/strong> reads request<\/li><\/ul><\/li><li><strong>Builder<\/strong><ul><li><strong>Role:<\/strong> writes code<\/li><\/ul><\/li><\/ol>/,
    );
  });

  it('honors a non-1 starting number with the start attribute', () => {
    const html = renderMarkdown(['3. three', '4. four', '5. five'].join('\n'));
    expect(html).toContain('<ol start="3">');
    expect(html.match(/<ol\b/g)?.length ?? 0).toBe(1);
    expect(html.match(/<li>/g)?.length ?? 0).toBe(3);
  });

  it('uses a plain <ol> when the list starts at 1', () => {
    const html = renderMarkdown(['1. one', '2. two'].join('\n'));
    expect(html).toContain('<ol>');
    expect(html).not.toContain('start=');
  });

  it('renders three levels of nesting', () => {
    const src = ['- a', '  - b', '    - c'].join('\n');
    const html = renderMarkdown(src);
    expect(html).toBe('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li></ul>');
  });

  it('supports ul nested inside ol', () => {
    const src = ['1. outer', '   - inner'].join('\n');
    const html = renderMarkdown(src);
    expect(html).toBe('<ol><li>outer<ul><li>inner</li></ul></li></ol>');
  });

  it('supports ol nested inside ul', () => {
    const src = ['- outer', '   1. inner', '   2. inner two'].join('\n');
    const html = renderMarkdown(src);
    expect(html).toBe('<ul><li>outer<ol><li>inner</li><li>inner two</li></ol></li></ul>');
  });

  it('tolerates 2-, 3-, and 4-space nested indents', () => {
    for (const pad of ['  ', '   ', '    ']) {
      const html = renderMarkdown(['- top', `${pad}- child`].join('\n'));
      expect(html).toBe('<ul><li>top<ul><li>child</li></ul></li></ul>');
    }
  });

  it('escapes <script> inside list items', () => {
    const html = renderMarkdown('- <script>alert(1)</script>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('renderInline emphasis and inline code', () => {
  it('renders bold spanning an inline-code span', () => {
    const html = renderMarkdown('**bold with `code` inside**');
    expect(html).not.toContain('**');
    expect(html).toContain('<strong>');
    expect(html).toContain('<code class="fp-inline-code">code</code>');
    expect(html).toMatch(
      /<strong>bold with <code class="fp-inline-code">code<\/code> inside<\/strong>/,
    );
  });

  it('renders plain italic and strikethrough', () => {
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>');
    expect(renderMarkdown('~~gone~~')).toContain('<del>gone</del>');
  });

  it('does not further process inline-code contents', () => {
    const html = renderMarkdown('use `**not bold** and _not italic_`');
    expect(html).toContain(
      '<code class="fp-inline-code">**not bold** and _not italic_</code>',
    );
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<em>');
  });

  it('escapes html inside inline code', () => {
    const html = renderMarkdown('`<script>`');
    expect(html).toContain('<code class="fp-inline-code">&lt;script&gt;</code>');
    expect(html).not.toContain('<script>');
  });

  it('escapes <script> in inline text', () => {
    const html = renderMarkdown('hello <script>alert(1)</script> world');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('cannot be tricked by sentinel chars in input', () => {
    // A raw private-use sentinel plus digits must not forge a <code> element.
    const html = renderMarkdown('0 `real`');
    expect(html).toContain('<code class="fp-inline-code">real</code>');
    // Only the genuine code span becomes a <code> element.
    expect(html.match(/<code /g)?.length ?? 0).toBe(1);
  });
});

describe('renderMarkdown unchanged block behavior', () => {
  it('renders a fenced code block', () => {
    const src = ['```ts', 'const x = 1;', '```'].join('\n');
    const html = renderMarkdown(src);
    expect(html).toContain('fp-codeblock');
    expect(html).toContain('<pre class="fp-pre"><code>');
    expect(html).toContain('fp-copy-btn');
    expect(html).toContain('<span class="tok-keyword">const</span>');
  });

  it('renders a table', () => {
    const src = ['| a | b |', '| - | - |', '| 1 | 2 |'].join('\n');
    const html = renderMarkdown(src);
    expect(html).toContain('<table><thead><tr><th>a</th><th>b</th></tr></thead>');
    expect(html).toContain('<tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
  });

  it('renders a blockquote', () => {
    const html = renderMarkdown('> quoted text');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('quoted text');
    expect(html).toContain('</blockquote>');
  });

  it('renders headings and paragraphs', () => {
    expect(renderMarkdown('# Title')).toBe('<h1>Title</h1>');
    expect(renderMarkdown('plain line')).toBe('<p>plain line</p>');
  });
});

describe('escapeHtml and highlightCode exports', () => {
  it('escapes the five entities', () => {
    expect(escapeHtml(`<>&"'`)).toBe('&lt;&gt;&amp;&quot;&#39;');
  });

  it('highlights a keyword and escapes unknown languages', () => {
    expect(highlightCode('const', 'ts')).toContain('tok-keyword');
    expect(highlightCode('<x>', 'unknownlang')).toBe('&lt;x&gt;');
  });
});
