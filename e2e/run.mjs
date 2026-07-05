/**
 * FowlPlay webview functional tests.
 *
 * Serves the repo statically, loads e2e/harness.html (real compiled bundle +
 * MockBridge) in headless Chromium via Playwright, and exercises every view:
 * chat, diff review (revert/comment/keyboard/apply), settings, onboarding,
 * history, and live streaming. Screenshots land in e2e/screenshots/.
 *
 * Usage: node e2e/run.mjs   (requires `node esbuild.mjs` first)
 * Env:   FP_CHROMIUM — chromium executable override.
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const SHOTS = join(ROOT, 'e2e', 'screenshots');

// --- locate playwright + chromium ------------------------------------------
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const g = '/opt/node22/lib/node_modules/playwright/index.mjs';
    if (existsSync(g)) return await import(g);
    return req('playwright');
  }
}

function chromiumPath() {
  if (process.env.FP_CHROMIUM) return process.env.FP_CHROMIUM;
  for (const p of [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    ...(existsSync('/opt/pw-browsers')
      ? []
      : []),
  ]) {
    if (existsSync(p)) return p;
  }
  return undefined; // let playwright resolve its own
}

// --- tiny static server ------------------------------------------------------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.map': 'application/json',
};
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const path = normalize(join(ROOT, decodeURIComponent(url.pathname)));
    if (!path.startsWith(ROOT)) throw new Error('traversal');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/e2e/harness.html`;

// --- assertion helpers -------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  ✗ ${name}`); }
}
async function waitFor(page, fn, name, timeout = 5000) {
  try {
    await page.waitForFunction(fn, undefined, { timeout });
    ok(true, name);
  } catch {
    ok(false, name);
  }
}
const sent = (page, type) =>
  page.evaluate((t) => (window.__sentMessages || []).filter((m) => m.type === t), type);

// --- run ----------------------------------------------------------------------
await mkdir(SHOTS, { recursive: true });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumPath() });
const page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 200)));

async function open(hash) {
  await page.goto(`${BASE}#${hash}`, { waitUntil: 'load' });
  await page.waitForTimeout(150);
}

// ============================== CHAT =========================================
console.log('\n# chat');
await open('chat');
await waitFor(page, () => document.body.innerText.includes('Refactor login()'), 'conversation title renders');
ok(await page.locator('.fp-msg-user, [class*="user"]').first().isVisible().catch(() => false), 'user message visible');
await waitFor(page, () => document.body.innerText.includes('Scout — acceptance criteria'), 'scout gate card renders');
await waitFor(page, () => document.body.innerText.includes('Sentry — security review'), 'sentry gate card renders');
await waitFor(page, () => document.body.innerText.includes('login() returns a typed Session on success'), 'acceptance criteria listed');
await waitFor(page, () => /3 files/.test(document.body.innerText), 'changes block shows 3 files');
await waitFor(page, () => document.body.innerText.includes('qwen2.5-coder:32b') || document.body.innerText.includes('Qwen2.5'), 'model name in status line');
// thinking block expand
const thinking = page.getByText(/Thought for/i).first();
ok(await thinking.isVisible().catch(() => false), 'thinking block present');
// composer send
await page.locator('textarea').last().fill('Now add logout()');
await page.locator('textarea').last().press('Enter');
ok((await sent(page, 'sendPrompt')).some((m) => m.text === 'Now add logout()'), 'Enter posts sendPrompt');
await page.screenshot({ path: join(SHOTS, 'chat.png'), fullPage: false });
// Review Changes → openDiff
const review = page.getByRole('button', { name: /review changes/i }).first();
if (await review.isVisible().catch(() => false)) {
  await review.click();
  ok((await sent(page, 'openDiff')).length > 0, 'Review Changes posts openDiff');
} else {
  ok(false, 'Review Changes button visible');
}

// ============================== EDIT SELECTION ===============================
console.log('\n# edit selection');
await open('selection');
await waitFor(page, () => document.body.innerText.includes('authService.ts:12-20'), 'selection chip shows basename:range');
const chip = page.locator('.fp-selection-chip').first();
ok(await chip.isVisible().catch(() => false), 'selection chip visible above composer');
await page.screenshot({ path: join(SHOTS, 'selection.png'), fullPage: false });
await chip.getByRole('button', { name: /clear selection/i }).click();
ok((await sent(page, 'clearSelection')).length === 1, 'clicking × posts clearSelection');
await waitFor(page, () => !document.body.innerText.includes('authService.ts:12-20'), 'chip clears after dismiss');

// ============================== DIFF =========================================
console.log('\n# diff');
await open('diff');
await waitFor(page, () => document.querySelectorAll('.fp-hunk').length === 6, 'six hunks render');
await waitFor(page, () => document.body.innerText.includes('Change 1 of 6'), 'position indicator');
await waitFor(page, () => document.body.innerText.includes('src/auth/errors.ts'), 'created file listed');
ok((await page.locator('.fp-line-add').count()) > 5, 'added lines styled');
ok((await page.locator('.fp-line-del').count()) > 3, 'deleted lines styled');
// keyboard nav
await page.locator('body').press('j');
await page.locator('body').press('j');
await waitFor(page, () => document.body.innerText.includes('Change 3 of 6'), 'j advances active hunk');
await page.locator('body').press('k');
await waitFor(page, () => document.body.innerText.includes('Change 2 of 6'), 'k goes back');
// revert toggle
await page.locator('.fp-hunk input[type="checkbox"]').first().check();
ok((await sent(page, 'toggleRevert')).some((m) => m.reverted === true), 'revert checkbox posts toggleRevert');
// inline comment
await page.locator('.fp-hunk').nth(2).locator('button', { hasText: 'Comment' }).first().click();
await page.locator('.fp-comment-box textarea').fill('Use a Set here');
await page.locator('.fp-comment-box textarea').press('Enter');
ok((await sent(page, 'setComment')).some((m) => m.comment === 'Use a Set here'), 'comment posts setComment');
// existing comment bubble from fixture
ok(await page.getByText('Nice — keep this doc comment.').isVisible().catch(() => false), 'existing comment bubble renders');
// send feedback enabled (fixture has a comment)
const fb = page.getByRole('button', { name: 'Send Feedback' });
ok(await fb.isEnabled().catch(() => false), 'Send Feedback enabled with feedback present');
await fb.click();
ok((await sent(page, 'sendFeedback')).length === 1, 'Send Feedback posts sendFeedback');
// apply to disk
await page.getByRole('button', { name: 'Apply to Disk' }).click();
ok((await sent(page, 'applyToDisk')).length === 1, 'Apply to Disk posts applyToDisk');
// apply & commit modal
await page.getByRole('button', { name: /Apply & Commit/ }).click();
ok((await sent(page, 'requestCommitMessage')).length === 1, 'commit modal requests message');
await page.locator('.fp-modal textarea, [class*=modal] textarea').first().fill('feat(auth): typed session');
await page.getByRole('button', { name: /^Commit$/ }).click();
ok((await sent(page, 'applyAndCommit')).some((m) => m.message === 'feat(auth): typed session' && m.coAuthor === true), 'commit posts applyAndCommit with co-author');
await page.screenshot({ path: join(SHOTS, 'diff.png'), fullPage: false });

// ============================== SETTINGS =====================================
console.log('\n# settings');
await open('settings');
await page.getByRole('button', { name: 'Models & Providers' }).click();
await waitFor(page, () => document.body.innerText.includes('Ollama (local)'), 'providers listed');
await waitFor(page, () => document.body.innerText.includes('Anthropic'), 'second provider listed');
for (const tab of ['Appearance', 'Harness']) {
  const t = page.getByRole('button', { name: tab }).first();
  if (await t.isVisible().catch(() => false)) {
    await t.click();
    await page.waitForTimeout(100);
    ok(true, `${tab} tab clickable`);
  } else ok(false, `${tab} tab clickable`);
}
await waitFor(page, () => /Scout|Inspector|Sentry/.test(document.body.innerText), 'harness tab explains Coop pipeline');
await waitFor(page, () => document.body.innerText.includes('commit-message'), 'harness tab lists discovered skills');
await waitFor(page, () => /\.fowlplay\/skills/.test(document.body.innerText), 'harness tab documents .fowlplay/skills location');
await page.screenshot({ path: join(SHOTS, 'settings.png'), fullPage: false });

// ============================== ONBOARDING ===================================
console.log('\n# onboarding');
await open('onboarding');
await waitFor(page, () => /FowlPlay/.test(document.body.innerText), 'welcome shows wordmark');
await waitFor(page, () => /[Cc]ollaboration/.test(document.body.innerText), 'tagline present');
const cta = page.locator('button.fp-btn-primary, button[class*=primary]').first();
await cta.click().catch(() => {});
await page.waitForTimeout(150);
await waitFor(page, () => /Ollama|LM Studio/.test(document.body.innerText), 'provider step features local presets');
await page.screenshot({ path: join(SHOTS, 'onboarding.png'), fullPage: false });

// ============================== HISTORY ======================================
console.log('\n# history');
await open('history');
await waitFor(page, () => document.body.innerText.includes('Add pagination to /users endpoint'), 'history items render');
const search = page.locator('input[placeholder*="Search"]').first();
if (await search.isVisible().catch(() => false)) {
  await search.fill('websocket');
  await page.waitForTimeout(150);
  ok(true, 'history search accepts input');
} else ok(false, 'history search accepts input');
await page.screenshot({ path: join(SHOTS, 'history.png'), fullPage: false });

// ====================== HISTORY DIFF (read-only View Changes) ================
console.log('\n# history diff (read-only)');
await open('history-diff');
await waitFor(page, () => document.body.innerText.includes('feat(auth): add AuthError'), 'commit block renders in transcript');
const viewChanges = page.getByRole('button', { name: /view changes/i }).first();
ok(await viewChanges.isVisible().catch(() => false), 'View Changes button visible on commit block');
await viewChanges.click();
ok((await sent(page, 'openDiff')).some((m) => m.changesetId === 'cs-hist-1'), 'View Changes posts openDiff with the frozen changeset id');
await waitFor(page, () => document.body.innerText.includes('Viewing committed changes from history'), 'read-only history banner present');
await waitFor(page, () => document.body.innerText.includes('src/auth/errors.ts'), 'frozen changeset file renders');
ok(await page.getByRole('button', { name: 'Apply to Disk' }).isDisabled().catch(() => false), 'Apply to Disk disabled in read-only diff');
ok(await page.getByRole('button', { name: /Apply & Commit/ }).isDisabled().catch(() => false), 'Apply & Commit disabled in read-only diff');
ok((await page.locator('.fp-hunk-toolbar').count()) === 0, 'no revert/comment toolbar in read-only diff');
await page.screenshot({ path: join(SHOTS, 'history-diff.png'), fullPage: false });

// ============================== STREAM =======================================
console.log('\n# stream');
await open('stream');
await waitFor(page, () => document.body.innerText.includes('Streaming demo'), 'stream conversation loads');
await waitFor(page, () => /Refactored/.test(document.body.innerText), 'streamed text accumulates', 8000);
await waitFor(page, () => document.body.innerText.includes('Sentry — security review'), 'gate cards arrive during stream', 8000);
await waitFor(page, () => /3 files/.test(document.body.innerText), 'final changes block appears', 8000);
await page.screenshot({ path: join(SHOTS, 'stream.png'), fullPage: false });

// ============================== SLASH MENU ===================================
console.log('\n# slash menu');
await open('chat');
const composer = () => page.locator('.fp-composer-textarea');
// Typing '/' opens the command popup listing every command with its description.
await composer().fill('/');
await waitFor(page, () => !!document.querySelector('.fp-slash-menu'), 'slash popup opens on /');
await waitFor(page, () => document.body.innerText.includes('Start a new conversation'), 'command descriptions render');
// Typing 'mo' ranks /model to the top (prefix match) as the highlighted row.
await composer().fill('/mo');
await waitFor(
  page,
  () => document.querySelector('.fp-slash-item[aria-selected="true"] .fp-slash-name')?.textContent === '/model',
  '/mo highlights /model',
);
// Enter opens the model submenu: providers grouped, models listed.
await composer().press('Enter');
await waitFor(page, () => document.querySelector('.fp-slash-header')?.textContent?.includes('Switch model') ?? false, 'model submenu header');
await waitFor(page, () => {
  const groups = Array.from(document.querySelectorAll('.fp-menu-group-label')).map((n) => n.textContent);
  return groups.includes('Ollama (local)') && groups.includes('Anthropic');
}, 'model submenu groups providers');
await waitFor(page, () => {
  const names = Array.from(document.querySelectorAll('.fp-slash-name')).map((n) => n.textContent);
  return names.includes('Qwen2.5 Coder 32B') && names.includes('Claude Sonnet 4');
}, 'model submenu lists mock models');
await page.screenshot({ path: join(SHOTS, 'slash-model.png'), fullPage: false });
// Escape steps back from the submenu to the command list.
await composer().press('Escape');
await waitFor(page, () => !document.querySelector('.fp-slash-header'), 'Escape leaves the model submenu');
await waitFor(page, () => document.body.innerText.includes('Start a new conversation'), 'Escape returns to command list');
// Re-open the submenu and pick a model → setModel post with the chosen ref.
await composer().fill('/mo');
await composer().press('Enter');
await page.locator('.fp-slash-item', { hasText: 'Claude Sonnet 4' }).first().click();
ok(
  (await sent(page, 'setModel')).some((m) => m.model?.providerId === 'prov-anthropic' && m.model?.modelId === 'claude-sonnet-4'),
  'picking a model posts setModel',
);
// /status renders the ephemeral local status card (model + mode present).
await composer().fill('/status');
await composer().press('Enter');
await waitFor(page, () => !!document.querySelector('.fp-status-card'), '/status renders the status card');
await waitFor(page, () => {
  const t = document.querySelector('.fp-status-card')?.textContent ?? '';
  return t.includes('Qwen2.5 Coder 32B') && t.includes('Coop (pipeline)');
}, 'status card shows model name and mode');
await page.screenshot({ path: join(SHOTS, 'slash-status.png'), fullPage: false });
await page.locator('.fp-status-card button[aria-label="Dismiss status"]').click();
// /clear starts a new conversation.
await composer().fill('/clear');
await composer().press('Enter');
ok((await sent(page, 'newConversation')).length >= 1, '/clear posts newConversation');
// A leading-slash string that matches nothing is sent as an ordinary prompt.
await composer().fill('/notacommand');
await composer().press('Enter');
ok((await sent(page, 'sendPrompt')).some((m) => m.text === '/notacommand'), 'unknown /command sends as a prompt');

// ============================== CONTEXT INDICATOR ============================
console.log('\n# context indicator');
await open('chat');
// Model contextWindow 32768, last assistant input 8450 → ~26%; cumulative tokens shown.
await waitFor(page, () => document.querySelector('.fp-context')?.textContent?.includes('26%') ?? false, 'status line shows context percentage');
await waitFor(page, () => /↑8\.\dk/.test(document.querySelector('.fp-tokens')?.textContent ?? ''), 'status line shows tokens counter');

// ============================== MENTION PICKER ===============================
console.log('\n# model-mention picker');
await open('chat');
const injectMention = () =>
  page.evaluate(() =>
    window.__host.emit({
      type: 'modelMentionChoice',
      role: 'conversation',
      query: 'qwen',
      candidates: [
        { providerId: 'prov-ollama', modelId: 'qwen2.5-coder:32b', label: 'Qwen2.5 Coder 32B' },
        { providerId: 'prov-anthropic', modelId: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
      ],
    }),
  );
await injectMention();
await waitFor(page, () => !!document.querySelector('.fp-mention-card'), 'mention picker card renders');
await waitFor(page, () => document.querySelector('.fp-mention-head')?.textContent?.includes('qwen') ?? false, 'mention card shows the query');
await waitFor(page, () => {
  const labels = Array.from(document.querySelectorAll('.fp-mention-label')).map((n) => n.textContent);
  return labels.includes('Qwen2.5 Coder 32B') && labels.includes('Claude Sonnet 4');
}, 'mention card lists both candidate labels');
await page.screenshot({ path: join(SHOTS, 'mention-picker.png'), fullPage: false });
await page.locator('.fp-mention-option').first().click();
ok(
  (await sent(page, 'resolveModelMention')).some((m) => m.model?.modelId === 'qwen2.5-coder:32b' && m.model?.providerId === 'prov-ollama'),
  'picking a candidate posts resolveModelMention with the ModelRef',
);
// Re-inject and dismiss via the X → resolves with model: null.
await injectMention();
await waitFor(page, () => !!document.querySelector('.fp-mention-card'), 'mention picker re-renders');
await page.locator('.fp-mention-card button[aria-label*="Dismiss"]').click();
ok(
  (await sent(page, 'resolveModelMention')).some((m) => m.model === null),
  'dismissing the picker posts resolveModelMention with model: null',
);

// ============================== PRD PLAN BLOCK ===============================
console.log('\n# prd plan block');
await open('prd-plan');
await waitFor(page, () => !!document.querySelector('.fp-plan'), 'plan block renders');
await waitFor(page, () => {
  const titles = Array.from(document.querySelectorAll('.fp-plan-story-title')).map((n) => n.textContent);
  return ['Story 1 — schema', 'Story 2 — endpoint', 'Story 3 — UI'].every((t) => titles.includes(t));
}, 'plan checklist lists all story titles');
await waitFor(page, () => document.querySelector('.fp-plan-count')?.textContent === '1 of 3 done', 'plan shows "1 of 3 done"');
ok((await page.locator('.fp-plan-story .fp-plan-glyph').count()) === 3, 'each story renders a status glyph');
ok(await page.getByRole('button', { name: /Continue — next story/ }).isVisible().catch(() => false), 'awaiting-review cursor shows "Continue — next story"');
await page.screenshot({ path: join(SHOTS, 'prd-plan.png'), fullPage: false });
await page.getByRole('button', { name: /Continue — next story/ }).click();
ok((await sent(page, 'continueStoryLoop')).length >= 1, 'Continue button posts continueStoryLoop');
// Re-inject the same plan with the cursor story pending → "Resume story 2".
await page.evaluate(() => window.__host.emit(window.__fixtures.prdConversation('pending')));
await waitFor(page, () => !!document.querySelector('.fp-plan') && !!Array.from(document.querySelectorAll('button')).find((b) => /Resume story 2/.test(b.textContent || '')), 'pending cursor shows "Resume story 2"');
// …and with the cursor story failed → "Continue anyway".
await page.evaluate(() => window.__host.emit(window.__fixtures.prdConversation('failed')));
await waitFor(page, () => !!Array.from(document.querySelectorAll('button')).find((b) => /Continue anyway/.test(b.textContent || '')), 'failed cursor shows "Continue anyway"');

// ============================== PRD CHIP =====================================
console.log('\n# prd chip');
await open('chat');
await composer().fill('/prd');
await composer().press('Enter');
await waitFor(page, () => !!document.querySelector('.fp-prd-chip'), '/prd arms the PRD build chip');
await waitFor(page, () => document.querySelector('.fp-prd-chip')?.textContent?.includes('PRD build') ?? false, 'PRD chip labels itself');
await page.screenshot({ path: join(SHOTS, 'prd-chip.png'), fullPage: false });
await composer().fill('Build the whole PRD');
await composer().press('Enter');
ok((await sent(page, 'sendPrompt')).some((m) => m.text === 'Build the whole PRD' && m.prd === true), 'armed send posts sendPrompt with prd:true');
// The chip disarms after one send — the next message carries no prd flag.
await composer().fill('Just a normal follow-up');
await composer().press('Enter');
ok((await sent(page, 'sendPrompt')).some((m) => m.text === 'Just a normal follow-up' && !m.prd), 'subsequent send omits the prd flag');

// ============================== MARKDOWN REGRESSION ==========================
console.log('\n# markdown regression');
await open('markdown');
await waitFor(page, () => document.querySelectorAll('.fp-msg-assistant .fp-md ol').length === 1, 'numbered list renders a single <ol>');
ok(
  await page.evaluate(() => document.querySelectorAll('.fp-msg-assistant .fp-md ol > li').length === 3),
  'the single <ol> has three list items (numbering continuous, not restarting)',
);
ok(
  await page.evaluate(() => document.querySelectorAll('.fp-msg-assistant .fp-md ol > li ul').length >= 1),
  'nested <ul> bullets render inside the numbered items',
);
ok(
  await page.evaluate(() => {
    const strong = Array.from(document.querySelectorAll('.fp-msg-assistant .fp-md strong')).find((s) => s.querySelector('code'));
    return !!strong && !(strong.textContent || '').includes('**');
  }),
  'emphasis wraps an inline <code> with no literal ** in the text',
);
await page.screenshot({ path: join(SHOTS, 'markdown.png'), fullPage: false });

// ============================== GATE MODEL LABEL =============================
console.log('\n# gate model label');
await open('chat');
await page.evaluate(() =>
  window.__host.emit({
    type: 'gateUpdate',
    card: {
      id: 'gate-builder-model',
      role: 'builder',
      title: 'Builder — implementation',
      status: 'passed',
      modelLabel: 'Claude Sonnet 4',
      evidence: 'Applied the edits and ran the build.',
      usage: { inputTokens: 4200, outputTokens: 800, cachedTokens: 0 },
    },
  }),
);
await waitFor(page, () => document.querySelector('.fp-gate-model')?.textContent === 'Claude Sonnet 4', 'gate card shows its model label');
await waitFor(page, () => {
  const u = document.querySelector('.fp-gate-usage')?.textContent ?? '';
  return u.includes('4.2k') && u.includes('800');
}, 'gate card shows its token usage');
await page.screenshot({ path: join(SHOTS, 'gate-model.png'), fullPage: false });

// ============================== THEME ========================================
console.log('\n# theme');
const accent = await page.evaluate(() =>
  getComputedStyle(document.documentElement).getPropertyValue('--fp-accent').trim());
ok(/4166F5/i.test(accent) || /65, ?102, ?245/.test(accent), `ultramarine accent token set (${accent || 'missing'})`);

await browser.close();
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
