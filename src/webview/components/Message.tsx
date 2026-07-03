/** A single message on the active path: user bubble or assistant flow. */
import { useState } from 'preact/hooks';
import type { MessageNode, Conversation } from '../../shared/types';
import { BlockView } from './blocks';
import { Markdown } from './common';
import { post, siblingInfo } from './store';
import { IconPencil, IconRerun, IconRewind, IconChevronLeft, IconChevronRight } from './icons';

export function Message({
  node,
  conv,
}: {
  node: MessageNode;
  conv: Conversation;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const sib = siblingInfo(conv, node);

  const userText = node.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');

  const startEdit = () => {
    setDraft(userText);
    setEditing(true);
  };
  const saveEdit = () => {
    const text = draft.trim();
    if (text) post({ type: 'editMessage', nodeId: node.id, text });
    setEditing(false);
  };

  const branchNav = sib.count > 1 && (
    <span class="fp-branch-nav">
      <button
        type="button"
        disabled={sib.index === 0}
        onClick={() => post({ type: 'switchBranch', nodeId: node.id, direction: 'prev' })}
        aria-label="Previous branch"
      >
        <IconChevronLeft size={13} />
      </button>
      {sib.index + 1}/{sib.count}
      <button
        type="button"
        disabled={sib.index === sib.count - 1}
        onClick={() => post({ type: 'switchBranch', nodeId: node.id, direction: 'next' })}
        aria-label="Next branch"
      >
        <IconChevronRight size={13} />
      </button>
    </span>
  );

  if (node.role === 'user') {
    if (editing) {
      return (
        <div class="fp-msg fp-msg-user">
          <div class="fp-inline-editor">
            <textarea
              class="fp-textarea"
              rows={3}
              value={draft}
              autofocus
              onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  saveEdit();
                } else if (e.key === 'Escape') {
                  setEditing(false);
                }
              }}
            />
            <div class="fp-actions">
              <button type="button" class="fp-btn fp-btn-secondary fp-btn-sm" onClick={() => setEditing(false)}>Cancel</button>
              <button type="button" class="fp-btn fp-btn-primary fp-btn-sm" onClick={saveEdit}>Save &amp; Send</button>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div class="fp-msg fp-msg-user">
        <div class="fp-bubble"><Markdown text={userText} /></div>
        <div class="fp-msg-toolbar" style={{ alignSelf: 'flex-end' }}>
          {branchNav}
          <button type="button" class="fp-icon-btn" onClick={startEdit} aria-label="Edit message"><IconPencil size={15} /></button>
          <button type="button" class="fp-icon-btn" onClick={() => post({ type: 'rewindTo', nodeId: node.id })} aria-label="Rewind to here"><IconRewind size={15} /></button>
        </div>
      </div>
    );
  }

  // Assistant
  return (
    <div class="fp-msg fp-msg-assistant">
      {node.blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
      <div class="fp-msg-toolbar">
        {branchNav}
        <button type="button" class="fp-icon-btn" onClick={() => post({ type: 'rerunMessage', nodeId: node.id })} aria-label="Rerun response"><IconRerun size={15} /></button>
        <button type="button" class="fp-icon-btn" onClick={() => post({ type: 'rewindTo', nodeId: node.id })} aria-label="Rewind to here"><IconRewind size={15} /></button>
      </div>
    </div>
  );
}
