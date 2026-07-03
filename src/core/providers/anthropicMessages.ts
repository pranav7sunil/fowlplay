/**
 * Anthropic Messages API adapter.
 *
 * POSTs to `{baseUrl}/v1/messages` (avoiding a doubled `/v1` when baseUrl already
 * ends in it), streams SSE, and normalizes content_block / message_delta events
 * into FowlPlay's StreamEvent shape.
 */

import type { StreamEvent, TokenUsage, ToolSpec } from '../../shared/types';
import type {
  ChatRequest,
  ProviderAdapter,
  WireMessage,
  WireAssistantPart,
  WireUserPart,
} from './adapter';
import {
  CancelledError,
  fetchWithRetry,
  isAbortError,
  readErrorSnippet,
  readSse,
} from './adapter';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 4096;

// --- Anthropic wire shapes (only fields we read) ---------------------------

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AnthropicStreamEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    stop_reason?: string | null;
  };
  message?: { usage?: AnthropicUsage };
  usage?: AnthropicUsage;
}

export class AnthropicMessagesAdapter implements ProviderAdapter {
  async *chat(request: ChatRequest): AsyncIterable<StreamEvent> {
    const url = messagesUrl(request.baseUrl);
    const body = buildRequestBody(request);

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    };
    if (request.apiKey) headers['x-api-key'] = request.apiKey;

    let response: Response;
    try {
      response = await fetchWithRetry(
        url,
        { method: 'POST', headers, body: JSON.stringify(body) },
        { signal: request.signal },
      );
    } catch (err) {
      if (isAbortError(err)) {
        yield { type: 'done', stopReason: 'cancelled' };
        return;
      }
      yield { type: 'error', message: `request failed: ${errMessage(err)}` };
      yield { type: 'done', stopReason: 'error' };
      return;
    }

    if (!response.ok) {
      const snippet = await readErrorSnippet(response);
      yield { type: 'error', message: `HTTP ${response.status}: ${snippet}` };
      yield { type: 'done', stopReason: 'error' };
      return;
    }

    // Block-index → tool metadata (for tool_use blocks) so input_json_delta and
    // content_block_stop can be routed to the right tool call id.
    const blocks = new Map<number, { kind: 'tool_use' | 'text' | 'thinking'; id?: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let stopReason: 'end' | 'tool_use' = 'end';

    try {
      for await (const evt of readSse(response, request.signal)) {
        const data = evt.data.trim();
        if (data === '') continue;

        let msg: AnthropicStreamEvent;
        try {
          msg = JSON.parse(data) as AnthropicStreamEvent;
        } catch {
          continue;
        }

        switch (msg.type) {
          case 'message_start': {
            const u = msg.message?.usage;
            if (u) {
              inputTokens = u.input_tokens ?? 0;
              cachedTokens = u.cache_read_input_tokens ?? 0;
            }
            break;
          }
          case 'content_block_start': {
            const idx = msg.index ?? 0;
            const block = msg.content_block;
            if (block?.type === 'tool_use') {
              blocks.set(idx, { kind: 'tool_use', id: block.id });
              yield {
                type: 'tool_call_start',
                id: block.id ?? `tool_${idx}`,
                name: block.name ?? '',
              };
            } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
              blocks.set(idx, { kind: 'thinking' });
            } else {
              blocks.set(idx, { kind: 'text' });
            }
            break;
          }
          case 'content_block_delta': {
            const idx = msg.index ?? 0;
            const d = msg.delta;
            if (!d) break;
            if (d.type === 'text_delta' && d.text) {
              yield { type: 'text', delta: d.text };
            } else if (d.type === 'thinking_delta' && d.thinking) {
              yield { type: 'thinking', delta: d.thinking };
            } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
              const entry = blocks.get(idx);
              if (entry?.kind === 'tool_use' && d.partial_json.length > 0) {
                yield {
                  type: 'tool_call_args',
                  id: entry.id ?? `tool_${idx}`,
                  delta: d.partial_json,
                };
              }
            }
            break;
          }
          case 'content_block_stop': {
            const idx = msg.index ?? 0;
            const entry = blocks.get(idx);
            if (entry?.kind === 'tool_use') {
              yield { type: 'tool_call_end', id: entry.id ?? `tool_${idx}` };
            }
            break;
          }
          case 'message_delta': {
            const sr = msg.delta?.stop_reason;
            if (sr) stopReason = sr === 'tool_use' ? 'tool_use' : 'end';
            if (msg.usage?.output_tokens != null) outputTokens = msg.usage.output_tokens;
            break;
          }
          case 'message_stop':
            break;
          default:
            break; // ping, etc.
        }
      }
    } catch (err) {
      if (isAbortError(err) || err instanceof CancelledError) {
        yield { type: 'done', stopReason: 'cancelled' };
        return;
      }
      yield { type: 'error', message: `stream error: ${errMessage(err)}` };
      yield { type: 'done', stopReason: 'error' };
      return;
    }

    const usage: TokenUsage = { inputTokens, outputTokens, cachedTokens };
    yield { type: 'usage', usage };
    yield { type: 'done', stopReason };
  }
}

// --- Request construction ---------------------------------------------------

interface AnthropicRequestBody {
  model: string;
  system?: string;
  messages: unknown[];
  max_tokens: number;
  stream: true;
  tools?: unknown[];
}

function buildRequestBody(request: ChatRequest): AnthropicRequestBody {
  const body: AnthropicRequestBody = {
    model: request.modelId,
    messages: request.messages.map(toAnthropicMessage),
    max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: true,
  };
  if (request.system) body.system = request.system;
  if (request.tools.length > 0) body.tools = request.tools.map(toAnthropicTool);
  return body;
}

function toAnthropicTool(tool: ToolSpec): unknown {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

function toAnthropicMessage(m: WireMessage): unknown {
  if (m.role === 'user') {
    return { role: 'user', content: m.content.map(userPartToContent) };
  }
  if (m.role === 'assistant') {
    return { role: 'assistant', content: assistantParts(m.content) };
  }
  // Tool results are user-role tool_result blocks in the Anthropic API.
  return {
    role: 'user',
    content: m.results.map((r) => ({
      type: 'tool_result',
      tool_use_id: r.toolCallId,
      content: r.content,
      ...(r.isError ? { is_error: true } : {}),
    })),
  };
}

function userPartToContent(p: WireUserPart): unknown {
  if (p.type === 'text') return { type: 'text', text: p.text };
  return {
    type: 'image',
    source: { type: 'base64', media_type: p.image.mimeType, data: p.image.data },
  };
}

function assistantParts(parts: WireAssistantPart[]): unknown[] {
  const out: unknown[] = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text.length > 0) out.push({ type: 'text', text: p.text });
    } else if (p.type === 'tool_call') {
      out.push({ type: 'tool_use', id: p.id, name: p.name, input: coerceInput(p.args) });
    }
    // `thinking` parts are intentionally dropped from replayed input: without the
    // original signature the API rejects them, and they aren't needed to continue.
  }
  if (out.length === 0) out.push({ type: 'text', text: '' });
  return out;
}

function coerceInput(args: unknown): unknown {
  if (typeof args === 'string') {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args ?? {};
}

// --- utils ------------------------------------------------------------------

/** Append `/v1/messages`, but don't double the `/v1` if baseUrl already ends in it. */
function messagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/v1$/.test(trimmed)) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
