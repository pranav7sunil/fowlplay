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
