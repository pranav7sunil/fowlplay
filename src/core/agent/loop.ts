/**
 * The agentic loop.
 *
 * Streams an assistant turn, and if it ends wanting tools, dispatches every tool
 * call, appends the results, and continues — until the model finishes, the user
 * cancels, an error occurs, or the round budget is exhausted.
 *
 * The loop is provider-agnostic: it drives a `ProviderAdapter` and a `ToolHost`,
 * both of which are injected. It returns the rendered content blocks (for the
 * chat UI), cumulative token usage, and the updated wire history (for the next
 * turn / persistence).
 */

import type { ContentBlock, StreamEvent, TokenUsage, ToolSpec } from '../../shared/types';
import type {
  ProviderAdapter,
  WireAssistantPart,
  WireMessage,
  WireToolResult,
} from '../providers/adapter';
import { estimateTokens } from './contextBudget';
import { dispatchToolCall, type ToolHost } from './tools';

const DEFAULT_MAX_ROUNDS = 24;
const SUMMARY_LIMIT = 400;

/**
 * Generous fixed output cap (tokens) applied when the model's context window is
 * unknown, so a single response can never grow unbounded — LM Studio and other
 * local servers default `max_tokens` to unlimited, which let a runaway thinking
 * loop exhaust the whole window. No reasonable single role response exceeds this.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/**
 * Client-side runaway failsafe: if a server ignores `max_tokens` and streams past
 * this multiple of the effective cap, the call is aborted locally and surfaced as
 * a {@link RunawayGenerationError} rather than being left to exhaust the window.
 */
const RUNAWAY_CAP_MULTIPLE = 1.5;

/** Thrown by {@link runAgentLoop} when a single call's output blows past the cap. */
export class RunawayGenerationError extends Error {
  constructor(
    public readonly estimatedTokens: number,
    public readonly capTokens: number,
  ) {
    super(
      `Runaway generation halted after ~${fmtK(estimatedTokens)} tokens (cap ~${fmtK(capTokens)}). ` +
        `Retry the step — consider a larger context window or a different model.`,
    );
    this.name = 'RunawayGenerationError';
  }
}

function fmtK(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export interface LoopOptions {
  adapter: ProviderAdapter;
  // Request parts:
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  maxTokens?: number;
  system: string;
  history: WireMessage[];
  tools: ToolSpec[];
  // Environment + observation:
  toolHost: ToolHost;
  onEvent: (event: StreamEvent) => void;
  maxRounds?: number;
  signal?: AbortSignal;
}

export interface LoopResult {
  blocks: ContentBlock[];
  usage: TokenUsage;
  wireHistory: WireMessage[];
}

interface PendingCall {
  id: string;
  name: string;
  argsStr: string;
}

export async function runAgentLoop(opts: LoopOptions): Promise<LoopResult> {
  const maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const messages: WireMessage[] = [...opts.history];
  const blocks: ContentBlock[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

  for (let round = 0; round < maxRounds; round += 1) {
    if (opts.signal?.aborted) break;

    let text = '';
    let thinking = '';
    const calls = new Map<string, PendingCall>();
    const callOrder: string[] = [];
    let stopReason: 'end' | 'tool_use' | 'cancelled' | 'error' = 'end';

    // Effective output cap for the runaway failsafe: the supplied cap, or the
    // fixed default when the caller passed none (unknown context window).
    const effectiveCap = opts.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const runawayLimit = Math.floor(effectiveCap * RUNAWAY_CAP_MULTIPLE);

    // A per-call AbortController chained to the outer signal, so the runaway
    // failsafe can abort THIS call locally without touching the turn's signal
    // (which the caller may still need for cancellation semantics).
    const callController = new AbortController();
    const onOuterAbort = () => callController.abort();
    if (opts.signal) {
      if (opts.signal.aborted) callController.abort();
      else opts.signal.addEventListener('abort', onOuterAbort);
    }
    let runawayTokens = 0;

    const stream = opts.adapter.chat({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      modelId: opts.modelId,
      maxTokens: opts.maxTokens,
      system: opts.system,
      messages,
      tools: opts.tools,
      signal: callController.signal,
    });

    try {
      for await (const event of stream) {
        opts.onEvent(event);
        switch (event.type) {
          case 'text':
            text += event.delta;
            break;
          case 'thinking':
            thinking += event.delta;
            break;
          case 'tool_call_start': {
            let call = calls.get(event.id);
            if (!call) {
              call = { id: event.id, name: event.name, argsStr: '' };
              calls.set(event.id, call);
              callOrder.push(event.id);
            } else if (event.name) {
              call.name = event.name;
            }
            break;
          }
          case 'tool_call_args': {
            const call = calls.get(event.id);
            if (call) call.argsStr += event.delta;
            break;
          }
          case 'tool_call_end':
            break;
          case 'usage':
            usage.inputTokens += event.usage.inputTokens;
            usage.outputTokens += event.usage.outputTokens;
            usage.cachedTokens += event.usage.cachedTokens;
            break;
          case 'done':
            stopReason = event.stopReason;
            break;
          case 'error':
            // The error text is forwarded via onEvent; the following `done`
            // event will carry stopReason 'error'.
            break;
          default:
            break;
        }

        // Runaway failsafe: the server ignored max_tokens and the streamed
        // text+thinking has blown past 1.5× the cap. Abort THIS call and throw a
        // distinct error so the caller can fail the step with actionable evidence.
        if (event.type === 'text' || event.type === 'thinking') {
          const est = estimateTokens(text) + estimateTokens(thinking);
          if (est > runawayLimit) {
            runawayTokens = est;
            callController.abort();
            break;
          }
        }
      }
    } finally {
      if (opts.signal) opts.signal.removeEventListener('abort', onOuterAbort);
    }

    if (runawayTokens > 0) {
      throw new RunawayGenerationError(runawayTokens, effectiveCap);
    }

    // Render assistant text/thinking blocks (in reading order).
    if (thinking.length > 0) blocks.push({ type: 'thinking', text: thinking });
    if (text.length > 0) blocks.push({ type: 'text', text });

    const parsedCalls = callOrder.map((id) => {
      const c = calls.get(id) as PendingCall;
      return { id: c.id, name: c.name, args: parseArgs(c.argsStr) };
    });

    // Append the assistant turn to the wire history.
    //
    // tool_call parts are only persisted when we are ALSO going to append their
    // results this turn (the tool_use branch below). On cancelled/error/end,
    // emitting the tool_call parts without matching tool results would leave the
    // history with unanswered tool calls — the next provider request 400s.
    const willRunTools = stopReason === 'tool_use' && parsedCalls.length > 0;
    const assistantParts: WireAssistantPart[] = [];
    if (thinking.length > 0) assistantParts.push({ type: 'thinking', text: thinking });
    if (text.length > 0) assistantParts.push({ type: 'text', text });
    if (willRunTools) {
      for (const pc of parsedCalls) {
        assistantParts.push({ type: 'tool_call', id: pc.id, name: pc.name, args: pc.args });
      }
    }
    if (assistantParts.length > 0) {
      messages.push({ role: 'assistant', content: assistantParts });
    }

    if (willRunTools) {
      const results: WireToolResult[] = [];
      for (const pc of parsedCalls) {
        const result = await dispatchToolCall(opts.toolHost, pc.name, pc.args);
        blocks.push({
          type: 'tool_call',
          call: {
            id: pc.id,
            name: pc.name,
            args: pc.args,
            resultSummary: trimSummary(result.content),
            ok: result.ok,
          },
        });
        const wr: WireToolResult = {
          toolCallId: pc.id,
          name: pc.name,
          content: result.content,
          isError: !result.ok,
        };
        if (result.gcClass !== undefined) wr.gcClass = result.gcClass;
        const paths = extractPaths(pc.name, pc.args);
        if (paths.length > 0) wr.paths = paths;
        results.push(wr);
      }
      messages.push({ role: 'tool', results });
      continue; // next round
    }

    // end / cancelled / error / no tool calls → stop.
    break;
  }

  return { blocks, usage, wireHistory: messages };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(argsStr: string): unknown {
  const trimmed = argsStr.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

function trimSummary(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= SUMMARY_LIMIT) return oneLine;
  return oneLine.slice(0, SUMMARY_LIMIT - 1) + '…';
}

/** Paths a tool result covers, for context-GC dedup. */
function extractPaths(name: string, args: unknown): string[] {
  if (typeof args !== 'object' || args === null) return [];
  if (name === 'open_files') {
    const paths = (args as { paths?: unknown }).paths;
    if (Array.isArray(paths)) return paths.filter((p): p is string => typeof p === 'string');
  }
  return [];
}
