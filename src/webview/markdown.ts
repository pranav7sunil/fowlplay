/**
 * Tiny, dependency-free markdown renderer with regex-based syntax highlighting.
 * ALL raw text is HTML-escaped before it enters the output string, so the
 * result is safe to inject via innerHTML. No external libraries.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Syntax highlighting
// ---------------------------------------------------------------------------

interface LangDef {
  keywords: Set<string>;
  types?: Set<string>;
  line?: string[]; // line-comment prefixes
  block?: [string, string]; // block comment delimiters
  hash?: boolean;
}

const KW = (s: string) => new Set(s.split(/\s+/).filter(Boolean));

const LANGS: Record<string, LangDef> = {
  ts: {
    keywords: KW(`abstract any as async await boolean break case catch class const continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let namespace never new null number object of private protected public readonly return satisfies set static string super switch symbol this throw true try type typeof undefined unknown var void while yield`),
    line: ['//'], block: ['/*', '*/'],
  },
  js: {
    keywords: KW(`async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while yield`),
    line: ['//'], block: ['/*', '*/'],
  },
  python: {
    keywords: KW(`and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield match case`),
    hash: true,
  },
  go: {
    keywords: KW(`break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota`),
    types: KW(`int int32 int64 uint uint32 uint64 float32 float64 string bool byte rune error any`),
    line: ['//'], block: ['/*', '*/'],
  },
  rust: {
    keywords: KW(`as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while`),
    types: KW(`i8 i16 i32 i64 u8 u16 u32 u64 usize isize f32 f64 bool char str String Vec Option Result`),
    line: ['//'], block: ['/*', '*/'],
  },
  java: {
    keywords: KW(`abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var record`),
    line: ['//'], block: ['/*', '*/'],
  },
  c: {
    keywords: KW(`auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false nullptr class namespace template public private protected new delete using virtual override`),
    line: ['//'], block: ['/*', '*/'],
  },
  css: {
    keywords: KW(`important inherit initial unset auto none flex grid block inline absolute relative fixed sticky`),
    block: ['/*', '*/'],
  },
  json: { keywords: KW(`true false null`) },
  bash: {
    keywords: KW(`if then else elif fi for while do done case esac function in return export local echo cd exit set unset source alias sudo`),
    hash: true,
  },
  sql: {
    keywords: KW(`select from where insert into values update set delete create table alter drop join left right inner outer on group by order having limit as and or not null distinct primary key foreign references index view union all count sum avg min max`),
    line: ['--'],
  },
  html: { keywords: new Set(), block: ['<!--', '-->'] },
};

const LANG_ALIASES: Record<string, string> = {
  typescript: 'ts', tsx: 'ts', javascript: 'js', jsx: 'js', node: 'js',
  py: 'python', golang: 'go', rs: 'rust', 'c++': 'c', cpp: 'c', cc: 'c', h: 'c',
  hpp: 'c', shell: 'bash', sh: 'bash', zsh: 'bash', scss: 'css', less: 'css',
  xml: 'html', htm: 'html', yml: 'json', yaml: 'json',
};

function resolveLang(lang: string): LangDef | null {
  const key = LANG_ALIASES[lang] || lang;
  return LANGS[key] || null;
}

export function highlightCode(code: string, lang: string): string {
  const def = resolveLang((lang || '').toLowerCase());
  if (!def) return escapeHtml(code);

  let out = '';
  let i = 0;
  const n = code.length;
  const isIdentStart = (c: string) => /[A-Za-z_$]/.test(c);
  const isIdent = (c: string) => /[\w$]/.test(c);

  while (i < n) {
    const c = code[i];
    const two = code.slice(i, i + 2);

    // Block comments
    if (def.block && code.startsWith(def.block[0], i)) {
      const end = code.indexOf(def.block[1], i + def.block[0].length);
      const stop = end === -1 ? n : end + def.block[1].length;
      out += `<span class="tok-comment">${escapeHtml(code.slice(i, stop))}</span>`;
      i = stop;
      continue;
    }
    // Line comments
    let matchedLine = false;
    const linePrefixes = [...(def.line || []), ...(def.hash ? ['#'] : [])];
    for (const p of linePrefixes) {
      if (code.startsWith(p, i)) {
        let end = code.indexOf('\n', i);
        if (end === -1) end = n;
        out += `<span class="tok-comment">${escapeHtml(code.slice(i, end))}</span>`;
        i = end;
        matchedLine = true;
        break;
      }
    }
    if (matchedLine) continue;

    // Strings
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (code[j] === '\\') { j += 2; continue; }
        if (code[j] === c) { j++; break; }
        j++;
      }
      out += `<span class="tok-string">${escapeHtml(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // Numbers
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(code[i + 1] || ''))) {
      let j = i;
      while (j < n && /[0-9a-fA-FxXbo._]/.test(code[j])) j++;
      out += `<span class="tok-number">${escapeHtml(code.slice(i, j))}</span>`;
      i = j;
      continue;
    }
    // Identifiers
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdent(code[j])) j++;
      const word = code.slice(i, j);
      let after = j;
      while (after < n && /\s/.test(code[after])) after++;
      if (def.keywords.has(word)) {
        out += `<span class="tok-keyword">${escapeHtml(word)}</span>`;
      } else if (def.types && def.types.has(word)) {
        out += `<span class="tok-type">${escapeHtml(word)}</span>`;
      } else if (code[after] === '(') {
        out += `<span class="tok-function">${escapeHtml(word)}</span>`;
      } else if (/^[A-Z]/.test(word)) {
        out += `<span class="tok-type">${escapeHtml(word)}</span>`;
      } else {
        out += escapeHtml(word);
      }
      i = j;
      continue;
    }
    // Any other char (avoid two-char escape confusion)
    void two;
    out += escapeHtml(c);
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline markdown (bold, italic, code, links)
// ---------------------------------------------------------------------------

function renderInline(src: string): string {
  // Tokenize inline code first so its contents are not further processed.
  const parts: string[] = [];
  let rest = src;
  const codeRe = /`([^`]+)`/;
  let m: RegExpExecArray | null;
  while ((m = codeRe.exec(rest))) {
    parts.push(formatInline(rest.slice(0, m.index)));
    parts.push(`<code class="fp-inline-code">${escapeHtml(m[1])}</code>`);
    rest = rest.slice(m.index + m[0].length);
  }
  parts.push(formatInline(rest));
  return parts.join('');
}

function formatInline(src: string): string {
  let s = escapeHtml(src);
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_all, text, url) => {
    const safeUrl = /^(https?:|mailto:|#|\/)/i.test(url) ? url : '#';
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  // bold **x** or __x__
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // italic *x* or _x_
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  // strikethrough
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return s;
}

// ---------------------------------------------------------------------------
// Block markdown
// ---------------------------------------------------------------------------

export function renderMarkdown(src: string): string {
  const lines = (src || '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  const flushList = (buf: string[], ordered: boolean) => {
    if (!buf.length) return;
    const tag = ordered ? 'ol' : 'ul';
    out.push(`<${tag}>${buf.map((li) => `<li>${renderInline(li)}</li>`).join('')}</${tag}>`);
    buf.length = 0;
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fence = line.match(/^(```+|~~~+)\s*([\w+#.-]*)\s*$/);
    if (fence) {
      const marker = fence[1][0];
      const lang = fence[2] || '';
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp('^' + marker + '{3,}\\s*$').test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const code = body.join('\n');
      const langLabel = lang ? `<span class="fp-codeblock-lang">${escapeHtml(lang)}</span>` : '<span class="fp-codeblock-lang">text</span>';
      out.push(
        `<div class="fp-codeblock"><div class="fp-codeblock-head">${langLabel}` +
          `<button class="fp-copy-btn" type="button" data-copy>Copy</button></div>` +
          `<pre class="fp-pre"><code>${highlightCode(code, lang)}</code></pre></div>`,
      );
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // Blockquote
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // Table
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      const parseRow = (r: string) =>
        r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const header = parseRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== '') {
        rows.push(parseRow(lines[i]));
        i++;
      }
      let t = '<table><thead><tr>';
      t += header.map((c) => `<th>${renderInline(c)}</th>`).join('');
      t += '</tr></thead><tbody>';
      for (const row of rows) {
        t += '<tr>' + row.map((c) => `<td>${renderInline(c)}</td>`).join('') + '</tr>';
      }
      t += '</tbody></table>';
      out.push(t);
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      flushList(buf, false);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      flushList(buf, true);
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph (gather consecutive non-empty, non-special lines)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(```+|~~~+)/.test(lines[i]) &&
      !/^#{1,6}\s/.test(lines[i]) &&
      !/^\s*>/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^\s*(---|\*\*\*|___)\s*$/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p>${renderInline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}
