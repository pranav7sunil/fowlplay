/** Conversation history: search, open, rename, delete, export. */
import { useEffect, useState } from 'preact/hooks';
import type { ConversationSummary } from '../../shared/types';
import { post, store } from './store';
import { IconSearch, IconTrash, IconPencil, IconX, IconCopy } from './icons';

export function HistoryPanel({ items }: { items: ConversationSummary[] }) {
  const [query, setQuery] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState('');

  useEffect(() => {
    post({ type: 'listConversations' });
  }, []);

  const search = (q: string) => {
    setQuery(q);
    post({ type: 'listConversations', query: q || undefined });
  };

  return (
    <div class="fp-view">
      <div class="fp-titlebar">
        <div class="fp-titlebar-title">History</div>
        <div class="fp-spacer" />
        <button type="button" class="fp-icon-btn" onClick={() => store.setView('chat')} aria-label="Close"><IconX /></button>
      </div>
      <div class="fp-view-inner">
        <div class="fp-history-search">
          <div class="fp-composer-box" style={{ padding: '4px 12px', borderRadius: 'var(--fp-radius)' }}>
            <IconSearch size={16} style={{ color: 'var(--fp-fg-muted)' }} />
            <input
              class="fp-composer-textarea"
              style={{ maxHeight: 'none' }}
              placeholder="Search conversations…"
              value={query}
              onInput={(e) => search((e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        <div class="fp-history-list">
          {items.length === 0 && <div class="fp-empty">No conversations yet.</div>}
          {items.map((c) => (
            <div class="fp-history-item" key={c.id} onClick={() => renameId !== c.id && post({ type: 'openConversation', id: c.id })}>
              {renameId === c.id ? (
                <input
                  class="fp-input"
                  value={renameText}
                  autofocus
                  onClick={(e) => e.stopPropagation()}
                  onInput={(e) => setRenameText((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { post({ type: 'renameConversation', id: c.id, title: renameText.trim() || c.title }); setRenameId(null); }
                    if (e.key === 'Escape') setRenameId(null);
                  }}
                  onBlur={() => { post({ type: 'renameConversation', id: c.id, title: renameText.trim() || c.title }); setRenameId(null); }}
                />
              ) : (
                <span class="fp-history-title">{c.title}</span>
              )}
              <span class="fp-history-meta">{c.messageCount} msg · {new Date(c.updatedAt).toLocaleDateString()}</span>
              <div class="fp-history-actions" onClick={(e) => e.stopPropagation()}>
                <button type="button" class="fp-icon-btn" title="Copy as Markdown" onClick={() => { post({ type: 'openConversation', id: c.id }); post({ type: 'exportConversation', format: 'markdown' }); }}><IconCopy size={15} /></button>
                <button type="button" class="fp-icon-btn" title="Export as JSON" onClick={() => { post({ type: 'openConversation', id: c.id }); post({ type: 'exportConversation', format: 'json' }); }} style={{ fontFamily: 'var(--fp-font)', fontSize: 11 }}>{'{}'}</button>
                <button type="button" class="fp-icon-btn" title="Rename" onClick={() => { setRenameId(c.id); setRenameText(c.title); }}><IconPencil size={15} /></button>
                <button type="button" class="fp-icon-btn" title="Delete" onClick={() => setConfirmId(c.id)}><IconTrash size={15} /></button>
              </div>
              {confirmId === c.id && (
                <div class="fp-modal-overlay" onClick={(e) => { e.stopPropagation(); setConfirmId(null); }}>
                  <div class="fp-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 400 }}>
                    <h3>Delete conversation?</h3>
                    <p style={{ color: 'var(--fp-fg-muted)' }}>“{c.title}” will be permanently removed.</p>
                    <div class="fp-modal-actions">
                      <button type="button" class="fp-btn fp-btn-secondary" onClick={() => setConfirmId(null)}>Cancel</button>
                      <button type="button" class="fp-btn fp-btn-danger" onClick={() => { post({ type: 'deleteConversation', id: c.id }); setConfirmId(null); }}>Delete</button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
