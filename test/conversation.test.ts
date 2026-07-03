import { describe, it, expect } from 'vitest';
import type { ContentBlock } from '../src/shared/types';
import {
  activePath,
  appendAssistant,
  appendUser,
  autoTitle,
  createConversation,
  editMessage,
  forkAt,
  rerun,
  rewindTo,
  siblings,
  switchBranch,
} from '../src/core/conversation/tree';
import { toJSON, toMarkdown, toSummary } from '../src/core/conversation/serialize';

const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];

/** Build a simple U/A/U/A conversation, returning ids along the way. */
function buildBasic() {
  let conv = createConversation({ providerId: 'p', modelId: 'm' }, 'solo');
  const u1 = appendUser(conv, text('first question'));
  conv = u1.conv;
  const a1 = appendAssistant(conv, text('first answer'));
  conv = a1.conv;
  const u2 = appendUser(conv, text('second question'));
  conv = u2.conv;
  const a2 = appendAssistant(conv, text('second answer'));
  conv = a2.conv;
  return { conv, u1: u1.nodeId, a1: a1.nodeId, u2: u2.nodeId, a2: a2.nodeId };
}

describe('conversation tree basics', () => {
  it('appends build a linear active path', () => {
    const { conv } = buildBasic();
    const path = activePath(conv);
    expect(path.map((n) => n.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(path.map((n) => (n.blocks[0] as { text: string }).text)).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
    ]);
  });

  it('auto-titles from the first user text', () => {
    const { conv } = buildBasic();
    expect(conv.title).toBe('first question');
    expect(autoTitle(conv)).toBe('first question');
  });

  it('truncates long titles to <= 48 chars', () => {
    let conv = createConversation(null, 'coop');
    const long = 'x'.repeat(100);
    conv = appendUser(conv, text(long)).conv;
    expect(autoTitle(conv).length).toBeLessThanOrEqual(48);
  });
});

describe('editMessage branching', () => {
  it('creates a sibling and preserves the original path', () => {
    const { conv, u2 } = buildBasic();
    const originalPathIds = activePath(conv).map((n) => n.id);
    const edited = editMessage(conv, u2, text('second question REVISED'));
    // Original nodes still exist.
    for (const id of originalPathIds) expect(edited.conv.nodes[id]).toBeDefined();
    // New leaf is the edited sibling.
    expect(edited.conv.currentLeafId).toBe(edited.nodeId);
    const sib = siblings(edited.conv, edited.nodeId);
    expect(sib.count).toBe(2);
    // Active path now goes through the revised message.
    const leafText = (edited.conv.nodes[edited.nodeId].blocks[0] as { text: string }).text;
    expect(leafText).toBe('second question REVISED');
  });
});

describe('switchBranch round-trip', () => {
  it('moves between siblings and back', () => {
    const { conv, u2 } = buildBasic();
    // Edit u2 -> creates a second sibling branch and moves the leaf there.
    const edited = editMessage(conv, u2, text('revised'));
    const newBranchId = edited.nodeId;
    // Switch back to the previous (original) sibling.
    const back = switchBranch(edited.conv, newBranchId, 'prev');
    const backLeaf = activePath(back);
    // Deepest descendant of the original u2 was a2 (second answer).
    expect((backLeaf[backLeaf.length - 1].blocks[0] as { text: string }).text).toBe('second answer');
    // Switch forward again returns to the revised branch.
    const origU2 = back.nodes[u2].id;
    const fwd = switchBranch(back, origU2, 'next');
    expect(fwd.currentLeafId).toBe(newBranchId);
  });
});

describe('rerun', () => {
  it('returns the parent user node and prepares a sibling regeneration point', () => {
    const { conv, a2, u2 } = buildBasic();
    const r = rerun(conv, a2);
    expect(r.parent.id).toBe(u2);
    expect(r.conv.currentLeafId).toBe(u2);
    // Appending an assistant now creates a sibling of a2.
    const regenerated = appendAssistant(r.conv, text('regenerated answer'));
    const sib = siblings(regenerated.conv, regenerated.nodeId);
    expect(sib.count).toBe(2);
  });
});

describe('rewindTo', () => {
  it('moves the current leaf back without deleting branches', () => {
    const { conv, a1, a2 } = buildBasic();
    const rewound = rewindTo(conv, a1);
    expect(rewound.currentLeafId).toBe(a1);
    expect(activePath(rewound).map((n) => n.id)).not.toContain(a2);
    // Nodes still present.
    expect(rewound.nodes[a2]).toBeDefined();
  });
});

describe('forkAt', () => {
  it('copies only the path up to the node with fresh ids', () => {
    const { conv, a1, a2 } = buildBasic();
    const fork = forkAt(conv, a1);
    // Fresh conversation id and node ids.
    expect(fork.id).not.toBe(conv.id);
    expect(fork.nodes[a1]).toBeUndefined();
    // Path has exactly 2 messages (u1 + a1), a2/u2 not copied.
    const path = activePath(fork);
    expect(path).toHaveLength(2);
    expect((path[0].blocks[0] as { text: string }).text).toBe('first question');
    expect((path[1].blocks[0] as { text: string }).text).toBe('first answer');
    // Mutating the fork does not affect the original.
    const grew = appendUser(fork, text('fork-only message'));
    expect(activePath(conv)).toHaveLength(4);
    expect(activePath(grew.conv)).toHaveLength(3);
  });

  it('immutability: original conversation is untouched by appends', () => {
    const { conv } = buildBasic();
    const before = activePath(conv).length;
    appendUser(conv, text('extra'));
    expect(activePath(conv).length).toBe(before);
  });
});

describe('serialize', () => {
  it('toMarkdown contains headings and content along the active path', () => {
    const { conv } = buildBasic();
    const md = toMarkdown(conv);
    expect(md).toContain('## User');
    expect(md).toContain('## Assistant');
    expect(md).toContain('first question');
    expect(md).toContain('second answer');
  });

  it('toMarkdown renders tool calls and gate cards', () => {
    let conv = createConversation(null, 'coop');
    conv = appendUser(conv, text('do it')).conv;
    const blocks: ContentBlock[] = [
      { type: 'text', text: 'working on it' },
      { type: 'tool_call', call: { id: 't1', name: 'read_file', args: {}, resultSummary: 'read 20 lines', ok: true } },
      {
        type: 'gate',
        card: {
          id: 'g1',
          role: 'inspector',
          title: 'Inspector — QA validation',
          status: 'passed',
          evidence: 'All acceptance criteria met.',
          acceptanceCriteria: ['builds', 'tests pass'],
        },
      },
    ];
    conv = appendAssistant(conv, blocks).conv;
    const md = toMarkdown(conv);
    expect(md).toContain('`read_file`');
    expect(md).toContain('read 20 lines');
    expect(md).toContain('Inspector — QA validation');
    expect(md).toContain('builds');
  });

  it('toJSON produces stable sorted-key JSON', () => {
    const { conv } = buildBasic();
    const json = toJSON(conv);
    const parsed = JSON.parse(json);
    expect(parsed.id).toBe(conv.id);
    // Keys are sorted: "createdAt" appears before "title" at the top level.
    const topKeys = Object.keys(parsed);
    const sorted = [...topKeys].sort();
    expect(topKeys).toEqual(sorted);
  });

  it('toSummary reports active-path message count', () => {
    const { conv } = buildBasic();
    const s = toSummary(conv);
    expect(s.id).toBe(conv.id);
    expect(s.messageCount).toBe(4);
    expect(s.title).toBe('first question');
  });
});
