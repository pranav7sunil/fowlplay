/** Full-screen preview of a staged artifact: an overlay-served page, or rendered Markdown. */
import { useEffect, useState } from 'preact/hooks';
import type { PreviewState } from '../../shared/types';
import { Markdown } from './common';
import { post } from './store';
import { IconX, IconFile, IconRefresh, IconExternalLink } from './icons';

export function PreviewPanel({ state }: { state: PreviewState }) {
  // Bumping this remounts the iframe, forcing a reload without changing the URL.
  const [reloadKey, setReloadKey] = useState(0);

  const close = () => post({ type: 'closePreview' });

  // Esc closes (mirrors the diff viewer, minus its j/k navigation).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div class="fp-preview">
      <div class="fp-preview-header">
        <IconFile size={15} />
        <span class="fp-preview-path">{state.path}</span>
        <div class="fp-spacer" />
        {state.kind === 'page' && (
          <>
            <button type="button" class="fp-btn fp-btn-secondary fp-btn-sm" onClick={() => setReloadKey((k) => k + 1)}>
              <IconRefresh size={14} /> Refresh
            </button>
            <button type="button" class="fp-btn fp-btn-secondary fp-btn-sm" onClick={() => post({ type: 'openPreviewExternal' })}>
              <IconExternalLink size={14} /> Open in Browser
            </button>
          </>
        )}
        <button type="button" class="fp-icon-btn" onClick={close} aria-label="Close preview (Esc)"><IconX /></button>
      </div>

      {state.kind === 'page' ? (
        <iframe
          key={reloadKey}
          class="fp-preview-frame"
          src={state.url}
          sandbox="allow-scripts allow-same-origin allow-forms"
        />
      ) : (
        <div class="fp-preview-md">
          <Markdown text={state.content} />
        </div>
      )}
    </div>
  );
}
