/** Add-provider flow (preset grid → form) and per-provider model management. */
import { useState } from 'preact/hooks';
import type { ProviderConfig, ProviderKind, SdkType, ModelConfig } from '../../shared/types';
import { post, useStore } from './store';
import { IconPlus, IconTrash, IconCheck, IconX } from './icons';

interface Preset {
  name: string;
  kind: ProviderKind;
  sdkType: SdkType;
  baseUrl: string;
  requiresApiKey: boolean;
  badge: string;
}

export const PRESETS: Preset[] = [
  { name: 'Ollama', kind: 'local', sdkType: 'openai-completions', baseUrl: 'http://localhost:11434/v1', requiresApiKey: false, badge: 'Ol' },
  { name: 'LM Studio', kind: 'local', sdkType: 'openai-completions', baseUrl: 'http://localhost:1234/v1', requiresApiKey: false, badge: 'LM' },
  { name: 'llama.cpp', kind: 'local', sdkType: 'openai-completions', baseUrl: 'http://localhost:8080/v1', requiresApiKey: false, badge: 'll' },
  { name: 'OpenAI', kind: 'api-key', sdkType: 'openai-completions', baseUrl: 'https://api.openai.com/v1', requiresApiKey: true, badge: 'AI' },
  { name: 'Anthropic', kind: 'api-key', sdkType: 'anthropic', baseUrl: 'https://api.anthropic.com', requiresApiKey: true, badge: 'An' },
  { name: 'Google', kind: 'api-key', sdkType: 'openai-completions', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', requiresApiKey: true, badge: 'Go' },
  { name: 'Mistral', kind: 'api-key', sdkType: 'openai-completions', baseUrl: 'https://api.mistral.ai/v1', requiresApiKey: true, badge: 'Mi' },
  { name: 'DeepSeek', kind: 'api-key', sdkType: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1', requiresApiKey: true, badge: 'DS' },
  { name: 'OpenRouter', kind: 'api-key', sdkType: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', requiresApiKey: true, badge: 'OR' },
  { name: 'MiniMax', kind: 'api-key', sdkType: 'openai-completions', baseUrl: 'https://api.minimax.chat/v1', requiresApiKey: true, badge: 'MM' },
  { name: 'Z.ai', kind: 'api-key', sdkType: 'openai-completions', baseUrl: 'https://api.z.ai/v1', requiresApiKey: true, badge: 'Z' },
  { name: 'Moonshot', kind: 'api-key', sdkType: 'openai-completions', baseUrl: 'https://api.moonshot.cn/v1', requiresApiKey: true, badge: 'Mo' },
  { name: 'Custom', kind: 'custom', sdkType: 'openai-completions', baseUrl: '', requiresApiKey: true, badge: '+' },
];

function uuid(): string {
  return 'p-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Preset grid; local presets featured first when `localFirst`. */
export function AddProvider({
  onDone,
  localFirst = false,
}: {
  onDone?: (provider: ProviderConfig) => void;
  localFirst?: boolean;
}) {
  const [preset, setPreset] = useState<Preset | null>(null);
  const presets = localFirst
    ? [...PRESETS].sort((a, b) => (a.kind === 'local' ? -1 : 0) - (b.kind === 'local' ? -1 : 0))
    : PRESETS;

  if (!preset) {
    return (
      <div class="fp-preset-grid">
        {presets.map((p) => (
          <button type="button" class="fp-preset" key={p.name} onClick={() => setPreset(p)}>
            <span class="fp-preset-badge">{p.badge}</span>
            <span class="fp-preset-name">{p.name}</span>
            <span class="fp-preset-kind">{p.kind === 'local' ? 'local' : p.kind === 'custom' ? 'custom' : 'API key'}</span>
          </button>
        ))}
      </div>
    );
  }

  return <ProviderFields preset={preset} onBack={() => setPreset(null)} onDone={onDone} />;
}

function ProviderFields({
  preset,
  onBack,
  onDone,
}: {
  preset: Preset;
  onBack: () => void;
  onDone?: (provider: ProviderConfig) => void;
}) {
  const [name, setName] = useState(preset.name === 'Custom' ? '' : preset.name);
  const [sdkType, setSdkType] = useState<SdkType>(preset.sdkType);
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [requiresApiKey, setRequiresApiKey] = useState(preset.requiresApiKey);

  const save = () => {
    const provider: ProviderConfig = {
      id: uuid(),
      name: name.trim() || preset.name,
      kind: preset.kind,
      sdkType,
      baseUrl: baseUrl.trim(),
      requiresApiKey,
      models: [],
    };
    post({ type: 'addProvider', provider, apiKey: requiresApiKey ? apiKey : undefined });
    post({ type: 'fetchModels', providerId: provider.id });
    onDone?.(provider);
  };

  return (
    <div>
      <div class="fp-field">
        <label>Display name</label>
        <input class="fp-input" value={name} placeholder="e.g. Ollama (local)" onInput={(e) => setName((e.target as HTMLInputElement).value)} />
      </div>
      <div class="fp-field">
        <label>API format</label>
        <select class="fp-select" value={sdkType} onChange={(e) => setSdkType((e.target as HTMLSelectElement).value as SdkType)}>
          <option value="openai-completions">OpenAI (Chat Completions)</option>
          <option value="anthropic">Anthropic (Messages)</option>
        </select>
      </div>
      <div class="fp-field">
        <label>Base URL</label>
        <input class="fp-input" style={{ fontFamily: 'var(--fp-font)' }} value={baseUrl} placeholder="http://localhost:11434/v1" onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)} />
      </div>
      {preset.kind === 'custom' && (
        <label class="fp-checkbox fp-field">
          <input type="checkbox" checked={requiresApiKey} onChange={(e) => setRequiresApiKey((e.target as HTMLInputElement).checked)} />
          Requires an API key
        </label>
      )}
      {requiresApiKey && (
        <div class="fp-field">
          <label>API key</label>
          <input class="fp-input" type="password" value={apiKey} placeholder="sk-…" onInput={(e) => setApiKey((e.target as HTMLInputElement).value)} />
          <div class="fp-hint">Stored in VS Code secret storage — never leaves your machine.</div>
        </div>
      )}
      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" class="fp-btn fp-btn-secondary" onClick={onBack}>Back</button>
        <button type="button" class="fp-btn fp-btn-primary" disabled={!baseUrl.trim() || (requiresApiKey && !apiKey.trim())} onClick={save}>
          <IconCheck size={15} /> Save provider
        </button>
      </div>
    </div>
  );
}

/** Manage a provider's models: fetched checkboxes, manual add, rename, remove. */
export function ModelManagement({ provider }: { provider: ProviderConfig }) {
  const fetched = useStore((s) => s.modelsFetched[provider.id]);
  const fetchError = useStore((s) => s.modelsError[provider.id]);
  const [manual, setManual] = useState('');
  const [models, setModels] = useState<ModelConfig[]>(provider.models);

  const persist = (next: ModelConfig[]) => {
    setModels(next);
    post({ type: 'updateProvider', provider: { ...provider, models: next } });
  };

  const toggle = (id: string, on: boolean) => {
    persist(on ? [...models, { id }] : models.filter((m) => m.id !== id));
  };
  const rename = (id: string, displayName: string) => {
    persist(models.map((m) => (m.id === id ? { ...m, displayName: displayName || undefined } : m)));
  };
  const addManual = () => {
    const id = manual.trim();
    if (id && !models.some((m) => m.id === id)) persist([...models, { id }]);
    setManual('');
  };

  const selectedIds = new Set(models.map((m) => m.id));
  const available = (fetched ?? []).filter((f) => !selectedIds.has(f.id));

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <button type="button" class="fp-btn fp-btn-secondary fp-btn-sm" onClick={() => post({ type: 'fetchModels', providerId: provider.id })}>Fetch models</button>
        {fetchError && <span style={{ color: 'var(--fp-block)', fontSize: 12 }}>{fetchError}</span>}
      </div>

      {models.length > 0 && (
        <div class="fp-model-list">
          {models.map((m) => (
            <div class="fp-model-item" key={m.id}>
              <IconCheck size={15} style={{ color: 'var(--fp-ok)' }} />
              <span style={{ fontFamily: 'var(--fp-font)', fontSize: 12 }}>{m.id}</span>
              <input
                class="fp-input"
                style={{ flex: 1, padding: '3px 8px' }}
                placeholder="display name"
                value={m.displayName ?? ''}
                onInput={(e) => rename(m.id, (e.target as HTMLInputElement).value)}
              />
              <button type="button" class="fp-icon-btn" onClick={() => toggle(m.id, false)} aria-label="Remove model"><IconTrash size={14} /></button>
            </div>
          ))}
        </div>
      )}

      {available.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div class="fp-gate-section-label">Available</div>
          <div class="fp-model-list">
            {available.map((f) => (
              <label class="fp-model-item fp-checkbox" key={f.id}>
                <input type="checkbox" onChange={(e) => toggle(f.id, (e.target as HTMLInputElement).checked)} />
                <span style={{ fontFamily: 'var(--fp-font)', fontSize: 12 }}>{f.id}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <input class="fp-input" placeholder="Add model id manually…" value={manual} onInput={(e) => setManual((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && addManual()} />
        <button type="button" class="fp-btn fp-btn-secondary" onClick={addManual}><IconPlus size={15} /> Add</button>
      </div>
    </div>
  );
}

void IconX;
