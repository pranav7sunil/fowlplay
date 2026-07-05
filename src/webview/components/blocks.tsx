/** Assistant content-block renderers. */
import type { JSX } from 'preact';
import type { ContentBlock, ToolCallRecord, GateCard, CoopRole, GateStatus, PrdPlan, PrdStoryStatus } from '../../shared/types';
import type { WebviewToHost } from '../../shared/protocol';
import { Markdown, Collapsible } from './common';
import {
  IconCheck, IconX, IconWrench, IconCompass, IconHammer, IconEye, IconShield,
  IconDiff, IconGit, IconAlert, IconArrowRight, IconArrowUp, IconChevronRight, IconFile,
} from './icons';
import { post, store, useStore } from './store';

export function BlockView({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case 'text':
      return <Markdown text={block.text} />;
    case 'thinking':
      return <ThinkingBlock text={block.text} durationMs={block.durationMs} />;
    case 'tool_call':
      return <ToolCallCard call={block.call} />;
    case 'gate':
      return <GateCardView card={block.card} />;
    case 'changes':
      return <ChangesBlock summary={block.summary} />;
    case 'commit':
      return <CommitBlock commit={block.commit} />;
    case 'plan':
      return <PlanBlock />;
    case 'error':
      return <ErrorBlock message={block.message} />;
  }
}

function fmtDuration(ms?: number): string {
  if (!ms) return '';
  return ` for ${(ms / 1000).toFixed(1)}s`;
}

/** Compact token count, e.g. 1234 → "1.2k". Local to avoid cross-component imports. */
function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

/** Last path segment, for compact Preview button labels. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function ThinkingBlock({ text, durationMs }: { text: string; durationMs?: number }) {
  return (
    <Collapsible
      className="fp-thinking"
      title={<span>Thought{fmtDuration(durationMs)}</span>}
    >
      <Markdown text={text} />
    </Collapsible>
  );
}

function argsPreview(args: unknown): string {
  if (typeof args === 'string') return args.slice(0, 80);
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function prettyArgs(args: unknown): string {
  if (typeof args === 'string') {
    try {
      return JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      return args;
    }
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

export function ToolCallCard({ call }: { call: ToolCallRecord }) {
  const summary = call.resultSummary || argsPreview(call.args);
  return (
    <Collapsible
      className="fp-tool"
      title={
        <>
          <IconWrench size={15} />
          <span class="fp-tool-name">{call.name}</span>
          <span class="fp-tool-summary">{summary}</span>
          <span class="fp-tool-status">
            {call.ok ? <IconCheck size={15} style={{ color: 'var(--fp-ok)' }} /> : <IconX size={15} style={{ color: 'var(--fp-block)' }} />}
          </span>
        </>
      }
    >
      <div class="fp-gate-section-label">Arguments</div>
      <pre class="fp-pre"><code>{prettyArgs(call.args)}</code></pre>
      {call.resultSummary && (
        <>
          <div class="fp-gate-section-label" style={{ marginTop: 10 }}>Result</div>
          <Markdown text={call.resultSummary} />
        </>
      )}
    </Collapsible>
  );
}

const ROLE_ICON: Record<CoopRole | 'stop-the-line' | 'hitl' | 'foreman', (p: { size?: number }) => JSX.Element> = {
  scout: IconCompass,
  builder: IconHammer,
  inspector: IconEye,
  sentry: IconShield,
  'stop-the-line': IconAlert,
  hitl: IconEye,
  foreman: IconFile,
};

function StatusChip({ status }: { status: GateStatus }) {
  const label: Record<GateStatus, string> = {
    running: 'Running',
    passed: 'Passed',
    failed: 'Failed',
    blocked: 'Blocked',
    skipped: 'Skipped',
    awaiting: 'Your review',
  };
  const icon =
    status === 'passed' ? <IconCheck size={13} /> :
    status === 'failed' ? <IconX size={13} /> :
    status === 'running' ? <span class="fp-dot" /> :
    status === 'blocked' ? <IconAlert size={13} /> :
    status === 'awaiting' ? <IconArrowUp size={13} /> : null;
  return (
    <span class={`fp-status-chip fp-status-${status}`}>
      {icon}
      {label[status]}
    </span>
  );
}

export function GateCardView({ card }: { card: GateCard }) {
  const Icon = ROLE_ICON[card.role] ?? IconWrench;
  return (
    <div class="fp-gate">
      <div class="fp-gate-head">
        <span class="fp-gate-icon"><Icon size={17} /></span>
        <span class="fp-gate-title">{card.title}</span>
        {card.modelLabel && <span class="fp-gate-model" title={`Ran on ${card.modelLabel}`}>{card.modelLabel}</span>}
        {card.attempt && card.attempt > 1 && <span class="fp-chip">attempt {card.attempt}</span>}
        <StatusChip status={card.status} />
      </div>
      <div class="fp-gate-body">
        {card.acceptanceCriteria && card.acceptanceCriteria.length > 0 && (
          <div>
            <div class="fp-gate-section-label">Acceptance criteria</div>
            <ul class="fp-checklist">
              {card.acceptanceCriteria.map((c, i) => (
                <li key={i}><IconCheck size={15} />{c}</li>
              ))}
            </ul>
          </div>
        )}
        {card.evidence && (
          <Collapsible title={<span>Evidence</span>} defaultOpen={card.status === 'running' || card.status === 'failed'}>
            <Markdown text={card.evidence} />
          </Collapsible>
        )}
        {card.findings && card.findings.length > 0 && (
          <div>
            <div class="fp-gate-section-label">Findings</div>
            <ul class="fp-findings">
              {card.findings.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </div>
        )}
        {card.role === 'hitl' && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" class="fp-btn fp-btn-primary fp-btn-sm" onClick={() => store.openReview()}>
              <IconDiff size={15} /> Review Changes
            </button>
            {card.previewPath && (
              <button type="button" class="fp-btn fp-btn-secondary fp-btn-sm" onClick={() => store.openPreview(card.previewPath)}>
                <IconEye size={15} /> Preview {basename(card.previewPath)}
              </button>
            )}
          </div>
        )}
        {card.usage && (card.usage.inputTokens > 0 || card.usage.outputTokens > 0) && (
          <div
            class="fp-gate-usage"
            style={{ fontSize: '11px', color: 'var(--fp-fg-muted)', fontFamily: 'var(--fp-font)' }}
          >
            ↑{fmtTokens(card.usage.inputTokens)} ↓{fmtTokens(card.usage.outputTokens)}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChangesBlock({
  summary,
}: {
  summary: { changesetId: string; filesChanged: number; additions: number; deletions: number; previewPath?: string };
}) {
  return (
    <div class="fp-changes">
      <span class="fp-gate-icon"><IconDiff size={17} /></span>
      <div class="fp-changes-stats">
        <div class="fp-changes-title">Review Changes</div>
        <div class="fp-changes-meta">
          {summary.filesChanged} {summary.filesChanged === 1 ? 'file' : 'files'} changed{' '}
          <span class="fp-add">+{summary.additions}</span> <span class="fp-del">-{summary.deletions}</span>
        </div>
      </div>
      {summary.previewPath && (
        <button type="button" class="fp-btn fp-btn-secondary" onClick={() => store.openPreview(summary.previewPath)}>
          <IconEye size={16} /> Preview
        </button>
      )}
      <button type="button" class="fp-btn fp-btn-primary" onClick={() => store.openReview(summary.changesetId)}>
        <IconDiff size={16} /> Review Changes
      </button>
    </div>
  );
}

export function CommitBlock({
  commit,
}: {
  commit: { sha: string; message: string; changesetId: string; filesChanged: number; previewPath?: string };
}) {
  return (
    <div class="fp-commit">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <IconGit size={16} style={{ color: 'var(--fp-accent)' }} />
        <span class="fp-commit-sha">{commit.sha.slice(0, 8)}</span>
        <span style={{ color: 'var(--fp-fg-muted)', fontSize: '12px' }}>{commit.filesChanged} files</span>
      </div>
      <div class="fp-commit-msg">{commit.message}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <button type="button" class="fp-btn-ghost" onClick={() => store.openReview(commit.changesetId, true)} style={{ padding: 0, color: 'var(--fp-accent)' }}>
          View Changes <IconArrowRight size={14} />
        </button>
        {commit.previewPath && (
          <button type="button" class="fp-btn-ghost" onClick={() => store.openPreview(commit.previewPath, commit.changesetId)} style={{ padding: 0, color: 'var(--fp-accent)' }}>
            <IconEye size={14} /> Preview
          </button>
        )}
      </div>
    </div>
  );
}

const PLAN_GLYPH: Record<PrdStoryStatus, JSX.Element> = {
  pending: <span class="fp-plan-glyph fp-plan-pending">○</span>,
  building: <span class="fp-plan-glyph fp-plan-building fp-dot" />,
  'awaiting-review': <span class="fp-plan-glyph fp-plan-awaiting">◉</span>,
  done: <span class="fp-plan-glyph fp-plan-done">✓</span>,
  failed: <span class="fp-plan-glyph fp-plan-failed">✕</span>,
};

/** A PRD-plan action button descriptor (label + the message it posts). */
export interface PlanAction {
  label: string;
  message: WebviewToHost;
  variant: 'primary' | 'secondary';
}

/** Human status word for the cursor story, shown in the pinned bar. */
const STORY_STATUS_WORD: Record<PrdStoryStatus, string> = {
  pending: 'pending',
  building: 'building',
  'awaiting-review': 'awaiting review',
  done: 'done',
  failed: 'failed',
};

/**
 * The actions offered for a plan's cursor story — the single source of truth shared by the
 * plan block and the pinned bar so their buttons can't drift. Empty while streaming or when
 * the cursor story is not actionable (building/done). A failed story offers Retry (primary) +
 * Skip + Mark done (secondary); pending offers Resume + Mark done; awaiting-review offers
 * Continue. Retry and Resume both post `retryStory` — one host code path re-runs the cursor
 * story. "Mark done" (posts `markStoryDone`) lets the human reconcile a story reality outran —
 * e.g. a cancelled build whose staged changes already satisfy it.
 */
export function planActions(plan: PrdPlan, streaming: boolean): PlanAction[] {
  if (streaming) return [];
  const cursorStory = plan.stories[plan.cursor];
  if (!cursorStory) return [];
  switch (cursorStory.status) {
    case 'failed':
      return [
        { label: 'Retry story', message: { type: 'retryStory' }, variant: 'primary' },
        { label: 'Skip story', message: { type: 'continueStoryLoop' }, variant: 'secondary' },
        { label: 'Mark done', message: { type: 'markStoryDone' }, variant: 'secondary' },
      ];
    case 'pending':
      return [
        { label: `Resume story ${plan.cursor + 1}`, message: { type: 'retryStory' }, variant: 'primary' },
        { label: 'Mark done', message: { type: 'markStoryDone' }, variant: 'secondary' },
      ];
    case 'awaiting-review':
      return [{ label: 'Continue — next story', message: { type: 'continueStoryLoop' }, variant: 'primary' }];
    default:
      return [];
  }
}

function PlanActionButtons({ plan, streaming }: { plan: PrdPlan; streaming: boolean }) {
  const actions = planActions(plan, streaming);
  if (actions.length === 0) return null;
  return (
    <>
      {actions.map((a) => (
        <button
          key={a.label}
          type="button"
          class={`fp-btn fp-btn-sm ${a.variant === 'primary' ? 'fp-btn-primary' : 'fp-btn-secondary'}`}
          onClick={() => post(a.message)}
        >
          {a.variant === 'primary' && <IconArrowRight size={15} />} {a.label}
        </button>
      ))}
    </>
  );
}

/**
 * PRD build plan — a marker block that renders LIVE from the conversation's `prdPlan`
 * (statuses advance across turns; the block itself is only a snapshot placeholder). Shows a
 * story checklist with status glyphs, an "N of M done" header, and — via {@link planActions}
 * — the cursor story's action buttons (Retry/Skip, Resume, or Continue) when not streaming.
 */
export function PlanBlock() {
  const conv = useStore((s) => s.conversation);
  const streaming = useStore((s) => s.streaming);
  const plan = conv?.prdPlan;
  if (!plan || plan.stories.length === 0) return null;

  const done = plan.stories.filter((s) => s.status === 'done').length;
  const actions = planActions(plan, streaming);

  return (
    <div class="fp-plan">
      <div class="fp-plan-head">
        <span class="fp-gate-icon"><IconFile size={17} /></span>
        <span class="fp-plan-title">PRD build</span>
        <span class="fp-plan-count">{done} of {plan.stories.length} done</span>
      </div>
      <ol class="fp-plan-list">
        {plan.stories.map((s, i) => (
          <li key={i} class={`fp-plan-story${i === plan.cursor ? ' fp-plan-cursor' : ''}`}>
            {PLAN_GLYPH[s.status]}
            <span class="fp-plan-story-title">{s.title}</span>
          </li>
        ))}
      </ol>
      {actions.length > 0 && (
        <div class="fp-plan-actions">
          <PlanActionButtons plan={plan} streaming={streaming} />
        </div>
      )}
    </div>
  );
}

/**
 * A pinned, one-line PRD status bar rendered between the transcript and the composer whenever
 * a PRD build is active (a plan exists with a story not yet done). It surfaces "N of M done ·
 * story K <status>" plus the cursor story's action buttons — so the human can retry/skip/
 * continue without scrolling back up to the plan block that streamed a screen ago. During
 * streaming it shows a subtle "building story K…" and no buttons.
 */
export function PlanBar() {
  const conv = useStore((s) => s.conversation);
  const streaming = useStore((s) => s.streaming);
  const plan = conv?.prdPlan;
  if (!plan || plan.stories.length === 0) return null;
  // Only while the build is still active — a fully-done plan is finished.
  if (plan.stories.every((s) => s.status === 'done')) return null;

  const done = plan.stories.filter((s) => s.status === 'done').length;
  const total = plan.stories.length;
  const k = plan.cursor + 1;
  const cursorStory = plan.stories[plan.cursor];
  const statusWord = STORY_STATUS_WORD[cursorStory?.status ?? 'pending'];

  return (
    <div class="fp-plan-bar">
      <span class="fp-plan-bar-label">
        <IconFile size={14} />
        <span>
          PRD build · {done} of {total} done ·{' '}
          {streaming ? <em class="fp-plan-bar-building">building story {k}…</em> : <>story {k} {statusWord}</>}
        </span>
      </span>
      <span class="fp-plan-bar-actions">
        {streaming ? (
          <button
            type="button"
            class="fp-btn fp-btn-sm fp-btn-secondary"
            onClick={() => post({ type: 'cancelResponse' })}
            title="Stop the current story build"
          >
            <IconX size={15} /> Stop
          </button>
        ) : (
          <PlanActionButtons plan={plan} streaming={streaming} />
        )}
      </span>
    </div>
  );
}

export function ErrorBlock({ message }: { message: string }) {
  return (
    <div class="fp-error">
      <IconAlert size={18} style={{ flexShrink: 0 }} />
      <div><Markdown text={message} /></div>
    </div>
  );
}

void IconChevronRight;
