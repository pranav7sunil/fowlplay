/** First-run onboarding: Welcome → Configure a Provider → Select a Model. */
import { useState } from 'preact/hooks';
import type { FowlPlaySettings, ProviderConfig, ModelRef } from '../../shared/types';
import { AddProvider } from './ProviderForm';
import { post, store, useStore } from './store';
import { IconArrowRight, IconCheck } from './icons';
import { Logo } from './Logo';

export function Onboarding({ settings }: { settings: FowlPlaySettings | null }) {
  const [step, setStep] = useState(0);
  const [providerId, setProviderId] = useState<string | null>(null);

  return (
    <div class="fp-onboard">
      <div class="fp-onboard-inner">
        <div class="fp-onboard-steps">
          {[0, 1, 2].map((i) => (
            <span class={`fp-step-dot ${i === step ? 'active' : ''}`} key={i} />
          ))}
        </div>

        {step === 0 && (
          <div>
            <div class="fp-onboard-logo"><Logo size={72} /></div>
            <div class="fp-onboard-wordmark">FowlPlay</div>
            <div class="fp-onboard-tagline">Collaboration, not automation — with a safety harness.</div>
            <button type="button" class="fp-btn fp-btn-primary fp-hero-btn" onClick={() => setStep(1)}>
              Get started <IconArrowRight size={18} />
            </button>
          </div>
        )}

        {step === 1 && (
          <div>
            <h2 style={{ textAlign: 'center' }}>Configure a Provider</h2>
            <p class="fp-section-desc" style={{ textAlign: 'center' }}>
              FowlPlay targets self-hosted models — local providers are featured first. Bring your own key for hosted APIs.
            </p>
            <AddProvider localFirst onDone={(p: ProviderConfig) => { setProviderId(p.id); setStep(2); }} />
          </div>
        )}

        {step === 2 && (
          <SelectModel settings={settings} providerId={providerId} />
        )}
      </div>
    </div>
  );
}

function SelectModel({ settings, providerId }: { settings: FowlPlaySettings | null; providerId: string | null }) {
  const fetched = useStore((s) => (providerId ? s.modelsFetched[providerId] : undefined));
  const provider = settings?.providers.find((p) => p.id === providerId);
  const [selected, setSelected] = useState<ModelRef | null>(null);

  const candidates = provider?.models.length ? provider.models.map((m) => ({ id: m.id })) : (fetched ?? []);

  const finish = () => {
    if (selected) post({ type: 'setModel', model: selected });
    store.setView('chat');
  };

  return (
    <div>
      <h2 style={{ textAlign: 'center' }}>Select a Model</h2>
      <p class="fp-section-desc" style={{ textAlign: 'center' }}>Pick a default model for your conversations.</p>
      {candidates.length === 0 && (
        <div class="fp-empty">
          No models fetched yet. You can add them later in Settings.
        </div>
      )}
      <div class="fp-model-list">
        {candidates.map((m) => {
          const ref: ModelRef = { providerId: providerId!, modelId: m.id };
          const active = selected?.modelId === m.id;
          return (
            <button
              type="button"
              class={`fp-model-item fp-menu-item ${active ? 'active' : ''}`}
              key={m.id}
              onClick={() => setSelected(ref)}
            >
              {active ? <IconCheck size={15} /> : <span style={{ width: 15 }} />}
              <span style={{ fontFamily: 'var(--fp-font)' }}>{m.id}</span>
            </button>
          );
        })}
      </div>
      <button type="button" class="fp-btn fp-btn-primary fp-hero-btn" style={{ marginTop: 24 }} onClick={finish}>
        Enter FowlPlay <IconArrowRight size={18} />
      </button>
    </div>
  );
}
