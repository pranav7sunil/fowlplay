/** Settings: Appearance, Models & Providers, Harness. */
import { useState } from 'preact/hooks';
import type { FowlPlaySettings, AppearanceSettings, ThemeName, HarnessMode, ProviderConfig } from '../../shared/types';
import { post, store, applyAppearance } from './store';
import { AddProvider, ModelManagement } from './ProviderForm';
import { IconX, IconPlus, IconTrash, IconArrowRight } from './icons';

type Tab = 'appearance' | 'providers' | 'harness';

const THEMES: { id: ThemeName; name: string; colors: string[] }[] = [
  { id: 'inherit', name: 'VS Code Inherited', colors: ['#1e1e1e', '#4166f5', '#d4d4d4'] },
  { id: 'fowlplay-dark', name: 'FowlPlay Dark', colors: ['#0f1115', '#4166f5', '#e6e9ef'] },
  { id: 'fowlplay-light', name: 'FowlPlay Light', colors: ['#ffffff', '#4166f5', '#1c2024'] },
  { id: 'fowlplay-midnight', name: 'FowlPlay Midnight', colors: ['#0a0e1f', '#4166f5', '#e8ecff'] },
];

export function Settings({ settings }: { settings: FowlPlaySettings | null }) {
  const [tab, setTab] = useState<Tab>('appearance');
  return (
    <div class="fp-view">
      <div class="fp-titlebar">
        <div class="fp-titlebar-title">Settings</div>
        <div class="fp-spacer" />
        <button type="button" class="fp-icon-btn" onClick={() => store.setView('chat')} aria-label="Close"><IconX /></button>
      </div>
      <div class="fp-view-inner">
        <div class="fp-tabs">
          <button type="button" class={`fp-tab ${tab === 'appearance' ? 'active' : ''}`} onClick={() => setTab('appearance')}>Appearance</button>
          <button type="button" class={`fp-tab ${tab === 'providers' ? 'active' : ''}`} onClick={() => setTab('providers')}>Models &amp; Providers</button>
          <button type="button" class={`fp-tab ${tab === 'harness' ? 'active' : ''}`} onClick={() => setTab('harness')}>Harness</button>
        </div>
        {tab === 'appearance' && <AppearanceTab settings={settings} />}
        {tab === 'providers' && <ProvidersTab settings={settings} />}
        {tab === 'harness' && <HarnessTab settings={settings} />}
      </div>
    </div>
  );
}

function AppearanceTab({ settings }: { settings: FowlPlaySettings | null }) {
  const current: AppearanceSettings = settings?.appearance ?? { fontFamily: 'JetBrains Mono', fontScale: 1, theme: 'inherit' };
  const [appearance, setAppearance] = useState<AppearanceSettings>(current);
  const [customFont, setCustomFont] = useState(!['JetBrains Mono', 'Fira Code'].includes(current.fontFamily));

  const update = (patch: Partial<AppearanceSettings>) => {
    const next = { ...appearance, ...patch };
    setAppearance(next);
    applyAppearance(next); // live preview
    post({ type: 'saveAppearance', appearance: next });
  };

  return (
    <>
      <div class="fp-section">
        <h2>Font</h2>
        <div class="fp-section-desc">Used for chat text and code blocks.</div>
        <div class="fp-field">
          <label>Font family</label>
          <select
            class="fp-select"
            value={customFont ? 'custom' : appearance.fontFamily}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v === 'custom') { setCustomFont(true); }
              else { setCustomFont(false); update({ fontFamily: v }); }
            }}
          >
            <option value="JetBrains Mono">JetBrains Mono</option>
            <option value="Fira Code">Fira Code</option>
            <option value="custom">Custom…</option>
          </select>
          {customFont && (
            <input class="fp-input" style={{ marginTop: 8 }} placeholder="Font family name" value={appearance.fontFamily} onInput={(e) => update({ fontFamily: (e.target as HTMLInputElement).value })} />
          )}
        </div>
        <div class="fp-field">
          <label>Font scale — {appearance.fontScale.toFixed(2)}×</label>
          <input class="fp-slider" type="range" min="0.8" max="1.6" step="0.05" value={appearance.fontScale} onInput={(e) => update({ fontScale: Number((e.target as HTMLInputElement).value) })} />
        </div>
      </div>

      <div class="fp-section">
        <h2>Theme</h2>
        <div class="fp-section-desc">All themes are ultramarine-accented.</div>
        <div class="fp-swatches">
          {THEMES.map((t) => (
            <div class={`fp-swatch ${appearance.theme === t.id ? 'active' : ''}`} onClick={() => update({ theme: t.id })} key={t.id}>
              <div class="fp-swatch-preview" style={{ background: t.colors[0], border: '1px solid var(--fp-border)' }}>
                <span style={{ width: 18, height: 18, borderRadius: 6, background: t.colors[1] }} />
                <span style={{ flex: 1, height: 6, borderRadius: 3, background: t.colors[2], opacity: 0.5 }} />
              </div>
              <div class="fp-swatch-name">{t.name}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function ProvidersTab({ settings }: { settings: FowlPlaySettings | null }) {
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const providers = settings?.providers ?? [];

  return (
    <div class="fp-section">
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
        <div>
          <h2>Providers</h2>
          <div class="fp-section-desc" style={{ margin: 0 }}>Bring your own key — local first.</div>
        </div>
        <div class="fp-spacer" />
        {!adding && <button type="button" class="fp-btn fp-btn-primary" onClick={() => setAdding(true)}><IconPlus size={16} /> Add Provider</button>}
      </div>

      {adding ? (
        <AddProvider onDone={() => setAdding(false)} />
      ) : (
        <>
          {providers.length === 0 && <div class="fp-empty">No providers yet. Add one to get started.</div>}
          {providers.map((p) => (
            <div key={p.id}>
              <div class="fp-provider-row">
                <span class="fp-provider-name">{p.name}</span>
                <span class="fp-chip">{p.kind}</span>
                <span class="fp-chip">{p.sdkType === 'anthropic' ? 'Anthropic' : 'OpenAI'}</span>
                <span style={{ color: 'var(--fp-fg-muted)', fontSize: 12 }}>{p.models.length} models</span>
                <div class="fp-spacer" />
                <button type="button" class="fp-btn fp-btn-secondary fp-btn-sm" onClick={() => setExpanded(expanded === p.id ? null : p.id)}>
                  {expanded === p.id ? 'Done' : 'Manage'} <IconArrowRight size={13} />
                </button>
                <button type="button" class="fp-icon-btn" onClick={() => post({ type: 'deleteProvider', providerId: p.id })} aria-label="Delete provider"><IconTrash size={15} /></button>
              </div>
              {expanded === p.id && (
                <div style={{ padding: '0 0 16px 14px' }}><ModelManagement provider={p as ProviderConfig} /></div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function HarnessTab({ settings }: { settings: FowlPlaySettings | null }) {
  const h = settings?.harness ?? { defaultMode: 'coop' as HarnessMode, qasRetryBudget: 2 };
  const [mode, setMode] = useState<HarnessMode>(h.defaultMode);
  const [budget, setBudget] = useState(h.qasRetryBudget);

  const save = (patch: Partial<typeof h>) => {
    const next = { ...h, defaultMode: mode, qasRetryBudget: budget, ...patch };
    post({ type: 'saveHarnessSettings', harness: next });
  };

  return (
    <>
      <div class="fp-section">
        <h2>Default mode</h2>
        <div class="fp-section-desc">Coop runs the Safe Agentic Workflow gates; Solo is the plain agentic loop.</div>
        <div class="fp-segmented">
          <button type="button" class={mode === 'solo' ? 'active' : ''} onClick={() => { setMode('solo'); save({ defaultMode: 'solo' }); }}>Solo</button>
          <button type="button" class={mode === 'coop' ? 'active' : ''} onClick={() => { setMode('coop'); save({ defaultMode: 'coop' }); }}>Coop</button>
        </div>
      </div>

      <div class="fp-section">
        <h2>QAS retry budget</h2>
        <div class="fp-section-desc">Maximum Inspector route-backs to the Builder per turn.</div>
        <div class="fp-stepper">
          <button type="button" onClick={() => { const v = Math.max(0, budget - 1); setBudget(v); save({ qasRetryBudget: v }); }}>−</button>
          <span style={{ minWidth: 24, textAlign: 'center', fontWeight: 700 }}>{budget}</span>
          <button type="button" onClick={() => { const v = budget + 1; setBudget(v); save({ qasRetryBudget: v }); }}>+</button>
        </div>
      </div>

      <div class="fp-section">
        <h2>The Coop pipeline</h2>
        <div class="fp-section-desc">Every stage is rendered in chat as a gate card with pass/fail evidence.</div>
        <div class="fp-pipeline">
          {['Scout', 'Gate', 'Builder', 'Inspector', 'Sentry', 'You'].map((s, i, arr) => (
            <>
              <span class="fp-pipeline-step" key={s}>{s}</span>
              {i < arr.length - 1 && <span class="fp-pipeline-arrow">→</span>}
            </>
          ))}
        </div>
      </div>
    </>
  );
}
