/**
 * Provider registry — presets for known API-key and local providers, plus a
 * `fetchModels` helper that lists available models for a configured provider.
 */

import type { ProviderConfig } from '../../shared/types';

/** A preset carries everything except the runtime id and the fetched model list. */
export type ProviderPreset = Omit<ProviderConfig, 'id' | 'models'>;

export const PRESETS: ProviderPreset[] = [
  // --- API-key providers ----------------------------------------------------
  {
    name: 'OpenAI',
    kind: 'api-key',
    sdkType: 'openai-completions',
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
  },
  {
    name: 'Anthropic',
    kind: 'api-key',
    sdkType: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    requiresApiKey: true,
  },
  {
    name: 'Google',
    kind: 'api-key',
    sdkType: 'openai-completions',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresApiKey: true,
  },
  {
    name: 'Mistral',
    kind: 'api-key',
    sdkType: 'openai-completions',
    baseUrl: 'https://api.mistral.ai/v1',
    requiresApiKey: true,
  },
  {
    name: 'DeepSeek',
    kind: 'api-key',
    sdkType: 'openai-completions',
    baseUrl: 'https://api.deepseek.com/v1',
    requiresApiKey: true,
  },
  {
    name: 'OpenRouter',
    kind: 'api-key',
    sdkType: 'openai-completions',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
  },
  {
    name: 'MiniMax',
    kind: 'api-key',
    sdkType: 'openai-completions',
    baseUrl: 'https://api.minimax.io/v1',
    requiresApiKey: true,
  },
  {
    name: 'Z.ai',
    kind: 'api-key',
    sdkType: 'openai-completions',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    requiresApiKey: true,
  },
  {
    name: 'Moonshot',
    kind: 'api-key',
    sdkType: 'openai-completions',
    baseUrl: 'https://api.moonshot.ai/v1',
    requiresApiKey: true,
  },

  // --- Local providers ------------------------------------------------------
  {
    name: 'Ollama',
    kind: 'local',
    sdkType: 'openai-completions',
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
  },
  {
    name: 'LM Studio',
    kind: 'local',
    sdkType: 'openai-completions',
    baseUrl: 'http://localhost:1234/v1',
    requiresApiKey: false,
  },
  {
    name: 'llama.cpp',
    kind: 'local',
    sdkType: 'openai-completions',
    baseUrl: 'http://localhost:8080/v1',
    requiresApiKey: false,
  },
  {
    name: 'mlx-lm',
    kind: 'local',
    sdkType: 'openai-completions',
    baseUrl: 'http://localhost:8080/v1',
    requiresApiKey: false,
  },
];

/** A model as surfaced by `fetchModels`: its id plus context window if known. */
export interface FetchedModel {
  id: string;
  contextWindow?: number;
}

/** Just enough of a provider config to fetch its model list. */
export type FetchModelsConfig = Pick<ProviderConfig, 'sdkType' | 'baseUrl'> & {
  /** Provider kind; when 'local' we run best-effort local context-window enrichment. */
  kind?: ProviderConfig['kind'];
};

/** Best-effort local probes get a short deadline so they never stall the list. */
const LOCAL_PROBE_TIMEOUT_MS = 1500;
/** Ollama needs one /api/show call per model; cap it so a big list stays cheap. */
const OLLAMA_SHOW_LIMIT = 16;

/**
 * List available models for a provider.
 * - openai-completions: GET {baseUrl}/models, Bearer auth if a key is given.
 * - anthropic:          GET {baseUrl}/v1/models (no double /v1), x-api-key auth.
 * Returns `{ id, contextWindow? }[]` sorted by id. Throws with a useful message
 * on failure. For local providers (kind==='local' or a localhost baseUrl) it
 * then runs best-effort probes to enrich each model's context window; those
 * probes never break or meaningfully slow the primary list.
 */
export async function fetchModels(
  config: FetchModelsConfig,
  apiKey?: string,
): Promise<FetchedModel[]> {
  const { url, headers } = modelsRequest(config, apiKey);

  let res: Response;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw new Error(
      `Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    let snippet = '';
    try {
      snippet = (await res.text()).trim().slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(
      `Failed to fetch models from ${url} (HTTP ${res.status})${snippet ? `: ${snippet}` : ''}`,
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    throw new Error(
      `Model list from ${url} was not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const models = extractModels(payload);
  if (models.length === 0) {
    throw new Error(`Model list from ${url} contained no models`);
  }
  models.sort((a, b) => a.id.localeCompare(b.id));

  // Local providers rarely advertise context length on /models — enrich from
  // native endpoints. Strictly additive and best-effort: it only fills gaps and
  // any failure (or the ~1.5s deadline) leaves the primary list untouched.
  if (config.kind === 'local' || isLocalHost(config.baseUrl)) {
    try {
      const byId = await enrichLocalContext(config.baseUrl, models.map((m) => m.id));
      for (const m of models) {
        if (m.contextWindow === undefined) {
          const ctx = byId.get(m.id);
          if (typeof ctx === 'number' && ctx > 0) m.contextWindow = ctx;
        }
      }
    } catch {
      /* enrichment is best-effort — never let it break the primary list */
    }
  }

  return models;
}

function modelsRequest(
  config: FetchModelsConfig,
  apiKey?: string,
): { url: string; headers: Record<string, string> } {
  const base = config.baseUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {};

  if (config.sdkType === 'anthropic') {
    const url = /\/v1$/.test(base) ? `${base}/models` : `${base}/v1/models`;
    headers['anthropic-version'] = '2023-06-01';
    if (apiKey) headers['x-api-key'] = apiKey;
    return { url, headers };
  }

  // openai-completions
  const url = `${base}/models`;
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  return { url, headers };
}

/**
 * Both OpenAI and Anthropic return `{ data: [{ id }] }`. Be lenient, and pick up
 * a context length if the provider volunteers one under any of the common field
 * names (OpenRouter: `context_length`; vLLM: `max_model_len`; others).
 */
function extractModels(payload: unknown): FetchedModel[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: FetchedModel[] = [];
  for (const entry of data) {
    if (entry && typeof entry === 'object') {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) {
        const ctx = readContextLength(entry as Record<string, unknown>, [
          'context_length',
          'context_window',
          'max_context_length',
          'max_model_len',
        ]);
        out.push(ctx !== undefined ? { id, contextWindow: ctx } : { id });
      }
    }
  }
  return out;
}

/** First positive integer found among `keys` on `obj`, else undefined. */
function readContextLength(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Local context-window enrichment
// ---------------------------------------------------------------------------

/** Is this baseUrl pointed at the local machine? */
function isLocalHost(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]';
  } catch {
    return false;
  }
}

/** baseUrl minus a trailing `/v1` and any trailing slashes → the server origin. */
function toOrigin(baseUrl: string): string {
  return baseUrl
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '')
    .replace(/\/+$/, '');
}

/**
 * Probe the local server's native endpoints (LM Studio, llama.cpp, Ollama)
 * concurrently and merge their context-length findings by model id. Every probe
 * is independently guarded, so a server that isn't running (or answers slowly)
 * simply contributes nothing.
 */
async function enrichLocalContext(baseUrl: string, ids: string[]): Promise<Map<string, number>> {
  const origin = toOrigin(baseUrl);
  const merged = new Map<string, number>();

  const results = await Promise.all([
    probeLmStudio(origin).catch(() => new Map<string, number>()),
    probeLlamaCpp(origin, ids).catch(() => new Map<string, number>()),
    probeOllama(origin, ids).catch(() => new Map<string, number>()),
  ]);

  for (const src of results) {
    for (const [id, ctx] of src) {
      if (ctx > 0 && !merged.has(id)) merged.set(id, ctx);
    }
  }
  return merged;
}

/** GET a JSON body with the local probe deadline; throws on non-2xx or timeout. */
async function probeJson(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(LOCAL_PROBE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * LM Studio REST API: GET /api/v0/models → entries carry `max_context_length`
 * and, when a model is loaded, `loaded_context_length`. Prefer the loaded value.
 */
async function probeLmStudio(origin: string): Promise<Map<string, number>> {
  const payload = await probeJson(`${origin}/api/v0/models`);
  const out = new Map<string, number>();
  const data = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown })?.data)
      ? (payload as { data: unknown[] }).data
      : [];
  for (const entry of data) {
    if (entry && typeof entry === 'object') {
      const rec = entry as Record<string, unknown>;
      const id = rec.id;
      if (typeof id !== 'string' || !id) continue;
      const ctx = readContextLength(rec, ['loaded_context_length', 'max_context_length']);
      if (ctx !== undefined) out.set(id, ctx);
    }
  }
  return out;
}

/**
 * llama.cpp server: GET /props → `default_generation_settings.n_ctx` is the
 * context size of the single loaded model, so it applies to every listed id.
 */
async function probeLlamaCpp(origin: string, ids: string[]): Promise<Map<string, number>> {
  const payload = await probeJson(`${origin}/props`);
  const out = new Map<string, number>();
  const settings = (payload as { default_generation_settings?: unknown })?.default_generation_settings;
  if (settings && typeof settings === 'object') {
    const ctx = readContextLength(settings as Record<string, unknown>, ['n_ctx']);
    if (ctx !== undefined) for (const id of ids) out.set(id, ctx);
  }
  return out;
}

/**
 * Ollama: POST /api/show {"model": id} per model (capped) → `model_info` holds a
 * `<arch>.context_length` key (e.g. `llama.context_length`). This is the model's
 * max; the running num_ctx may be smaller, so treat it as an upper bound.
 */
async function probeOllama(origin: string, ids: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const targets = ids.slice(0, OLLAMA_SHOW_LIMIT);
  await Promise.all(
    targets.map(async (id) => {
      try {
        const payload = await probeJson(`${origin}/api/show`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: id }),
        });
        const info = (payload as { model_info?: unknown })?.model_info;
        if (info && typeof info === 'object') {
          for (const [key, value] of Object.entries(info as Record<string, unknown>)) {
            if (
              key.endsWith('.context_length') &&
              typeof value === 'number' &&
              Number.isFinite(value) &&
              value > 0
            ) {
              out.set(id, Math.floor(value));
              break;
            }
          }
        }
      } catch {
        /* this model's probe failed — skip it, others may still succeed */
      }
    }),
  );
  return out;
}
