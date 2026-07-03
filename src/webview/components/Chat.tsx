/** Chat view: title bar + message list + composer + status line. */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Conversation, FowlPlaySettings } from '../../shared/types';
import { activePath, post, store } from './store';
import { Message } from './Message';
import { Composer } from './Composer';
import { StatusLine } from './StatusLine';
import { IconHistory, IconPlus, IconGear, IconDiff } from './icons';

export function TitleBar({
  conv,
  changeCount,
}: {
  conv: Conversation | null;
  changeCount: number;
}) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');

  const startRename = () => {
    setTitle(conv?.title ?? '');
    setRenaming(true);
  };
  const commit = () => {
    if (conv && title.trim()) post({ type: 'renameConversation', id: conv.id, title: title.trim() });
    setRenaming(false);
  };

  return (
    <div class="fp-titlebar">
      {renaming ? (
        <input
          class="fp-input"
          style={{ maxWidth: '40ch' }}
          value={title}
          autofocus
          onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setRenaming(false);
          }}
        />
      ) : (
        <div class="fp-titlebar-title" onClick={startRename} title="Click to rename">
          {conv?.title || 'New Conversation'}
        </div>
      )}
      <div class="fp-spacer" />
      {changeCount > 0 && (
        <button type="button" class="fp-pill" onClick={() => store.openReview()}>
          <IconDiff size={14} /> {changeCount} {changeCount === 1 ? 'file' : 'files'} changed
        </button>
      )}
      <button type="button" class="fp-icon-btn" onClick={() => { store.setView('history'); post({ type: 'listConversations' }); }} aria-label="History"><IconHistory /></button>
      <button type="button" class="fp-icon-btn" onClick={() => post({ type: 'newConversation' })} aria-label="New conversation"><IconPlus /></button>
      <button type="button" class="fp-icon-btn" onClick={() => { store.setView('settings'); post({ type: 'getSettings' }); }} aria-label="Settings"><IconGear /></button>
    </div>
  );
}

export function Chat({
  conv,
  settings,
  streaming,
  changeCount,
}: {
  conv: Conversation | null;
  settings: FowlPlaySettings | null;
  streaming: boolean;
  changeCount: number;
}) {
  const path = activePath(conv);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  });

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  return (
    <div class="fp-chat">
      <TitleBar conv={conv} changeCount={changeCount} />
      <div class="fp-messages" ref={scrollRef} onScroll={onScroll}>
        <div class="fp-messages-inner">
          {path.length === 0 && (
            <div class="fp-empty">
              <div class="fp-empty-icon">🐓</div>
              <div>Start a conversation. FowlPlay proposes changes; you review every diff.</div>
            </div>
          )}
          {conv && path.map((node) => (
            <Message key={node.id} node={node} conv={conv} />
          ))}
        </div>
      </div>
      <Composer streaming={streaming} />
      {conv && <StatusLine conv={conv} settings={settings} />}
    </div>
  );
}
