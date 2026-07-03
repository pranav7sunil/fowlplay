/** Auto-growing composer with attachments, send / stop. */
import { useRef, useState } from 'preact/hooks';
import type { Attachment } from '../../shared/protocol';
import { post } from './store';
import { IconPaperclip, IconArrowUp, IconStop, IconX } from './icons';

export function Composer({ streaming }: { streaming: boolean }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(220, ta.scrollHeight) + 'px';
  };

  const send = () => {
    const t = text.trim();
    if (!t && attachments.length === 0) return;
    post({ type: 'sendPrompt', text: t, attachments: attachments.length ? attachments : undefined });
    setText('');
    setAttachments([]);
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = 'auto';
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!streaming) send();
    } else if (e.key === 'Escape' && streaming) {
      e.preventDefault();
      post({ type: 'cancelResponse' });
    }
  };

  const onFiles = (e: Event) => {
    const files = (e.target as HTMLInputElement).files;
    if (!files) return;
    Array.from(files).forEach((file) => {
      const reader = new FileReader();
      const isText = file.type.startsWith('text/') || /\.(txt|md|json|ts|js|tsx|jsx|py|go|rs|css|html)$/i.test(file.name);
      reader.onload = () => {
        let data = String(reader.result ?? '');
        if (!isText) {
          const comma = data.indexOf(',');
          data = comma >= 0 ? data.slice(comma + 1) : data;
        }
        setAttachments((a) => [...a, { name: file.name, mimeType: file.type || 'application/octet-stream', data }]);
      };
      if (isText) reader.readAsText(file);
      else reader.readAsDataURL(file);
    });
    (e.target as HTMLInputElement).value = '';
  };

  return (
    <div class="fp-composer-wrap">
      {attachments.length > 0 && (
        <div class="fp-attachments">
          {attachments.map((a, i) => (
            <span class="fp-attach-chip" key={i}>
              {a.name}
              <button type="button" class="fp-btn-ghost" style={{ padding: 0 }} onClick={() => setAttachments((x) => x.filter((_, j) => j !== i))} aria-label="Remove attachment">
                <IconX size={13} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div class="fp-composer">
        <div class="fp-composer-box">
          <button type="button" class="fp-icon-btn" onClick={() => fileRef.current?.click()} aria-label="Attach file">
            <IconPaperclip size={18} />
          </button>
          <input ref={fileRef} type="file" multiple class="fp-visually-hidden" onChange={onFiles} />
          <textarea
            ref={taRef}
            class="fp-composer-textarea"
            placeholder="Ask FowlPlay to make a change…"
            rows={1}
            value={text}
            onInput={(e) => {
              setText((e.target as HTMLTextAreaElement).value);
              grow();
            }}
            onKeyDown={onKeyDown}
          />
          {streaming ? (
            <button type="button" class="fp-send-btn stop" onClick={() => post({ type: 'cancelResponse' })} aria-label="Stop response">
              <IconStop size={16} />
            </button>
          ) : (
            <button type="button" class="fp-send-btn" onClick={send} disabled={!text.trim() && attachments.length === 0} aria-label="Send">
              <IconArrowUp size={18} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
