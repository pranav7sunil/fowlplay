/** GitHub-style diff review with revert, inline comments, keyboard nav, commit. */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ChangeSetView, FileDiff, DiffHunk, RebaseState } from '../../shared/types';
import { Dropdown, Modal } from './common';
import { post, store } from './store';
import { IconX, IconChevronDown, IconFile, IconCheck, IconGit, IconAlert } from './icons';

interface FlatHunk {
  file: FileDiff;
  hunk: DiffHunk;
  key: string;
}

export function DiffViewer({
  view,
  rebase,
  readOnly,
  commitMessage,
}: {
  view: ChangeSetView;
  rebase: RebaseState;
  readOnly: boolean;
  commitMessage: string;
}) {
  const flat: FlatHunk[] = useMemo(
    () => view.files.flatMap((f) => f.hunks.map((h) => ({ file: f, hunk: h, key: h.id }))),
    [view],
  );
  const [active, setActive] = useState(0);
  const [showCommit, setShowCommit] = useState(false);
  const hunkRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const fileRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const bodyRef = useRef<HTMLDivElement>(null);

  const hasFeedback = view.files.some((f) => f.hunks.some((h) => h.reverted || (h.comment && h.comment.length > 0)));

  const close = () => store.setView('chat');

  // Keyboard navigation: j/k + arrows move active hunk; Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      if (e.key === 'Escape') { close(); return; }
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(flat.length - 1, a + 1));
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [flat.length]);

  useEffect(() => {
    const el = hunkRefs.current[flat[active]?.key];
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [active, flat]);

  const jumpToFile = (path: string) => {
    fileRefs.current[path]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const idx = flat.findIndex((f) => f.file.path === path);
    if (idx >= 0) setActive(idx);
  };

  return (
    <div class="fp-diff">
      <div class="fp-diff-header">
        <Dropdown
          trigger={(open, toggle) => (
            <button type="button" class="fp-btn fp-btn-secondary fp-btn-sm" onClick={toggle}>
              <IconFile size={14} /> {view.files.length} files <IconChevronDown size={13} />
            </button>
          )}
        >
          {(closeMenu) => (
            <>
              {view.files.map((f) => (
                <button key={f.path} type="button" class="fp-menu-item" onClick={() => { jumpToFile(f.path); closeMenu(); }}>
                  <IconFile size={14} />
                  <span style={{ flex: 1, fontFamily: 'var(--fp-font)' }}>{f.path}</span>
                  <span class="fp-add">+{f.additions}</span>
                  <span class="fp-del">-{f.deletions}</span>
                </button>
              ))}
            </>
          )}
        </Dropdown>
        <span class="fp-diff-position">
          Change {flat.length === 0 ? 0 : active + 1} of {flat.length}
        </span>
        <div class="fp-spacer" />
        <span class="fp-tokens" style={{ fontSize: '13px' }}>
          <span class="fp-add">+{view.additions}</span> <span class="fp-del">-{view.deletions}</span>
        </span>
        <button type="button" class="fp-icon-btn" onClick={close} aria-label="Close diff (Esc)"><IconX /></button>
      </div>

      {readOnly && (
        <div class="fp-banner fp-banner-readonly">
          <IconGit size={16} /> Viewing committed changes from history
        </div>
      )}
      {!readOnly && rebase.needed && (
        <div class="fp-banner fp-banner-rebase">
          <IconAlert size={16} />
          <span style={{ flex: 1 }}>
            The base changed under your staged edits{rebase.conflictedPaths.length ? ` (${rebase.conflictedPaths.join(', ')})` : ''}.
          </span>
          <button type="button" class="fp-btn fp-btn-secondary fp-btn-sm" onClick={() => post({ type: 'rebase' })}>Rebase</button>
        </div>
      )}

      <div class="fp-diff-body" ref={bodyRef}>
        <div class="fp-diff-body-inner">
          {view.files.map((f) => (
            <div class="fp-file" key={f.path} ref={(el) => { fileRefs.current[f.path] = el; }}>
              <div class="fp-file-head">
                <span class={`fp-chip fp-file-kind`}>{f.kind}</span>
                <span class="fp-file-path">{f.path}</span>
                <div class="fp-spacer" />
                <span class="fp-add">+{f.additions}</span>
                <span class="fp-del">-{f.deletions}</span>
              </div>
              {f.hunks.map((h) => {
                const idx = flat.findIndex((x) => x.key === h.id);
                return (
                  <HunkView
                    key={h.id}
                    hunk={h}
                    active={idx === active}
                    readOnly={readOnly}
                    onActivate={() => setActive(idx)}
                    registerRef={(el) => (hunkRefs.current[h.id] = el)}
                  />
                );
              })}
            </div>
          ))}
          {flat.length === 0 && <div class="fp-empty">No changes staged.</div>}
        </div>
      </div>

      <div class="fp-diff-footer">
        <button
          type="button"
          class="fp-btn fp-btn-secondary"
          disabled={readOnly || !hasFeedback}
          onClick={() => post({ type: 'sendFeedback' })}
        >
          Send Feedback
        </button>
        <div class="fp-spacer" />
        <button type="button" class="fp-btn fp-btn-secondary" disabled={readOnly} onClick={() => post({ type: 'applyToDisk' })}>
          Apply to Disk
        </button>
        <button
          type="button"
          class="fp-btn fp-btn-primary"
          disabled={readOnly}
          onClick={() => { post({ type: 'requestCommitMessage' }); setShowCommit(true); }}
        >
          Apply &amp; Commit…
        </button>
      </div>

      {showCommit && <CommitModal initial={commitMessage} onClose={() => setShowCommit(false)} />}
    </div>
  );
}

function HunkView({
  hunk,
  active,
  readOnly,
  onActivate,
  registerRef,
}: {
  hunk: DiffHunk;
  active: boolean;
  readOnly: boolean;
  onActivate: () => void;
  registerRef: (el: HTMLDivElement | null) => void;
}) {
  const [commenting, setCommenting] = useState(false);
  const [draft, setDraft] = useState(hunk.comment ?? '');

  const rows: { sign: ' ' | '+' | '-'; base?: number; staged?: number; text: string }[] = [];
  const ctxBeforeBase = hunk.baseStart - hunk.contextBefore.length;
  const ctxBeforeStaged = hunk.stagedStart - hunk.contextBefore.length;
  hunk.contextBefore.forEach((t, i) => rows.push({ sign: ' ', base: ctxBeforeBase + i, staged: ctxBeforeStaged + i, text: t }));
  hunk.baseLines.forEach((t, i) => rows.push({ sign: '-', base: hunk.baseStart + i, text: t }));
  hunk.stagedLines.forEach((t, i) => rows.push({ sign: '+', staged: hunk.stagedStart + i, text: t }));
  const afterBase = hunk.baseStart + hunk.baseLines.length;
  const afterStaged = hunk.stagedStart + hunk.stagedLines.length;
  hunk.contextAfter.forEach((t, i) => rows.push({ sign: ' ', base: afterBase + i, staged: afterStaged + i, text: t }));

  const saveComment = () => {
    const c = draft.trim();
    post({ type: 'setComment', hunkId: hunk.id, comment: c || null });
    setCommenting(false);
  };

  return (
    <div class={`fp-hunk ${active ? 'active' : ''} ${hunk.reverted ? 'reverted' : ''}`} ref={registerRef}>
      {!readOnly && (
        <div class="fp-hunk-toolbar">
          <label class="fp-checkbox">
            <input
              type="checkbox"
              checked={hunk.reverted}
              onChange={(e) => post({ type: 'toggleRevert', hunkId: hunk.id, reverted: (e.target as HTMLInputElement).checked })}
            />
            Revert this hunk
          </label>
          <div class="fp-spacer" />
          <button type="button" class="fp-btn-ghost fp-btn-sm" onClick={() => { setDraft(hunk.comment ?? ''); setCommenting(true); }}>
            {hunk.comment ? 'Edit comment' : 'Comment'}
          </button>
        </div>
      )}
      <table class="fp-difftable" onClick={onActivate}>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} class={`fp-diff-line ${r.sign === '+' ? 'fp-line-add' : r.sign === '-' ? 'fp-line-del' : ''}`} onClick={() => !readOnly && setCommenting(true)}>
              <td class="fp-gutter">{r.base ?? ''}</td>
              <td class="fp-gutter">{r.staged ?? ''}</td>
              <td class="fp-line-sign">{r.sign === ' ' ? '' : r.sign}</td>
              <td>{r.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {hunk.comment && !commenting && (
        <div class="fp-comment-bubble">
          <div class="fp-comment-label">Your comment</div>
          <div>{hunk.comment}</div>
        </div>
      )}
      {commenting && (
        <div class="fp-comment-box">
          <textarea
            class="fp-textarea"
            rows={2}
            autofocus
            placeholder="Leave feedback on this change…"
            value={draft}
            onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveComment(); }
              if (e.key === 'Escape') setCommenting(false);
            }}
          />
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
            <button type="button" class="fp-btn fp-btn-secondary fp-btn-sm" onClick={() => setCommenting(false)}>Cancel</button>
            <button type="button" class="fp-btn fp-btn-primary fp-btn-sm" onClick={saveComment}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

function CommitModal({ initial, onClose }: { initial: string; onClose: () => void }) {
  const [msg, setMsg] = useState(initial);
  const [coAuthor, setCoAuthor] = useState(true);

  // Adopt an auto-generated message when it arrives while the field is empty.
  const liveMsg = store.state.commitMessage;
  useEffect(() => {
    if (!msg && liveMsg) setMsg(liveMsg);
  }, [liveMsg]);

  return (
    <Modal title="Apply & Commit" onClose={onClose}>
      <div class="fp-field">
        <label>Commit message</label>
        <textarea class="fp-textarea" rows={4} value={msg} onInput={(e) => setMsg((e.target as HTMLTextAreaElement).value)} autofocus />
      </div>
      <label class="fp-checkbox">
        <input type="checkbox" checked={coAuthor} onChange={(e) => setCoAuthor((e.target as HTMLInputElement).checked)} />
        Add <code class="fp-inline-code">Co-authored-by: FowlPlay</code> trailer
      </label>
      <div class="fp-modal-actions">
        <button type="button" class="fp-btn fp-btn-secondary" onClick={onClose}>Cancel</button>
        <button
          type="button"
          class="fp-btn fp-btn-primary"
          onClick={() => { post({ type: 'applyAndCommit', message: msg.trim() || undefined, coAuthor }); onClose(); }}
        >
          <IconCheck size={15} /> Commit
        </button>
      </div>
    </Modal>
  );
}
