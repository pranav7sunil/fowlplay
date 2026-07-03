/** Shared UI primitives: Markdown, Collapsible, Dropdown, Modal. */
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { renderMarkdown } from '../markdown';
import { IconChevronRight } from './icons';

/** Renders markdown as safe HTML; wires code-block copy buttons via delegation. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = renderMarkdown(text);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClick = (e: Event) => {
      const target = (e.target as HTMLElement).closest('[data-copy]');
      if (!target) return;
      const block = target.closest('.fp-codeblock');
      const code = block?.querySelector('pre code')?.textContent ?? '';
      void navigator.clipboard?.writeText(code).catch(() => {});
      const prev = target.textContent;
      target.textContent = 'Copied';
      setTimeout(() => {
        if (target.isConnected) target.textContent = prev;
      }, 1200);
    };
    el.addEventListener('click', onClick);
    return () => el.removeEventListener('click', onClick);
  }, [html]);
  return (
    <div
      ref={ref}
      class={`fp-md ${className ?? ''}`}
      // Content is fully HTML-escaped inside renderMarkdown; safe to inject.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function Collapsible({
  title,
  defaultOpen = false,
  children,
  className,
}: {
  title: ComponentChildren;
  defaultOpen?: boolean;
  children: ComponentChildren;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div class={`fp-collapsible ${open ? 'open' : ''} ${className ?? ''}`}>
      <button type="button" class="fp-collapsible-head" onClick={() => setOpen((o) => !o)}>
        <IconChevronRight size={15} class="fp-chevron" />
        {title}
      </button>
      {open && <div class="fp-collapsible-body">{children}</div>}
    </div>
  );
}

/** Anchored dropdown that closes on outside click / Escape. */
export function Dropdown({
  trigger,
  children,
  align = 'left',
}: {
  trigger: (open: boolean, toggle: () => void) => ComponentChildren;
  children: (close: () => void) => ComponentChildren;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div class="fp-anchor" ref={ref}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div class="fp-menu" style={{ [align === 'right' ? 'right' : 'left']: 0, top: 'calc(100% + 4px)' }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div class="fp-modal-overlay" onMouseDown={onClose}>
      <div class="fp-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}
