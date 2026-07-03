import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAdapter } from '../src/core/providers/adapter';
import type { ChatRequest } from '../src/core/providers/adapter';
import { PRESETS, fetchModels } from '../src/core/providers/registry';
import type { StreamEvent } from '../src/shared/types';

// --- helpers ---------------------------------------------------------------

/** Build a mock streaming Response from SSE text chunks. */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collect(iter: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

const baseReq: Omit<ChatRequest, 'baseUrl'> = {
  apiKey: 'sk-test',
  modelId: 'test-model',
  system: 'be helpful',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- OpenAI Chat Completions ----------------------------------------------

describe('OpenAiCompletionsAdapter', () => {
  it('parses text deltas, assembles tool calls, and reads usage', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"open_files","arguments":"{\\"paths\\""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":[\\"a.ts\\"]}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":2}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchMock = vi.fn(async () => sseResponse(chunks));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createAdapter('openai-completions');
    const events = await collect(adapter.chat({ ...baseReq, baseUrl: 'https://api.example.com/v1' }));

    const texts = events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta);
    expect(texts.join('')).toBe('Hello world');

    const thinking = events.find((e) => e.type === 'thinking');
    expect(thinking).toEqual({ type: 'thinking', delta: 'hmm' });

    const start = events.find((e) => e.type === 'tool_call_start');
    expect(start).toEqual({ type: 'tool_call_start', id: 'call_1', name: 'open_files' });

    const argsJoined = events
      .filter((e) => e.type === 'tool_call_args')
      .map((e) => (e as { delta: string }).delta)
      .join('');
    expect(argsJoined).toBe('{"paths":["a.ts"]}');

    expect(events.some((e) => e.type === 'tool_call_end')).toBe(true);

    const usage = events.find((e) => e.type === 'usage');
    expect(usage).toEqual({
      type: 'usage',
      usage: { inputTokens: 10, outputTokens: 5, cachedTokens: 2 },
    });

    const done = events.at(-1);
    expect(done).toEqual({ type: 'done', stopReason: 'tool_use' });

    // POSTs to {baseUrl}/chat/completions with stream + include_usage.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
  });

  it('emits an error event with a body snippet on non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    );
    const adapter = createAdapter('openai-completions');
    const events = await collect(adapter.chat({ ...baseReq, baseUrl: 'http://x/v1' }));
    const err = events.find((e) => e.type === 'error') as { message: string } | undefined;
    expect(err?.message).toContain('HTTP 500');
    expect(err?.message).toContain('nope');
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'error' });
  });

  it('cancels via AbortSignal', async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        controller.abort();
        return sseResponse(['data: {"choices":[{"delta":{"content":"x"}}]}\n\n']);
      }),
    );
    const adapter = createAdapter('openai-completions');
    const events = await collect(
      adapter.chat({ ...baseReq, baseUrl: 'http://x/v1', signal: controller.signal }),
    );
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'cancelled' });
  });
});

// --- Anthropic Messages ----------------------------------------------------

describe('AnthropicMessagesAdapter', () => {
  it('parses text, tool_use blocks, and usage', async () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":8,"cache_read_input_tokens":3}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"grep"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"pattern\\""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":":\\"foo\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const fetchMock = vi.fn(async () => sseResponse(chunks));
    vi.stubGlobal('fetch', fetchMock);

    const adapter = createAdapter('anthropic');
    const events = await collect(adapter.chat({ ...baseReq, baseUrl: 'https://api.anthropic.com' }));

    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe(
      'Hi',
    );
    expect(events.find((e) => e.type === 'tool_call_start')).toEqual({
      type: 'tool_call_start',
      id: 'toolu_1',
      name: 'grep',
    });
    expect(
      events
        .filter((e) => e.type === 'tool_call_args')
        .map((e) => (e as { delta: string }).delta)
        .join(''),
    ).toBe('{"pattern":"foo"}');
    expect(events.find((e) => e.type === 'tool_call_end')).toEqual({
      type: 'tool_call_end',
      id: 'toolu_1',
    });
    expect(events.find((e) => e.type === 'usage')).toEqual({
      type: 'usage',
      usage: { inputTokens: 8, outputTokens: 12, cachedTokens: 3 },
    });
    expect(events.at(-1)).toEqual({ type: 'done', stopReason: 'tool_use' });

    // URL + headers.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('does not double the /v1 when baseUrl already ends in it', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createAdapter('anthropic');
    await collect(adapter.chat({ ...baseReq, baseUrl: 'https://proxy.internal/v1' }));
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://proxy.internal/v1/messages');
  });
});

// --- Registry --------------------------------------------------------------

describe('registry', () => {
  it('exposes presets for all required providers', () => {
    const names = PRESETS.map((p) => p.name);
    for (const required of [
      'OpenAI',
      'Anthropic',
      'Google',
      'Mistral',
      'DeepSeek',
      'OpenRouter',
      'MiniMax',
      'Z.ai',
      'Moonshot',
      'Ollama',
      'LM Studio',
      'llama.cpp',
      'mlx-lm',
    ]) {
      expect(names).toContain(required);
    }
    const ollama = PRESETS.find((p) => p.name === 'Ollama');
    expect(ollama).toMatchObject({
      kind: 'local',
      requiresApiKey: false,
      sdkType: 'openai-completions',
      baseUrl: 'http://localhost:11434/v1',
    });
    const anthropic = PRESETS.find((p) => p.name === 'Anthropic');
    expect(anthropic?.sdkType).toBe('anthropic');
  });

  it('fetchModels returns sorted ids for openai-completions', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'zeta' }, { id: 'alpha' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const models = await fetchModels(
      { sdkType: 'openai-completions', baseUrl: 'http://localhost:11434/v1' },
      undefined,
    );
    expect(models).toEqual([{ id: 'alpha' }, { id: 'zeta' }]);
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe('http://localhost:11434/v1/models');
  });

  it('fetchModels uses /v1/models + x-api-key for anthropic (no doubled /v1)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'claude-x' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await fetchModels({ sdkType: 'anthropic', baseUrl: 'https://api.anthropic.com' }, 'sk-a');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/models');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-a');
  });

  it('fetchModels throws a useful error on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 401 })));
    await expect(
      fetchModels({ sdkType: 'openai-completions', baseUrl: 'http://x/v1' }),
    ).rejects.toThrow(/HTTP 401/);
  });
});
