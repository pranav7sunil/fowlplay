/** Auto-growing composer with attachments, slash commands, send / stop. */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Attachment } from '../../shared/protocol';
import type { Conversation, FowlPlaySettings, ModelRef, TokenUsage } from '../../shared/types';
import { post, store, useStore } from './store';
import { filterCommands, type SlashCommand } from '../slashCommands';
import { SlashMenu, type SlashItem } from './SlashMenu';
import { IconPaperclip, IconArrowUp, IconStop, IconX } from './icons';

type MenuMode = 'closed' | 'commands' | 'model' | 'export' | 'skills';

/** A rendered menu row plus the action to run when it is chosen. */
interface MenuEntry extends SlashItem {
  run: () => void;
}

function modelLabel(settings: FowlPlaySettings | null, ref: ModelRef | null): string {
  if (!ref) return 'No model selected';
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

export function Composer({ streaming }: { streaming: boolean }) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [menuMode, setMenuMode] = useState<MenuMode>('closed');
  const [highlight, setHighlight] = useState(0);
  const [showStatus, setShowStatus] = useState(false);
  const selection = useStore((s) => s.selectionContext);
  const settings = useStore((s) => s.settings);
  const conv = useStore((s) => s.conversation);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // A freshly pinned "Edit Selection" region means the user wants to talk about
  // it — put the caret in the composer so they can type immediately.
  useEffect(() => {
    if (selection) taRef.current?.focus();
  }, [selection]);

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(220, ta.scrollHeight) + 'px';
  };

  const resetHeight = () => {
    requestAnimationFrame(() => {
      if (taRef.current) taRef.current.style.height = 'auto';
    });
  };

  const send = () => {
    const t = text.trim();
    if (!t && attachments.length === 0) return;
    post({ type: 'sendPrompt', text: t, attachments: attachments.length ? attachments : undefined });
    setText('');
    setAttachments([]);
    setMenuMode('closed');
    resetHeight();
  };

  // -- slash-menu plumbing ----------------------------------------------------
  const clearAndClose = () => {
    setText('');
    setMenuMode('closed');
    setHighlight(0);
    resetHeight();
  };

  const openSubmenu = (mode: Exclude<MenuMode, 'closed' | 'commands'>) => {
    setText('');
    setMenuMode(mode);
    setHighlight(0);
    resetHeight();
  };

  /** /skills: prefill the composer (do not send) and hand focus back. */
  const prefillSkill = (name: string) => {
    const prefill = `Use the "${name}" skill: `;
    setText(prefill);
    setMenuMode('closed');
    setHighlight(0);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(prefill.length, prefill.length);
        grow();
      }
    });
  };

  const runCommand = (cmd: SlashCommand) => {
    switch (cmd.name) {
      case 'clear':
        post({ type: 'newConversation' });
        store.setView('chat');
        clearAndClose();
        break;
      case 'solo':
        post({ type: 'setHarnessMode', mode: 'solo' });
        clearAndClose();
        break;
      case 'coop':
        post({ type: 'setHarnessMode', mode: 'coop' });
        clearAndClose();
        break;
      case 'diff':
        store.openReview();
        clearAndClose();
        break;
      case 'fork':
        post({ type: 'forkConversation' });
        clearAndClose();
        break;
      case 'settings':
        store.setView('settings');
        post({ type: 'getSettings' });
        clearAndClose();
        break;
      case 'history':
        store.setView('history');
        post({ type: 'listConversations' });
        clearAndClose();
        break;
      case 'status':
        setShowStatus(true);
        clearAndClose();
        break;
      case 'model':
        openSubmenu('model');
        break;
      case 'export':
        openSubmenu('export');
        break;
      case 'skills':
        openSubmenu('skills');
        break;
    }
  };

  // Build the current menu rows + their actions from state.
  const buildMenu = (): MenuEntry[] => {
    if (menuMode === 'commands') {
      return filterCommands(text).map((cmd) => ({
        row: { key: cmd.name, title: `/${cmd.name}`, description: cmd.description },
        run: () => runCommand(cmd),
      }));
    }
    const q = text.trim().toLowerCase();
    if (menuMode === 'model') {
      const providers = settings?.providers ?? [];
      const out: MenuEntry[] = [];
      for (const p of providers) {
        let firstInGroup = true;
        for (const m of p.models) {
          const label = m.displayName || m.id;
          if (q && !`${label} ${p.name}`.toLowerCase().includes(q)) continue;
          const active = conv?.model?.providerId === p.id && conv?.model?.modelId === m.id;
          out.push({
            row: { key: `${p.id}::${m.id}`, title: label, active, groupLabel: firstInGroup ? p.name : undefined },
            run: () => {
              post({ type: 'setModel', model: { providerId: p.id, modelId: m.id } });
              clearAndClose();
            },
          });
          firstInGroup = false;
        }
      }
      if (out.length === 0) {
        out.push({
          row: { key: 'none', title: providers.length ? 'No matching models' : 'No providers configured' },
          disabled: true,
          run: () => {},
        });
      }
      return out;
    }
    if (menuMode === 'export') {
      const opts = [
        { key: 'markdown', title: 'Markdown', description: 'Copy the conversation as Markdown', format: 'markdown' as const },
        { key: 'json', title: 'JSON', description: 'Copy the conversation as JSON', format: 'json' as const },
      ].filter((o) => !q || `${o.title} ${o.description}`.toLowerCase().includes(q));
      if (opts.length === 0) {
        return [{ row: { key: 'none', title: 'No matching formats' }, disabled: true, run: () => {} }];
      }
      return opts.map((o) => ({
        row: { key: o.key, title: o.title, description: o.description },
        run: () => {
          post({ type: 'exportConversation', format: o.format });
          clearAndClose();
        },
      }));
    }
    if (menuMode === 'skills') {
      const skills = settings?.skills ?? [];
      if (skills.length === 0) {
        return [{ row: { key: 'none', title: 'No skills discovered' }, disabled: true, run: () => {} }];
      }
      const filtered = skills.filter((s) => !q || `${s.name} ${s.description}`.toLowerCase().includes(q));
      if (filtered.length === 0) {
        return [{ row: { key: 'none', title: 'No matching skills' }, disabled: true, run: () => {} }];
      }
      return filtered.map((s) => ({
        row: { key: s.name, title: s.name, description: s.description },
        run: () => prefillSkill(s.name),
      }));
    }
    return [];
  };

  const menu = buildMenu();
  const menuActive = menuMode !== 'closed';
  const menuVisible = menuActive && menu.length > 0;

  const menuHeader =
    menuMode === 'model'
      ? 'Switch model — Esc to go back'
      : menuMode === 'export'
        ? 'Export as — Esc to go back'
        : menuMode === 'skills'
          ? 'Use a skill — Esc to go back'
          : undefined;

  const runHighlighted = () => {
    const it = menu[Math.min(highlight, menu.length - 1)];
    if (it && !it.disabled) it.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (menuActive) {
      if (e.key === 'ArrowDown' && menu.length) {
        e.preventDefault();
        setHighlight((h) => (h + 1) % menu.length);
        return;
      }
      if (e.key === 'ArrowUp' && menu.length) {
        e.preventDefault();
        setHighlight((h) => (h - 1 + menu.length) % menu.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        // Leading '/' but no command matched → close menu, treat as a prompt.
        if (menuMode === 'commands' && menu.length === 0) {
          setMenuMode('closed');
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!streaming) send();
          }
          return;
        }
        e.preventDefault();
        runHighlighted();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (menuMode === 'commands') {
          setMenuMode('closed');
        } else {
          // Second-level → back to the command list.
          setMenuMode('commands');
          setText('/');
          setHighlight(0);
          resetHeight();
        }
        return;
      }
      // Any other key falls through so typing continues to filter.
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!streaming) send();
    } else if (e.key === 'Escape' && streaming) {
      e.preventDefault();
      post({ type: 'cancelResponse' });
    }
  };

  const onInput = (e: Event) => {
    const value = (e.target as HTMLTextAreaElement).value;
    setText(value);
    grow();
    setHighlight(0);
    if (menuMode === 'model' || menuMode === 'export' || menuMode === 'skills') return; // keep filtering the submenu
    setMenuMode(value.startsWith('/') ? 'commands' : 'closed');
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
      {showStatus && <StatusCard conv={conv} settings={settings} onClose={() => setShowStatus(false)} />}
      {selection && (
        <div class="fp-attachments">
          <span class="fp-attach-chip fp-selection-chip" title={`${selection.path}:${selection.startLine}-${selection.endLine}`}>
            ⌗ {(selection.path.split('/').pop() || selection.path)}:{selection.startLine}-{selection.endLine}
            <button type="button" class="fp-btn-ghost" style={{ padding: 0 }} onClick={() => post({ type: 'clearSelection' })} aria-label="Clear selection">
              <IconX size={13} />
            </button>
          </span>
        </div>
      )}
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
      {menuVisible && (
        <SlashMenu
          items={menu}
          highlight={highlight}
          header={menuHeader}
          onHover={setHighlight}
          onSelect={(i) => {
            const it = menu[i];
            if (it && !it.disabled) it.run();
          }}
        />
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
            placeholder="Ask FowlPlay to make a change…  (/ for commands)"
            rows={1}
            value={text}
            onInput={onInput}
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

const EMPTY_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };

/**
 * Ephemeral /status card — local UI only, never persisted or sent to the model.
 * Mirrors StatusLine's context computation (approx live context = the most
 * recent assistant node's input tokens, falling back to cumulative input).
 */
function StatusCard({
  conv,
  settings,
  onClose,
}: {
  conv: Conversation | null;
  settings: FowlPlaySettings | null;
  onClose: () => void;
}) {
  const model = conv?.model ?? settings?.defaultModel ?? null;
  const totals = conv?.usageTotals ?? EMPTY_USAGE;
  const ctx = contextWindowFor(settings, model);
  const nodes = conv ? Object.values(conv.nodes) : [];
  const lastInput =
    nodes.filter((n) => n.usage).sort((a, b) => b.createdAt - a.createdAt)[0]?.usage?.inputTokens ?? totals.inputTokens;
  const pct = ctx ? Math.min(100, Math.round((lastInput / ctx) * 100)) : 0;
  const mode = conv?.harnessMode ?? settings?.harness.defaultMode ?? 'coop';

  return (
    <div class="fp-status-card">
      <div class="fp-status-card-head">
        <span>Session status</span>
        <button type="button" class="fp-btn-ghost" style={{ padding: 0 }} onClick={onClose} aria-label="Dismiss status">
          <IconX size={14} />
        </button>
      </div>
      <div class="fp-status-card-rows">
        <div class="fp-status-row"><span class="fp-status-key">Model</span><span>{modelLabel(settings, model)}</span></div>
        <div class="fp-status-row"><span class="fp-status-key">Mode</span><span>{mode === 'coop' ? 'Coop (pipeline)' : 'Solo (direct)'}</span></div>
        <div class="fp-status-row">
          <span class="fp-status-key">Context</span>
          <span>
            {ctx
              ? `~${fmt(lastInput)} / ${fmt(ctx)} tokens (${pct}%)`
              : 'context window unknown — set it in Settings → provider'}
          </span>
        </div>
        <div class="fp-status-row">
          <span class="fp-status-key">Tokens</span>
          <span class="fp-tokens">↑{fmt(totals.inputTokens)} in · ↓{fmt(totals.outputTokens)} out · ⚡{fmt(totals.cachedTokens)} cached</span>
        </div>
      </div>
    </div>
  );
}
