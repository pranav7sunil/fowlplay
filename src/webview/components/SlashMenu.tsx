/**
 * Codex-style slash-command popup, anchored above the composer.
 *
 * Presentational only: the Composer computes the rows (command list or a
 * second-level picker), owns the highlight + keyboard handling, and passes an
 * onSelect/onHover pair. Rows carry an optional group label (provider name),
 * an active checkmark (current model) and a disabled flag (placeholder rows).
 */
import { Fragment } from 'preact';
import type { ComponentChildren } from 'preact';
import { IconCheck } from './icons';

export interface SlashRow {
  key: string;
  title: string;
  description?: string;
  /** Renders a group label above this row (e.g. provider name in /model). */
  groupLabel?: string;
  /** Renders a checkmark (e.g. the currently-selected model). */
  active?: boolean;
}

export interface SlashItem {
  row: SlashRow;
  disabled?: boolean;
}

export function SlashMenu({
  items,
  highlight,
  header,
  onHover,
  onSelect,
}: {
  items: SlashItem[];
  highlight: number;
  header?: ComponentChildren;
  onHover: (index: number) => void;
  onSelect: (index: number) => void;
}) {
  return (
    <div class="fp-slash-anchor">
      {/* preventDefault on mousedown keeps focus in the textarea through a click */}
      <div class="fp-slash-menu" role="listbox" onMouseDown={(e) => e.preventDefault()}>
        {header && <div class="fp-slash-header">{header}</div>}
        {items.map((it, i) => (
          <Fragment key={it.row.key}>
            {it.row.groupLabel && <div class="fp-menu-group-label">{it.row.groupLabel}</div>}
            <button
              type="button"
              role="option"
              aria-selected={i === highlight}
              disabled={it.disabled}
              class={`fp-slash-item ${i === highlight ? 'active' : ''} ${it.disabled ? 'disabled' : ''}`}
              onMouseEnter={() => onHover(i)}
              onClick={() => {
                if (!it.disabled) onSelect(i);
              }}
            >
              {it.row.active ? <IconCheck size={15} /> : null}
              <span class="fp-slash-name">{it.row.title}</span>
              {it.row.description && <span class="fp-slash-desc">{it.row.description}</span>}
            </button>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
