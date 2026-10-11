// Read-only review and explicit reversal through the real dashboard and API.
// All messages, credentials and page actions below are local fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { Db } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { startApi } from '../../src/api.js';
import { DEFAULTS } from '../../settings.js';

vm.runInThisContext(fs.readFileSync(new URL('../../policy.js', import.meta.url), 'utf8'));

test('view the original message before an explicit undo, without acting during review', { timeout: 30000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-dashboard-'));
  const db = new Db(path.join(dir, 'state.db'));
  const store = new Store(path.join(dir, 'state.json'));
  const time = Date.now();
  const original = 'Original saved message. <b>This remains plain text.</b>';
  db.recordEvent({ time, threadId: 'sample', name: 'Sample sender', text: original,
    label: 'review', rule: 'review', outcome: 'blocked & reported', reason: 'Manual action.' });
  db.recordEvent({ time: time - 1, threadId: 'archive', name: 'Sample sender 2', text: 'Sample appointment reminder.',
    label: 'review', rule: 'review', outcome: 'archived (by you)' });
  db.recordEvent({ time: time - 2, threadId: 'old', name: 'Older sender',
    label: 'review', rule: 'review', outcome: 'blocked & reported' });
  store.set({ verdicts: { sample: { label: 'ok', text: 'A newer message, not the original.' } } });
  const delivered = [];
  const server = await startApi({
    settings: { ...DEFAULTS, mode: 'spam', dryRun: false }, port: 0, token: 'fixture-token', db, store,
    backend: { stats: { calls: 0, failures: 0, ms: 0 } }, health: async () => ({ ok: true, paired: true }),
    policy: globalThis.MessagesPolicy, log: () => {},
    deliver: async (msg) => {
      delivered.push(msg);
      db.recordEvent({ time: Date.now() + 1000, threadId: msg.threadId, name: msg.name, label: 'undo', outcome: 'unblocked' });
      return { ok: true };
    },
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addInitScript(() => localStorage.setItem('mc.token', 'fixture-token'));
    const base = `http://127.0.0.1:${server.address().port}`;
    // Keep the requested hostname while routing every request to our fixture.
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      assert.equal(url.hostname, 'messages.lan.jlapenna.net');
      const response = await fetch(base + url.pathname + url.search, {
        method: request.method(), headers: request.headers(),
        body: request.method() === 'GET' ? undefined : request.postData(),
      });
      const headers = Object.fromEntries(response.headers);
      delete headers['content-length'];
      await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('https://messages.lan.jlapenna.net/');
    await page.locator('[data-view="1"]').waitFor();
    assert.equal(await page.title(), 'Messages Control');
    assert.equal(await page.locator('#events .label.review').count(), 0);
    assert.ok(!(await page.locator('#events').innerText()).includes('[review]'));
    assert.equal(await page.locator('#events').getByRole('button', { name: 'Undo', exact: true }).count(), 0);
    await page.locator('[data-view="1"]').click();
    await page.getByRole('button', { name: 'Undo block', exact: true }).waitFor();
    assert.equal(await page.locator('#message-preview').innerText(), original);
    assert.equal(await page.locator('#message-preview b').count(), 0);
    assert.match(await page.locator('#message-outcome').innerText(), /blocked & reported.*manual action/);
    assert.equal(delivered.length, 0, 'viewing the snapshot does not touch the Google Messages page');
    // Optional local evidence; normal CI does not retain screenshots.
    if (process.env.MC_QA_SCREENSHOTS === '1') await page.screenshot({ path: '/tmp/messages-control-message-details-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.locator('#message-dialog').evaluate((e) => e.scrollWidth <= e.clientWidth));
    if (process.env.MC_QA_SCREENSHOTS === '1') await page.screenshot({ path: '/tmp/messages-control-message-details-mobile.png' });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    assert.ok(await page.locator('#events').evaluate((e) => e.scrollWidth <= e.clientWidth));
    if (process.env.MC_QA_SCREENSHOTS === '1') await page.screenshot({ path: '/tmp/messages-control-activity-clear-mobile.png', fullPage: true });
    await page.locator('[data-view="2"]').click();
    await page.getByRole('button', { name: 'Unarchive', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('[data-view="3"]').click();
    await page.getByText('No preview was saved for this event.', { exact: true }).waitFor();
    assert.equal(await page.locator('#message-undo').isVisible(), false);
    assert.match(await page.locator('#undo-explanation').innerText(), /Google Messages/);
    assert.equal(delivered.length, 0);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('[data-view="1"]').click();
    await page.getByRole('button', { name: 'Undo block', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#message-dialog').open && document.querySelector('#events').textContent.includes('unblocked'));
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].type, 'undo');
    assert.equal(delivered[0].kind, 'blocked');
    assert.equal(delivered[0].threadId, 'sample');
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    store.flush();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
