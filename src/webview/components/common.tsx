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

/**
 * Anchored dropdown that closes on outside click / Escape.
 *
 * Placement auto-flips: the menu opens downward by default, but when the
 * trigger sits near the bottom of the viewport (e.g. the status-line model
 * picker) it opens upward instead, and its height is capped to the space
 * actually available on the chosen side so it never renders off-screen.
 */
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
  const [up, setUp] = useState(false);
  const [maxH, setMaxH] = useState<number | undefined>(undefined);
  const ref = useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (!open && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      // Flip upward when the menu can't comfortably fit below and there is
      // more room above; cap to the chosen side's space so it always fits.
      const flip = spaceBelow < 300 && spaceAbove > spaceBelow;
      setUp(flip);
      setMaxH(Math.max(120, (flip ? spaceAbove : spaceBelow) - 16));
    }
    setOpen((o) => !o);
  };

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
      {trigger(open, toggle)}
      {open && (
        <div
          class="fp-menu"
          style={{
            [align === 'right' ? 'right' : 'left']: 0,
            [up ? 'bottom' : 'top']: 'calc(100% + 4px)',
            ...(maxH ? { maxHeight: `${maxH}px` } : {}),
          }}
        >
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
