/** FowlPlay webview root: store wiring + view router. */
import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import './theme.css';
import type { Conversation } from '../shared/types';
import { activePath, initStore, post, store, useStore } from './components/store';
import { Chat } from './components/Chat';
import { DiffViewer } from './components/DiffViewer';
import { PreviewPanel } from './components/PreviewPanel';
import { Settings } from './components/Settings';
import { HistoryPanel } from './components/HistoryPanel';
import { Onboarding } from './components/Onboarding';
import { Toasts } from './components/Toasts';

/** Files changed = latest changes/commit summary on the active path, else live changeset. */
function deriveChangeCount(conv: Conversation | null, changesetFiles: number): number {
  const path = activePath(conv);
  for (let n = path.length - 1; n >= 0; n--) {
    const blocks = path[n].blocks;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.type === 'changes') return b.summary.filesChanged;
    }
  }
  return changesetFiles;
}

function App() {
  const view = useStore((s) => s.view);
  const settings = useStore((s) => s.settings);
  const conversation = useStore((s) => s.conversation);
  const streaming = useStore((s) => s.streaming);
  const changeset = useStore((s) => s.changeset);
  const preview = useStore((s) => s.preview);
  const rebase = useStore((s) => s.rebase);
  const diffReadOnly = useStore((s) => s.diffReadOnly);
  const commitMessage = useStore((s) => s.commitMessage);
  const historyItems = useStore((s) => s.historyItems);
  const toasts = useStore((s) => s.toasts);

  useEffect(() => {
    initStore();
    post({ type: 'ready' });
  }, []);

  const changeCount = deriveChangeCount(conversation, changeset?.files.length ?? 0);

  return (
    <>
      {view === 'onboarding' && <Onboarding settings={settings} />}
      {view === 'settings' && <Settings settings={settings} />}
      {view === 'history' && <HistoryPanel items={historyItems} />}
      {view === 'diff' &&
        (changeset ? (
          <DiffViewer view={changeset} rebase={rebase} readOnly={diffReadOnly} commitMessage={commitMessage} />
        ) : (
          <div class="fp-empty" style={{ marginTop: 80 }}>No changeset to review.</div>
        ))}
      {view === 'preview' &&
        (preview ? (
          <PreviewPanel state={preview} />
        ) : (
          <div class="fp-empty" style={{ marginTop: 80 }}>Nothing to preview.</div>
        ))}
      {view === 'chat' && (
        <Chat conv={conversation} settings={settings} streaming={streaming} changeCount={changeCount} />
      )}
      <Toasts toasts={toasts} />
    </>
  );
}

// Expose the store so the e2e harness (and debugging) can drive view switches
// without a VS Code host. Harmless in production.
(window as unknown as { __fowlplayStore?: unknown }).__fowlplayStore = store;

const root = document.getElementById('root');
if (root) render(<App />, root);
