/**
 * ProviderAdapter — the provider-neutral streaming interface.
 *
 * Every concrete adapter (OpenAI Chat Completions, Anthropic Messages) converts
 * FowlPlay's neutral `WireMessage` list into the provider's wire format, performs
 * a streaming HTTP request with `fetch`, and normalizes the provider's stream into
 * the single `StreamEvent` shape defined in shared/types.
 *
 * This module also carries small helpers shared by both adapters (SSE parsing,
 * retry/backoff, cancellation) so the two implementations stay DRY.
 */

import type { SdkType, StreamEvent, ToolSpec } from '../../shared/types';

// ---------------------------------------------------------------------------
// Provider-neutral message model
// ---------------------------------------------------------------------------

/** An inline image attachment (base64-encoded). */
export interface WireImage {
  mimeType: string; // e.g. "image/png"
  data: string; // base64, no data: prefix
}

/** Content parts allowed in a user turn. */
export type WireUserPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: WireImage };

/** Content parts allowed in an assistant turn. */
export type WireAssistantPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown };

/** A single tool result, returned to the model after a tool call. */
export interface WireToolResult {
  /** Matches the `id` of the assistant tool_call it answers. */
  toolCallId: string;
  /** Tool name (used by OpenAI which keys nothing on it, kept for clarity/GC). */
  name?: string;
  /** Text payload shown to the model. */
  content: string;
  /** Marks the result as an error to the provider. */
  isError?: boolean;
  /** Lets context GC know whether this payload is safe to stub later. */
  gcClass?: 'file-content' | 'search-result' | 'other';
  /** File paths this result covers (for dedup during context GC). */
  paths?: string[];
}

/**
 * Provider-neutral conversation message. Tool results live in their own role so
 * each adapter can map them to the provider's convention (OpenAI: role 'tool';
 * Anthropic: user-role tool_result blocks).
 */
export type WireMessage =
  | { role: 'user'; content: WireUserPart[] }
  | { role: 'assistant'; content: WireAssistantPart[] }
  | { role: 'tool'; results: WireToolResult[] };

// ---------------------------------------------------------------------------
// Request / adapter contract
// ---------------------------------------------------------------------------

export interface ChatRequest {
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  system: string;
  messages: WireMessage[];
  tools: ToolSpec[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  /** Stream a single assistant turn as normalized events. */
  chat(request: ChatRequest): AsyncIterable<StreamEvent>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// Imported lazily-safe: these modules only import types from here, no cycle at runtime.
import { OpenAiCompletionsAdapter } from './openaiCompletions';
import { AnthropicMessagesAdapter } from './anthropicMessages';

export function createAdapter(sdkType: SdkType): ProviderAdapter {
  switch (sdkType) {
    case 'openai-completions':
      return new OpenAiCompletionsAdapter();
    case 'anthropic':
      return new AnthropicMessagesAdapter();
    default: {
      // Exhaustiveness guard — if SdkType grows, TS flags this.
      const _never: never = sdkType;
      throw new Error(`Unknown sdkType: ${String(_never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Shared HTTP / SSE helpers
// ---------------------------------------------------------------------------

/** Raised when the AbortSignal fires; adapters translate this into a cancelled done. */
export class CancelledError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'CancelledError';
  }
}

/** Sleep that rejects promptly if the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * POST with automatic retry on HTTP 429 (up to `maxRetries` retries) using
 * exponential backoff. Non-429 responses (including other non-2xx) are returned
 * to the caller as-is so it can surface an error event with the body snippet.
 * Aborting the signal throws CancelledError.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { signal?: AbortSignal; maxRetries?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelay = opts.baseDelayMs ?? 500;

  let attempt = 0;
  // First try + up to `maxRetries` retries.
  for (;;) {
    if (opts.signal?.aborted) throw new CancelledError();
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: opts.signal });
    } catch (err) {
      if (isAbortError(err)) throw new CancelledError();
      throw err;
    }
    if (res.status !== 429 || attempt >= maxRetries) {
      return res;
    }
    // Honor Retry-After when present, else exponential backoff with jitter.
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
    const delay = retryAfter ?? baseDelay * 2 ** attempt + Math.floor(Math.random() * 100);
    // Drain the body so the connection can be reused.
    try {
      await res.arrayBuffer();
    } catch {
      /* ignore */
    }
    await sleep(delay, opts.signal);
    attempt += 1;
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof CancelledError ||
    (typeof err === 'object' && err !== null && (err as { name?: string }).name === 'AbortError')
  );
}

/** One parsed Server-Sent Event: an optional `event:` label and the joined data payload. */
export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Parse a fetch Response body (a web ReadableStream) as Server-Sent Events.
 * Events are separated by blank lines. `data:` lines are concatenated with
 * newlines; `event:` sets the event label. Works for both OpenAI (data-only)
 * and Anthropic (labeled) SSE streams.
 */
export async function* readSse(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const body = response.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      if (signal?.aborted) throw new CancelledError();
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        if (isAbortError(err)) throw new CancelledError();
        throw err;
      }
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });

      // Dispatch every complete event (delimited by a blank line). Handle both
      // \n\n and \r\n\r\n line endings.
      let sep: number;
      while ((sep = findEventBoundary(buffer)) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(boundaryEnd(buffer, sep));
        const parsed = parseSseBlock(raw);
        if (parsed) yield parsed;
      }
    }
    // Flush a trailing event with no final blank line.
    const tail = parseSseBlock(buffer);
    if (tail) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
}

function findEventBoundary(buffer: string): number {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function boundaryEnd(buffer: string, sep: number): number {
  return buffer.startsWith('\r\n\r\n', sep) ? sep + 4 : sep + 2;
}

function parseSseBlock(raw: string): SseEvent | null {
  const lines = raw.split(/\r?\n/);
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line === '' || line.startsWith(':')) continue; // blank or comment
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      // SSE spec: strip one leading space after the colon.
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0 && event === undefined) return null;
  return { event, data: dataLines.join('\n') };
}

/** Read a bounded snippet of a non-2xx response body for error events. */
export async function readErrorSnippet(response: Response, max = 500): Promise<string> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    /* ignore */
  }
  text = text.trim();
  if (text.length > max) text = text.slice(0, max) + '…';
  return text || `HTTP ${response.status}`;
}
