/** Assistant content-block renderers. */
import type { JSX } from 'preact';
import type { ContentBlock, ToolCallRecord, GateCard, CoopRole, GateStatus } from '../../shared/types';
import { Markdown, Collapsible } from './common';
import {
  IconCheck, IconX, IconWrench, IconCompass, IconHammer, IconEye, IconShield,
  IconDiff, IconGit, IconAlert, IconArrowRight, IconArrowUp, IconChevronRight,
} from './icons';
import { store } from './store';

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

const ROLE_ICON: Record<CoopRole | 'stop-the-line' | 'hitl', (p: { size?: number }) => JSX.Element> = {
  scout: IconCompass,
  builder: IconHammer,
  inspector: IconEye,
  sentry: IconShield,
  'stop-the-line': IconAlert,
  hitl: IconEye,
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
          <button type="button" class="fp-btn fp-btn-primary fp-btn-sm" onClick={() => store.openReview()} style={{ alignSelf: 'flex-start' }}>
            <IconDiff size={15} /> Review Changes
          </button>
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
  summary: { changesetId: string; filesChanged: number; additions: number; deletions: number };
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
      <button type="button" class="fp-btn fp-btn-primary" onClick={() => store.openReview(summary.changesetId)}>
        <IconDiff size={16} /> Review Changes
      </button>
    </div>
  );
}

export function CommitBlock({
  commit,
}: {
  commit: { sha: string; message: string; changesetId: string; filesChanged: number };
}) {
  return (
    <div class="fp-commit">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <IconGit size={16} style={{ color: 'var(--fp-accent)' }} />
        <span class="fp-commit-sha">{commit.sha.slice(0, 8)}</span>
        <span style={{ color: 'var(--fp-fg-muted)', fontSize: '12px' }}>{commit.filesChanged} files</span>
      </div>
      <div class="fp-commit-msg">{commit.message}</div>
      <button type="button" class="fp-btn-ghost" onClick={() => store.openReview(commit.changesetId, true)} style={{ padding: 0, color: 'var(--fp-accent)' }}>
        View Changes <IconArrowRight size={14} />
      </button>
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
