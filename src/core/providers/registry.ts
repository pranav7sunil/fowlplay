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

/** Just enough of a provider config to fetch its model list. */
export type FetchModelsConfig = Pick<ProviderConfig, 'sdkType' | 'baseUrl'>;

/**
 * List available models for a provider.
 * - openai-completions: GET {baseUrl}/models, Bearer auth if a key is given.
 * - anthropic:          GET {baseUrl}/v1/models (no double /v1), x-api-key auth.
 * Returns `{ id }[]` sorted by id. Throws with a useful message on failure.
 */
export async function fetchModels(
  config: FetchModelsConfig,
  apiKey?: string,
): Promise<{ id: string }[]> {
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

  const ids = extractModelIds(payload);
  if (ids.length === 0) {
    throw new Error(`Model list from ${url} contained no models`);
  }
  return ids
    .map((id) => ({ id }))
    .sort((a, b) => a.id.localeCompare(b.id));
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

/** Both OpenAI and Anthropic return `{ data: [{ id }] }`. Be lenient. */
function extractModelIds(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    if (entry && typeof entry === 'object') {
      const id = (entry as { id?: unknown }).id;
      if (typeof id === 'string' && id.length > 0) ids.push(id);
    }
  }
  return ids;
}
