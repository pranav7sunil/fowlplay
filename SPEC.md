# FowlPlay — Specification

FowlPlay is an AI coding partner for Visual Studio Code that combines two core features:

1. **Interactability** — collaborative, synchronous, diff-first AI coding with an in-memory
   staging layer, so nothing ever touches disk without review.
2. **A verification harness** — a role-based, gated pipeline with stop-the-line authority
   and evidence-based delivery, so local and self-hosted models produce reliable results.

The thesis: local/open-weight models are good enough for daily IDE work *when a harness
verifies their output before a human sees it*. FowlPlay runs a gated verification pipeline
between your prompt and the staging layer; the human diff review is the final HITL gate.

Visual identity: FowlPlay is clean, minimal, fast, and **ultramarine blue** (primary
`#4166F5`, deep `#2743CC`, ink `#141B7A`).

---

## 1. Chat (the primary interface)

- Chat opens as a **webview tab in the editor area**, plus an activity-bar icon.
  Keybinding: `Ctrl+Alt+F` / `Cmd+Alt+F` ("FowlPlay: Open Tab"), command palette entries.
- Natural-language prompts; responses render **markdown with syntax-highlighted code
  blocks**, tables, and collapsible **thinking blocks** (with duration) when the model emits
  reasoning.
- **Agentic loop**: on each prompt the model thinks, calls tools (read/search/edit), and
  iterates until done. Every tool call is rendered live in the chat as a collapsible step —
  the workflow is synchronous and observable. `Escape` / stop button cancels mid-response.
- **Batch operations**: tools accept arrays (open N files in one call, apply N edits in one
  call) to minimize round-trips.
- **Workspace awareness**: the agent locates files itself (glob + grep + list tools,
  respecting `.gitignore`). Users mention files in plain text — no `@` syntax.
- **Token awareness**: status line shows context-window usage; per-conversation cumulative
  input/output/cached token counts.
- **Context management — garbage collection, not compaction**: after each turn, stale file
  contents and processed tool results are trimmed from the transcript sent to the model;
  conversation text is preserved.

## 2. Staging layer (safety model)

- The model **never writes to disk**. All edits land in an in-memory virtual overlay
  (per-tab). Reads through the agent tools see the overlay state, so edits stack coherently
  across turns as a cumulative **changeset**.
- Edit primitives: single precise replace, batch multi-file edits, find-and-replace
  (optional regex), file create, file delete.
- Overlay detects when disk content drifts under a staged edit (external change / another
  tab applied) → **rebase banner**; automatic rebase, model-assisted conflict resolution.

## 3. Diff review (the HITL gate)

- **GitHub-style diff viewer**: per-file diffs of the full changeset; file picker in header;
  change navigation with `j`/`k`/arrows; footer position indicator ("Change 3 of 12").
- **Inline comments** on any change; **selective revert** checkboxes per change
  (cherry-picking); **Send Feedback** returns all comments + reverts to the model as a new
  prompt that revises the changeset without re-applying reverted changes.
- **Apply to Disk** (no commit) and **Apply & Commit…** (auto-generated commit message,
  editable, optional `Co-authored-by: FowlPlay` trailer).
- Entry points: "Review Changes" block in chat, changes indicator in the title bar,
  "View Changes" on historical commit blocks (read-only mode with banner).

## 4. Chat history & branching (conversation as feature branch)

- Conversation is a **tree**: edit a past user message → new branch (original preserved);
  **rerun** a response → sibling; **rewind** to an earlier point; branch indicators +
  navigation on messages with siblings.
- **Fork / duplicate** a conversation into a new tab — the staging layer state is copied
  along with the messages so chat and workspace stay self-consistent.
- Multiple tabs: each tab is an isolated conversation + staging layer + model selection.
- History panel: search by title, resume, rename, delete, **Copy as Markdown / JSON**.
- Conversations auto-save to extension global storage.

## 5. Providers & models (bring your own key, local first)

- **No built-in model.** Provider types:
  - **API-key providers** — presets for OpenAI, Anthropic, Google, Mistral, DeepSeek,
    OpenRouter, MiniMax, Z.ai, Moonshot.
  - **Local models** — presets: Ollama (`http://localhost:11434/v1`), LM Studio
    (`http://localhost:1234/v1`), llama.cpp (`http://localhost:8080/v1`), mlx-lm. No API
    key required. *This is the primary deployment target.*
  - **Custom** — any endpoint speaking OpenAI or Anthropic API format.
- **SDK types**: `openai-completions` (Chat Completions, the lingua franca of local
  servers), `anthropic` (Messages API). Streaming + tool calling on both.
- API keys in **VS Code secret storage**; never leave the machine.
- **Model management**: auto-fetch model list (`/models`), manual add, display names,
  remove.
- **Model switcher in the status line** — switch provider/model mid-conversation; history
  and staged edits carry over across API formats.

## 6. The Coop harness

Two run modes, toggleable per tab from the status line:

- **Solo mode** — the plain agentic loop: prompt → agentic loop → changeset → review.
- **Coop mode** (default for local models) — the verification pipeline runs the roles below as
  separate role-prompted calls to the *same* configured model, each stage rendered in chat
  as a **gate card** with pass/fail and evidence:
  1. **Scout (BSA)** — restates the request as acceptance criteria + a short task plan.
  2. **Stop-the-line gate** — hard gate: no implementation until acceptance criteria exist;
     ambiguous requests halt with a clarifying question instead of guessing.
  3. **Builder (implementer)** — runs the agentic loop, producing the staged changeset.
  4. **Inspector (QAS)** — independent validation of the changeset against the acceptance
     criteria (reads the diff fresh; no shared reasoning with Builder). Verdict: approve or
     route back to Builder with findings (bounded retries).
  5. **Sentry (security)** — reviews the diff for injection, secrets, unsafe patterns.
     Cannot be bypassed in Coop mode.
  6. **HITL gate** — the diff viewer. The human is the final authority, always.
- **Stop-the-line authority**: any stage can halt the pipeline with a blocker card stating
  the concern; the user resolves or overrides.
- **Evidence-based delivery**: every gate card records what was checked and why it passed —
  "trust me, it works" is not acceptable output.
- Role prompts are markdown files bundled with the extension and overridable per workspace
  (`.fowlplay/roles/*.md`).

## 7. Settings

Settings panel (from the chat title bar), three tabs:
- **Appearance** — font (JetBrains Mono default, Fira Code, custom), font scale, theme
  (VS Code inherited default; FowlPlay Dark; FowlPlay Light; FowlPlay Midnight — all
  ultramarine-accented).
- **Models & Providers** — add/edit/delete providers, manage models.
- **Harness** — Coop/Solo default, per-role model overrides, QAS retry budget, role prompt
  locations.

## 8. Non-goals

No MCP, no CLI, no AGENTS.md format, no @-references/slash commands, no sub-agent
delegation beyond the fixed Coop roles. Complexity must justify itself.

## 9. Quality bars

- Precise diff edits must work reliably on weaker/local models (edit-tool prompt + fuzzy
  anchor matching + validation with automatic retry-on-mismatch).
- Webview UI: smooth, fast, small; renders markdown/code beautifully.
- Unit-tested core (staging layer, changeset/diff engine, tool loop, harness state
  machine, provider adapters) + Playwright-driven functional checks of the real UI.
