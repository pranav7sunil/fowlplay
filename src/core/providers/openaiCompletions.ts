/**
 * OpenAI Chat Completions adapter.
 *
 * Speaks the `/chat/completions` streaming API — the lingua franca of local
 * inference servers (Ollama, LM Studio, llama.cpp, mlx-lm) and many hosted
 * providers (Google's compat endpoint, Mistral, DeepSeek, OpenRouter, …).
 */

import type { StreamEvent, TokenUsage, ToolSpec } from '../../shared/types';
import type {
  ChatRequest,
  ProviderAdapter,
  WireMessage,
  WireAssistantPart,
} from './adapter';
import {
  CancelledError,
  fetchWithRetry,
  isAbortError,
  readErrorSnippet,
  readSse,
} from './adapter';

// --- OpenAI wire shapes (only the fields we read) --------------------------

interface OpenAiDeltaToolCall {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChoiceDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAiDeltaToolCall[];
}

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: OpenAiChoiceDelta;
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  } | null;
}

export class OpenAiCompletionsAdapter implements ProviderAdapter {
  async *chat(request: ChatRequest): AsyncIterable<StreamEvent> {
    const url = joinUrl(request.baseUrl, 'chat/completions');
    const body = buildRequestBody(request);

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (request.apiKey) headers['authorization'] = `Bearer ${request.apiKey}`;

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

    // Tool-call assembly state, keyed by the OpenAI `index`.
    const toolCalls = new Map<number, { id: string; name: string; started: boolean }>();
    let usage: TokenUsage | undefined;
    let stopReason: 'end' | 'tool_use' = 'end';
    let sawToolCalls = false;

    try {
      for await (const evt of readSse(response, request.signal)) {
        const data = evt.data.trim();
        if (data === '' ) continue;
        if (data === '[DONE]') break;

        let chunk: OpenAiStreamChunk;
        try {
          chunk = JSON.parse(data) as OpenAiStreamChunk;
        } catch {
          continue; // ignore keep-alives / malformed lines
        }

        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          };
        }

        const choice = chunk.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (delta) {
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            yield { type: 'text', delta: delta.content };
          }
          if (
            typeof delta.reasoning_content === 'string' &&
            delta.reasoning_content.length > 0
          ) {
            yield { type: 'thinking', delta: delta.reasoning_content };
          }
          if (delta.tool_calls) {
            sawToolCalls = true;
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              let entry = toolCalls.get(idx);
              if (!entry) {
                entry = { id: tc.id ?? `call_${idx}`, name: tc.function?.name ?? '', started: false };
                toolCalls.set(idx, entry);
              }
              // Late-arriving id/name can appear across chunks.
              if (tc.id) entry.id = tc.id;
              if (tc.function?.name) entry.name = tc.function.name;

              if (!entry.started && entry.name) {
                entry.started = true;
                yield { type: 'tool_call_start', id: entry.id, name: entry.name };
              }
              const argsDelta = tc.function?.arguments;
              if (typeof argsDelta === 'string' && argsDelta.length > 0) {
                // If start hasn't fired yet (no name seen), fire it now so the
                // loop can associate args with an id.
                if (!entry.started) {
                  entry.started = true;
                  yield { type: 'tool_call_start', id: entry.id, name: entry.name };
                }
                yield { type: 'tool_call_args', id: entry.id, delta: argsDelta };
              }
            }
          }
        }

        if (choice.finish_reason) {
          stopReason = choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end';
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

    // Close any open tool calls.
    for (const entry of toolCalls.values()) {
      if (entry.started) yield { type: 'tool_call_end', id: entry.id };
    }

    if (usage) yield { type: 'usage', usage };

    // Some servers omit finish_reason but do emit tool_calls; infer tool_use.
    if (sawToolCalls && stopReason !== 'tool_use') stopReason = 'tool_use';
    yield { type: 'done', stopReason };
  }
}

// --- Request construction ---------------------------------------------------

interface OpenAiRequestBody {
  model: string;
  messages: unknown[];
  stream: true;
  stream_options: { include_usage: true };
  max_tokens?: number;
  tools?: unknown[];
}

function buildRequestBody(request: ChatRequest): OpenAiRequestBody {
  const messages: unknown[] = [];
  if (request.system) messages.push({ role: 'system', content: request.system });
  for (const m of request.messages) {
    messages.push(...toOpenAiMessages(m));
  }

  const body: OpenAiRequestBody = {
    model: request.modelId,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (typeof request.maxTokens === 'number') body.max_tokens = request.maxTokens;
  if (request.tools.length > 0) body.tools = request.tools.map(toOpenAiTool);
  return body;
}

function toOpenAiTool(tool: ToolSpec): unknown {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/** A WireMessage may expand into multiple OpenAI messages (e.g. batch tool results). */
function toOpenAiMessages(m: WireMessage): unknown[] {
  if (m.role === 'user') {
    // Plain text collapses to a string; otherwise use the parts array.
    const onlyText =
      m.content.length > 0 && m.content.every((p) => p.type === 'text');
    if (onlyText) {
      return [
        {
          role: 'user',
          content: m.content.map((p) => (p.type === 'text' ? p.text : '')).join(''),
        },
      ];
    }
    const parts = m.content.map((p) =>
      p.type === 'text'
        ? { type: 'text', text: p.text }
        : {
            type: 'image_url',
            image_url: { url: `data:${p.image.mimeType};base64,${p.image.data}` },
          },
    );
    return [{ role: 'user', content: parts }];
  }

  if (m.role === 'assistant') {
    return [buildAssistantMessage(m.content)];
  }

  // Tool results → one role:'tool' message each.
  return m.results.map((r) => ({
    role: 'tool',
    tool_call_id: r.toolCallId,
    content: r.content,
  }));
}

function buildAssistantMessage(parts: WireAssistantPart[]): unknown {
  const text = parts
    .filter((p): p is Extract<WireAssistantPart, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
  const toolCalls = parts
    .filter((p): p is Extract<WireAssistantPart, { type: 'tool_call' }> => p.type === 'tool_call')
    .map((p) => ({
      id: p.id,
      type: 'function',
      function: { name: p.name, arguments: stringifyArgs(p.args) },
    }));

  const msg: Record<string, unknown> = { role: 'assistant' };
  // OpenAI requires content to be present (may be null when only tool calls).
  msg.content = text.length > 0 ? text : null;
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  return msg;
}

function stringifyArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args ?? {});
  } catch {
    return '{}';
  }
}

// --- utils ------------------------------------------------------------------

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path}`;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
