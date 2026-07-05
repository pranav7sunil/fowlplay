# FowlPlay — Architecture

## Overview

Two runtimes, one shared core:

```
┌────────────────────────────────────────────────────────────┐
│ VS Code Extension Host (Node)          src/extension/       │
│  activation, commands, tabs, secret storage, git,           │
│  filesystem tools, provider HTTP calls                      │
│        ▲                                                    │
│        │ postMessage protocol (src/shared/protocol.ts)      │
│        ▼                                                    │
│ Webview UI (Preact + esbuild)          src/webview/         │
│  chat, diff viewer, settings, history, gate cards           │
└────────────────────────────────────────────────────────────┘
          src/core/ — pure TypeScript, no vscode imports:
          staging layer, changeset engine, conversation tree,
          agentic loop, Coop harness state machine, providers,
          context GC, diff model
```

`src/core` is dependency-free of `vscode` so it is unit-testable with vitest and drivable
from a browser harness for Playwright functional tests.

## Directory layout

```
fowlplay/
├── package.json              # extension manifest + scripts
├── esbuild.mjs               # bundles extension (cjs) + webview (iife)
├── src/
│   ├── shared/
│   │   ├── protocol.ts       # host⇄webview message types (single source of truth)
│   │   └── types.ts          # Conversation, ChangeSet, Provider, Harness types
│   ├── core/
│   │   ├── providers/        # ProviderAdapter interface
│   │   │   ├── openaiCompletions.ts   # streaming + tool calls
│   │   │   ├── anthropicMessages.ts   # streaming + tool calls
│   │   │   └── registry.ts            # presets (Ollama, LM Studio, …), model fetch
│   │   ├── staging/
│   │   │   ├── overlay.ts    # virtual FS overlay; read-through; drift detection
│   │   │   ├── changeset.ts  # edits → hunks; cumulative diff; revert; serialize
│   │   │   ├── preview.ts    # artifact detection (best previewable entry file)
│   │   │   └── rebase.ts     # 3-way rebase onto new disk state
│   │   ├── agent/
│   │   │   ├── loop.ts       # agentic loop: stream → tool calls → continue
│   │   │   ├── tools.ts      # tool schemas + dispatch (batch open/edit/search/…)
│   │   │   ├── edits.ts      # precise edit application, fuzzy anchoring, validation
│   │   │   └── contextGc.ts  # garbage collection of stale tool results
│   │   ├── harness/
│   │   │   ├── coop.ts       # pipeline state machine: Scout→Gate→Builder→Inspector→Sentry
│   │   │   ├── roles/        # bundled role prompt markdown
│   │   │   └── evidence.ts   # gate card / evidence record model
│   │   ├── conversation/
│   │   │   ├── tree.ts       # message tree: branches, rewind, fork, siblings
│   │   │   └── serialize.ts  # markdown/JSON export, persistence format
│   │   └── diff/
│   │       └── compute.ts    # line diff (Myers), hunk model for the viewer
│   ├── extension/
│   │   ├── extension.ts      # activate(): commands, tab manager
│   │   ├── tabManager.ts     # webview panels; one session per tab
│   │   ├── session.ts        # wires core loop ⇄ webview ⇄ workspace for one tab
│   │   ├── workspaceIo.ts    # real FS + ripgrep-style search, .gitignore aware
│   │   ├── previewServer.ts  # loopback overlay preview server (token-guarded)
│   │   ├── previewHttp.ts    # pure request logic: path sanitizing + mime map
│   │   ├── git.ts            # commit, co-author trailer, branch state via child git
│   │   ├── secrets.ts        # SecretStorage for API keys
│   │   └── historyStore.ts   # conversations in globalStorage (JSON files)
│   └── webview/
│       ├── index.tsx         # Preact root; view router (chat|diff|preview|settings|history)
│       ├── bridge.ts         # typed postMessage client; mockable for Playwright
│       ├── theme.css         # ultramarine design tokens, light/dark/midnight
│       └── components/      # Chat, Message, ThinkingBlock, ToolCallCard, GateCard,
│                             # DiffViewer, FilePicker, InlineComment, StatusLine,
│                             # ModelPicker, Settings, HistoryPanel, RebaseBanner
├── test/                     # vitest unit tests for src/core
├── e2e/
│   ├── harness.html          # loads webview bundle with MockBridge (scripted host)
│   └── *.spec.mjs            # Playwright: chat flow, diff review, model switch
└── media/                    # icon (ultramarine rooster), codicons
```

## Key design decisions

1. **Protocol-first.** `src/shared/protocol.ts` defines every host⇄webview message.
   Both sides are typed against it; the Playwright MockBridge implements the same
   protocol, so the UI can be functionally tested without VS Code.

2. **Staging overlay as the single write path.** Agent edit tools write only to
   `overlay.ts`. Base snapshots are captured at first touch per file; hunks are computed
   against base, so selective revert = drop hunk and recompute. `Apply to Disk` verifies
   base still matches disk (else rebase flow) then writes atomically.

3. **Reliable edits on weak models** (`edits.ts`): exact match → whitespace-normalized
   match → anchored fuzzy match; on failure the tool returns a structured error with
   nearest-miss context so the model can self-correct in the next round (bounded).

4. **Coop harness = state machine, not agents framework.** `coop.ts` sequences
   role-prompted calls through the same ProviderAdapter, each with its own system prompt
   and restricted toolset (Inspector/Sentry get read-only tools). Events are emitted for
   the UI to render gate cards. Verdicts are structured JSON parsed leniently.

5. **Streaming everywhere.** Adapters normalize provider streams into one event shape:
   `text | thinking | tool_call | usage | done | error`, consumed by both loop and UI.

6. **Persistence**: conversations + changesets serialized to JSON under
   `context.globalStorageUri`; keys in `context.secrets`; settings in
   `workspace.getConfiguration('fowlplay')` + a JSON blob for providers (sans keys).

7. **Overlay preview server** (`previewServer.ts` + `previewHttp.ts`). Staged
   artifacts (HTML/SVG pages and their sibling assets) are previewed *before* they
   touch disk by serving them through the staging overlay. A tiny loopback
   `node:http` server reads a `PreviewSource` (staged content wins; untracked paths
   fall back to raw disk; staged deletes 404), so the "model never touches disk"
   invariant holds. It binds `127.0.0.1` on an ephemeral port and mints one random
   token per instance — every request must carry it as the first path segment
   (`/<token>/…`) or it 404s, which keeps other local processes out. URLs go through
   `vscode.env.asExternalUri` for remote/codespace port forwarding. Markdown entries
   skip the server and render in the webview with the existing `Markdown` component.
   Historical (frozen) previews are disk-backed best-effort — frozen hunks can't
   reconstruct staged content, but the commit was applied to disk anyway. The
   session talks to the server only through the `PreviewPort`/`PreviewSource` ports,
   so it stays vscode-free and unit-testable.

## Build & test toolchain

- **esbuild** for both bundles (extension: cjs/node, webview: iife/browser + css).
- **vitest** for `src/core` + `src/shared`.
- **Playwright** (system chromium) against `e2e/harness.html` via `http-server`.
- **@vscode/vsce** packaging target (`npm run package`) — final deliverable `.vsix`.
- CI-able scripts: `npm run build`, `npm test`, `npm run e2e`, `npm run lint`
  (typecheck via `tsc --noEmit`).

## Ultramarine design tokens (webview/theme.css)

```
--fp-accent:        #4166F5;   /* primary ultramarine */
--fp-accent-deep:   #2743CC;   /* hover / active */
--fp-accent-ink:    #141B7A;   /* dark accents, badges */
--fp-accent-soft:   rgba(65,102,245,.12);
--fp-gradient:      linear-gradient(135deg,#4166F5,#2743CC);
--fp-ok: #2BA84A;  --fp-warn: #E5A50A;  --fp-block: #D93025;
```
Typography and spacing use a clean system font stack for UI, JetBrains Mono for code,
rounded pill buttons with the gradient, generous whitespace, and GitHub-style diff colors.
