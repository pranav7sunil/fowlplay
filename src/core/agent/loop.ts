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
import { dispatchToolCall, type ToolHost } from './tools';

const DEFAULT_MAX_ROUNDS = 24;
const SUMMARY_LIMIT = 400;

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

    const stream = opts.adapter.chat({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      modelId: opts.modelId,
      maxTokens: opts.maxTokens,
      system: opts.system,
      messages,
      tools: opts.tools,
      signal: opts.signal,
    });

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
    }

    // Render assistant text/thinking blocks (in reading order).
    if (thinking.length > 0) blocks.push({ type: 'thinking', text: thinking });
    if (text.length > 0) blocks.push({ type: 'text', text });

    const parsedCalls = callOrder.map((id) => {
      const c = calls.get(id) as PendingCall;
      return { id: c.id, name: c.name, args: parseArgs(c.argsStr) };
    });

    // Append the assistant turn to the wire history.
    const assistantParts: WireAssistantPart[] = [];
    if (thinking.length > 0) assistantParts.push({ type: 'thinking', text: thinking });
    if (text.length > 0) assistantParts.push({ type: 'text', text });
    for (const pc of parsedCalls) {
      assistantParts.push({ type: 'tool_call', id: pc.id, name: pc.name, args: pc.args });
    }
    if (assistantParts.length > 0) {
      messages.push({ role: 'assistant', content: assistantParts });
    }

    if (stopReason === 'tool_use' && parsedCalls.length > 0) {
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
