/** Bottom status line: model picker, harness toggle, context usage + tokens. */
import type { Conversation, FowlPlaySettings, ModelRef, HarnessMode } from '../../shared/types';
import { Dropdown } from './common';
import { post } from './store';
import { IconChevronDown, IconCheck } from './icons';

function modelLabel(settings: FowlPlaySettings | null, ref: ModelRef | null): string {
  if (!ref) return 'Select model';
  const p = settings?.providers.find((x) => x.id === ref.providerId);
  const m = p?.models.find((x) => x.id === ref.modelId);
  return m?.displayName || m?.id || ref.modelId;
}

function contextWindowFor(settings: FowlPlaySettings | null, ref: ModelRef | null): number | undefined {
  if (!ref) return undefined;
  const p = settings?.providers.find((x) => x.id === ref.providerId);
  return p?.models.find((x) => x.id === ref.modelId)?.contextWindow;
}

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function StatusLine({
  conv,
  settings,
}: {
  conv: Conversation;
  settings: FowlPlaySettings | null;
}) {
  const totals = conv.usageTotals;
  const ctx = contextWindowFor(settings, conv.model);
  // Approx live context = last assistant input tokens; fall back to cumulative input.
  const nodes = Object.values(conv.nodes);
  const lastInput = nodes
    .filter((n) => n.usage)
    .sort((a, b) => b.createdAt - a.createdAt)[0]?.usage?.inputTokens ?? totals.inputTokens;
  const pct = ctx ? Math.min(100, Math.round((lastInput / ctx) * 100)) : 0;

  const setMode = (mode: HarnessMode) => post({ type: 'setHarnessMode', mode });

  return (
    <div class="fp-statusline">
      <Dropdown
        trigger={(open, toggle) => (
          <button type="button" class="fp-model-btn" onClick={toggle} aria-expanded={open}>
            {modelLabel(settings, conv.model)}
            <IconChevronDown size={14} />
          </button>
        )}
      >
        {(close) => (
          <ModelMenu
            settings={settings}
            current={conv.model}
            onPick={(ref) => {
              post({ type: 'setModel', model: ref });
              close();
            }}
          />
        )}
      </Dropdown>

      <div class="fp-segmented" role="group" aria-label="Harness mode">
        <button type="button" class={conv.harnessMode === 'solo' ? 'active' : ''} onClick={() => setMode('solo')}>Solo</button>
        <button type="button" class={conv.harnessMode === 'coop' ? 'active' : ''} onClick={() => setMode('coop')}>Coop</button>
      </div>

      <div class="fp-spacer" />

      {ctx && (
        <div class="fp-context" title={`~${lastInput} tokens in context now / ${ctx} window`}>
          <div class="fp-context-bar"><div class="fp-context-fill" style={{ width: `${pct}%` }} /></div>
          <span>{pct}%</span>
        </div>
      )}
      <span class="fp-tokens" title="cumulative this conversation: input / output / cached">
        ↑{fmt(totals.inputTokens)} ↓{fmt(totals.outputTokens)} ⚡{fmt(totals.cachedTokens)}
      </span>
    </div>
  );
}

function ModelMenu({
  settings,
  current,
  onPick,
}: {
  settings: FowlPlaySettings | null;
  current: ModelRef | null;
  onPick: (ref: ModelRef) => void;
}) {
  const providers = settings?.providers ?? [];
  if (providers.length === 0) {
    return <div class="fp-menu-item" style={{ color: 'var(--fp-fg-muted)' }}>No providers configured</div>;
  }
  return (
    <>
      {providers.map((p) => (
        <div key={p.id}>
          <div class="fp-menu-group-label">{p.name}</div>
          {p.models.length === 0 && <div class="fp-menu-item" style={{ color: 'var(--fp-fg-muted)' }}>No models</div>}
          {p.models.map((m) => {
            const active = current?.providerId === p.id && current?.modelId === m.id;
            return (
              <button
                key={m.id}
                type="button"
                class={`fp-menu-item ${active ? 'active' : ''}`}
                onClick={() => onPick({ providerId: p.id, modelId: m.id })}
              >
                {active ? <IconCheck size={15} /> : <span style={{ width: 15 }} />}
                {m.displayName || m.id}
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}
