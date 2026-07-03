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
    //
    // We mint a STABLE synthetic stream id per index (`tc_${idx}`) and use it for
    // every event we emit for that index. The provider's real id/name may arrive
    // in any chunk (sometimes after args), so relying on them for the emitted id
    // would split a single tool call across mismatched ids. The loop only needs
    // the emitted id to be internally consistent between the assistant tool_call
    // record and its matching result — the synthetic id guarantees that.
    //
    // `tool_call_start` is deferred until the NAME is known: any args deltas that
    // arrive first are buffered and flushed right after start fires.
    const toolCalls = new Map<
      number,
      { streamId: string; name: string; started: boolean; gotArgs: boolean; bufferedArgs: string[] }
    >();
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
                entry = {
                  streamId: `tc_${idx}`,
                  name: tc.function?.name ?? '',
                  started: false,
                  gotArgs: false,
                  bufferedArgs: [],
                };
                toolCalls.set(idx, entry);
              } else if (tc.function?.name) {
                // Name can arrive in a later chunk than the first args/id.
                entry.name = tc.function.name;
              }

              // Once the name is known, fire start and flush any buffered args.
              if (!entry.started && entry.name) {
                entry.started = true;
                yield { type: 'tool_call_start', id: entry.streamId, name: entry.name };
                for (const buffered of entry.bufferedArgs) {
                  yield { type: 'tool_call_args', id: entry.streamId, delta: buffered };
                }
                entry.bufferedArgs = [];
              }

              const argsDelta = tc.function?.arguments;
              if (typeof argsDelta === 'string' && argsDelta.length > 0) {
                entry.gotArgs = true;
                if (entry.started) {
                  yield { type: 'tool_call_args', id: entry.streamId, delta: argsDelta };
                } else {
                  // Name not seen yet — buffer until start fires.
                  entry.bufferedArgs.push(argsDelta);
                }
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

    // Close any open tool calls. For an index that received args but never a
    // name, still emit start + buffered args + end so records stay consistent.
    for (const entry of toolCalls.values()) {
      if (!entry.started && entry.gotArgs) {
        entry.started = true;
        yield { type: 'tool_call_start', id: entry.streamId, name: entry.name };
        for (const buffered of entry.bufferedArgs) {
          yield { type: 'tool_call_args', id: entry.streamId, delta: buffered };
        }
        entry.bufferedArgs = [];
      }
      if (entry.started) yield { type: 'tool_call_end', id: entry.streamId };
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
  // OpenAI requires content to be present. `null` is only valid when tool_calls
  // are present; a turn with neither text nor tool_calls (e.g. thinking-only)
  // must send an empty string, or OpenAI rejects the message.
  if (text.length > 0) {
    msg.content = text;
  } else {
    msg.content = toolCalls.length > 0 ? null : '';
  }
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
