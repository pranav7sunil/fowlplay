/**
 * FowlPlay LIVE Coop journey.
 *
 * Unlike e2e/run.mjs (which drives the UI against a scripted MockBridge), this
 * walks a full user journey against the REAL SessionCore: the browser loads
 * e2e/liveHarness.html, which installs window.__fowlplayBridge backed by
 * createSessionCore + in-memory ports + a scripted dual-model ProviderAdapter
 * (see e2e/liveHost.ts), then the real dist/webview.js bundle on top.
 *
 * The journey: a directive routes the orchestrator (Gemma) and builder (Qwen),
 * a PRD is decomposed by the Foreman and built story-by-story through the Coop
 * pipeline — exercising a clean pass, an Inspector route-back, and a runaway
 * guard + retry — with a screenshot at each beat.
 *
 * Usage: node e2e/coopJourney.mjs   (requires `node esbuild.mjs` first)
 * Env:   FP_CHROMIUM — chromium executable override.
 */
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = normalize(join(fileURLToPath(import.meta.url), '..', '..'));
const SHOTS = join(ROOT, 'e2e', 'screenshots', 'coop');

const QWEN_LABEL = 'Qwen3.6-35B-MoE';
const GEMMA_LABEL = 'Gemma 3 26B';

// --- locate playwright + chromium (mirrors run.mjs) --------------------------
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
  for (const p of ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome']) {
    if (existsSync(p)) return p;
  }
  return undefined;
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
const BASE = `http://127.0.0.1:${server.address().port}/e2e/liveHarness.html`;

// --- assertion helpers -------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failed += 1; failures.push(name); console.log(`  ✗ ${name}`); }
}
async function waitFor(page, fn, name, timeout = 20000) {
  try {
    await page.waitForFunction(fn, undefined, { timeout });
    ok(true, name);
  } catch {
    ok(false, name);
  }
}
async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
}
/** Model label shown on the gate card whose title contains `titleSubstr`. */
const gateModel = (page, titleSubstr) =>
  page.evaluate((t) => {
    const cards = Array.from(document.querySelectorAll('.fp-gate'));
    const card = cards.find((c) => (c.querySelector('.fp-gate-title')?.textContent || '').includes(t));
    return card?.querySelector('.fp-gate-model')?.textContent ?? null;
  }, titleSubstr);
/** All gate model labels grouped by the role word in their title. */
const allGateModels = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.fp-gate')).map((c) => ({
      title: c.querySelector('.fp-gate-title')?.textContent || '',
      model: c.querySelector('.fp-gate-model')?.textContent || '',
    })),
  );
const planBarText = (page) => page.evaluate(() => document.querySelector('.fp-plan-bar')?.textContent ?? '');

// --- run ----------------------------------------------------------------------
await mkdir(SHOTS, { recursive: true });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumPath() });
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 300)));
page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 200)); });

await page.goto(BASE, { waitUntil: 'load' });
const composer = () => page.locator('.fp-composer-textarea');

// ============================== 1. DIRECTIVE =================================
console.log('\n# 1. directive routes orchestrator + builder');
await waitFor(page, () => !!document.querySelector('.fp-composer-textarea'), 'chat mounted (real SessionCore)');
await composer().fill('gemma is the orchestrator, qwen is the builder');
await composer().press('Enter');
await waitFor(
  page,
  () => Array.from(document.querySelectorAll('.fp-toast')).some((t) => /Scout → Gemma/.test(t.textContent || '') && /Builder → Qwen/.test(t.textContent || '')),
  'directive confirmation toast names Scout→Gemma and Builder→Qwen',
);
await shot(page, '01-directive-toast');

// ============================== 2. /status ===================================
console.log('\n# 2. /status shows the routed roles');
await composer().fill('/status');
await composer().press('Enter');
await waitFor(page, () => !!document.querySelector('.fp-status-card'), '/status renders the status card');
await waitFor(
  page,
  () => {
    const t = document.querySelector('.fp-status-card')?.textContent || '';
    return t.includes('Scout → Gemma 3 26B') && t.includes('Builder → Qwen3.6-35B-MoE');
  },
  'status Roles line shows both routed models',
);
await shot(page, '02-status-roles');
await page.locator('.fp-status-card button[aria-label="Dismiss status"]').click();

// ============================== 3. /prd → Foreman ============================
console.log('\n# 3. /prd build of @pomodoro-prd.md');
await composer().fill('/prd');
await composer().press('Enter');
await waitFor(page, () => !!document.querySelector('.fp-prd-chip'), '/prd arms the PRD build chip');
await composer().fill('implement @pomodoro-prd.md');
await shot(page, '03-prd-armed');
// Escape closes the @-file popup (keeping the text), then Enter sends.
await composer().press('Escape');
await composer().press('Enter');
await waitFor(
  page,
  () => Array.from(document.querySelectorAll('.fp-toast')).some((t) => /Included/.test(t.textContent || '') && /pomodoro-prd\.md/.test(t.textContent || '')),
  'file-inclusion toast lists pomodoro-prd.md',
);
await waitFor(page, () => document.body.innerText.includes('Decomposed into 3 stories'), 'Foreman decomposed the PRD into 3 stories');
await waitFor(
  page,
  () => {
    const titles = Array.from(document.querySelectorAll('.fp-plan-story-title')).map((n) => n.textContent);
    return titles.length === 3;
  },
  'plan block lists all 3 stories',
);
ok((await gateModel(page, 'Foreman')) === GEMMA_LABEL, `Foreman card ran on ${GEMMA_LABEL} (orchestrator)`);
await shot(page, '04-foreman');

// ============================== 4. STORY 1 CARDS + DIFF ======================
console.log('\n# 4. story 1 pipeline + diff review');
await waitFor(page, () => document.body.innerText.includes('Human review'), 'story 1 reached the HITL gate');
await waitFor(page, () => document.body.innerText.includes('Awaiting your diff review'), 'HITL card awaits diff review');
ok((await gateModel(page, 'Builder')) === QWEN_LABEL, `Builder card ran on ${QWEN_LABEL}`);
ok((await gateModel(page, 'Inspector')) === QWEN_LABEL, `Inspector ran on the conversation/default model (${QWEN_LABEL})`);
ok((await gateModel(page, 'Sentry')) === QWEN_LABEL, `Sentry ran on the conversation/default model (${QWEN_LABEL})`);
await shot(page, '05-story1-cards');

// Open Review Changes (the HITL card's button) → the live diff.
await page.getByRole('button', { name: /Review Changes/ }).first().click();
await waitFor(page, () => !!document.querySelector('.fp-diff'), 'diff viewer opens');
await waitFor(page, () => document.querySelectorAll('.fp-hunk').length >= 1, 'staged hunk(s) render');
await waitFor(page, () => document.body.innerText.includes('index.html'), 'story 1 staged index.html');
await shot(page, '06-diff');
await page.getByRole('button', { name: 'Apply to Disk' }).click();
await waitFor(page, () => !!document.querySelector('.fp-plan-bar'), 'back to chat with the pinned PRD bar');

// ============================== 5. STORY 2 ROUTE-BACK ========================
console.log('\n# 5. continue → story 2 (Inspector route-back)');
await waitFor(
  page,
  () => {
    const t = document.querySelector('.fp-plan-bar')?.textContent || '';
    return /story 1/.test(t) && /of 3/.test(t);
  },
  'PRD bar shows story 1 of 3',
  8000,
);
await page.locator('.fp-plan-bar').getByRole('button', { name: /Continue/ }).click();
await waitFor(page, () => /story 2 awaiting review/.test(document.querySelector('.fp-plan-bar')?.textContent || ''), 'story 2 finished (awaiting review)');
await waitFor(page, () => document.body.innerText.includes('Routing back to Builder'), 'Inspector rejected attempt 1 and routed back');
await waitFor(
  page,
  () => {
    const cards = Array.from(document.querySelectorAll('.fp-gate'));
    return cards.some((c) => (c.querySelector('.fp-gate-title')?.textContent || '').includes('Inspector') && /attempt 2/.test(c.textContent || ''));
  },
  'an Inspector card at attempt 2 exists',
);
await shot(page, '07-story2-routeback');

// ============================== 6. STORY 3 RUNAWAY + RETRY ===================
console.log('\n# 6. continue → story 3 (runaway guard) then retry');
await page.locator('.fp-plan-bar').getByRole('button', { name: /Continue/ }).click();
await waitFor(page, () => document.body.innerText.includes('Runaway generation halted'), 'Builder card fails with runaway evidence');
await waitFor(page, () => /story 3 failed/.test(document.querySelector('.fp-plan-bar')?.textContent || ''), 'story 3 landed failed');
await shot(page, '08-runaway');

await page.locator('.fp-plan-bar').getByRole('button', { name: /Retry story/ }).click();
await waitFor(page, () => /story 3 awaiting review/.test(document.querySelector('.fp-plan-bar')?.textContent || ''), 'retry of story 3 passed (awaiting review)');
await shot(page, '09-retry-pass');

// ============================== 7. COMPLETION ================================
console.log('\n# 7. final continue → plan complete');
await page.locator('.fp-plan-bar').getByRole('button', { name: /Continue/ }).click();
await waitFor(page, () => document.body.innerText.includes('PRD build complete'), 'plan completion summary appears');
await waitFor(page, () => document.body.innerText.includes('3 of 3 stories done'), 'summary reports 3 of 3 done');
await shot(page, '10-complete');

// --- call-log assertions -----------------------------------------------------
console.log('\n# call log (which model served which role)');
const calls = await page.evaluate(() => (window.__live || []).map((c) => ({ role: c.role, modelId: c.modelId })));
const byRole = (r) => calls.filter((c) => c.role === r);
ok(byRole('foreman').length >= 1 && byRole('foreman').every((c) => c.modelId === 'gemma-3-26b'), 'every Foreman call went to gemma-3-26b');
ok(byRole('scout').length >= 1 && byRole('scout').every((c) => c.modelId === 'gemma-3-26b'), 'every Scout call went to gemma-3-26b');
ok(byRole('builder').length >= 1 && byRole('builder').every((c) => c.modelId === 'qwen3.6-35b-moe'), 'every Builder call went to qwen3.6-35b-moe');
ok(byRole('inspector').every((c) => c.modelId === 'qwen3.6-35b-moe'), 'every Inspector call went to the default (qwen3.6-35b-moe)');
ok(byRole('sentry').every((c) => c.modelId === 'qwen3.6-35b-moe'), 'every Sentry call went to the default (qwen3.6-35b-moe)');

// Cross-check the rendered gate cards agree with the routing.
const gates = await allGateModels(page);
const modelForTitle = (t) => gates.filter((g) => g.title.includes(t)).map((g) => g.model);
ok(modelForTitle('Foreman').every((m) => m === GEMMA_LABEL), 'Foreman gate cards labeled Gemma');
ok(modelForTitle('Scout').every((m) => m === GEMMA_LABEL), 'Scout gate cards labeled Gemma');
ok(modelForTitle('Builder').every((m) => m === QWEN_LABEL), 'Builder gate cards labeled Qwen');

await browser.close();
server.close();

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) {
  console.log('Failures:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
