/**
 * Conversation serialization — markdown / JSON export and summary.
 *
 * `toMarkdown` renders the active path as readable markdown (## User /
 * ## Assistant), collapsing tool calls to bullet summaries and gate cards to
 * blockquotes. `toJSON` produces stable, key-sorted pretty JSON so exports
 * diff cleanly. `toSummary` builds the lightweight history-panel record.
 */

import type { ContentBlock, Conversation, ConversationSummary } from '../../shared/types';
import { activePath } from './tree';

export function toMarkdown(conv: Conversation): string {
  const out: string[] = [`# ${conv.title}`, ''];
  for (const node of activePath(conv)) {
    out.push(node.role === 'user' ? '## User' : '## Assistant');
    out.push('');
    for (const b of node.blocks) {
      out.push(renderBlock(b));
      out.push('');
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function renderBlock(b: ContentBlock): string {
  switch (b.type) {
    case 'text':
      return b.text;
    case 'thinking': {
      const dur = b.durationMs ? ` (${(b.durationMs / 1000).toFixed(1)}s)` : '';
      const body = b.text.replace(/\n/g, '\n> ');
      return `> 🧠 **Thinking${dur}**\n> ${body}`;
    }
    case 'tool_call': {
      const icon = b.call.ok ? '🔧' : '⚠️';
      return `- ${icon} \`${b.call.name}\` — ${b.call.resultSummary}`;
    }
    case 'gate': {
      const c = b.card;
      const lines = [`> **${c.title}** — _${c.status}_`, `>`, `> ${c.evidence.replace(/\n/g, '\n> ')}`];
      if (c.acceptanceCriteria?.length) {
        lines.push('>', '> Acceptance criteria:');
        for (const a of c.acceptanceCriteria) lines.push(`> - ${a}`);
      }
      if (c.findings?.length) {
        lines.push('>', '> Findings:');
        for (const f of c.findings) lines.push(`> - ${f}`);
      }
      return lines.join('\n');
    }
    case 'changes': {
      const s = b.summary;
      return `> 📦 **Review Changes** — ${s.filesChanged} file(s), +${s.additions} −${s.deletions}`;
    }
    case 'commit': {
      const c = b.commit;
      return `> ✅ **Commit \`${c.sha}\`** — ${c.message} (${c.filesChanged} file(s))`;
    }
    case 'error':
      return `> ⚠️ **Error** — ${b.message}`;
    default:
      return '';
  }
}

/** Stable pretty JSON with recursively sorted object keys. */
export function toJSON(conv: Conversation): string {
  return JSON.stringify(sortKeys(conv), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = sortKeys(src[k]);
    return out;
  }
  return value;
}

export function toSummary(conv: Conversation): ConversationSummary {
  return {
    id: conv.id,
    title: conv.title,
    updatedAt: conv.updatedAt,
    messageCount: activePath(conv).length,
  };
}
