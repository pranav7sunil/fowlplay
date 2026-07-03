/** Transient toast notifications. */
import type { Toast } from './store';
import { store } from './store';
import { IconX, IconCheck, IconAlert } from './icons';

export function Toasts({ toasts }: { toasts: Toast[] }) {
  if (toasts.length === 0) return null;
  return (
    <div class="fp-toasts">
      {toasts.map((t) => (
        <div class={`fp-toast ${t.level}`} key={t.id}>
          {t.level === 'error' || t.level === 'warn' ? <IconAlert size={16} /> : <IconCheck size={16} style={{ color: 'var(--fp-ok)' }} />}
          <span>{t.message}</span>
          <button type="button" class="fp-btn-ghost" style={{ padding: 0 }} onClick={() => store.dismissToast(t.id)} aria-label="Dismiss"><IconX size={14} /></button>
        </div>
      ))}
    </div>
  );
}
