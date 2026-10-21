// Render the real options module; simulate Chrome's permission prompt so the
// denied/granted paths can be tested without a user's browser or account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

test('endpoint permission approval is required before saving or sending a test message', { timeout: 30000 }, async () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
  const files = new Set(['options.html', 'options.js', 'settings.js', 'endpoint-permission.js', 'style.css']);
  const server = http.createServer((req, res) => {
    const file = req.url.slice(1);
    if (!files.has(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(path.join(root, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.fixture = { granted: false, requests: [], sent: [], writes: 0,
        stored: { endpoint: 'https://previous.example/v1/chat/completions', apiKey: 'fixture-key' } };
      window.chrome = {
        permissions: { request: async p => {
          fixture.requests.push({ ...p, gesture: navigator.userActivation.isActive });
          return fixture.granted;
        } },
        storage: { local: {
          get: async () => structuredClone(fixture.stored),
          set: async values => { fixture.writes++; Object.assign(fixture.stored, values); },
          remove: async key => { delete fixture.stored[key]; },
        } },
        runtime: { sendMessage: async msg => (fixture.sent.push(msg), { ok: true, verdict: { reason: 'fixture' } }) },
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/options.html`);
    assert.equal(await page.title(), 'Messages Control settings');
    await page.locator('#endpoint').fill('https://chosen.example/v1/chat/completions');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText(/Endpoint access was not granted/).waitFor();
    let state = await page.evaluate(() => fixture);
    assert.equal(state.writes, 0);
    assert.equal(state.stored.endpoint, 'https://previous.example/v1/chat/completions');
    assert.deepEqual(state.requests[0], { origins: ['https://chosen.example/*'], gesture: true });
    await page.getByRole('button', { name: 'Test classifier', exact: true }).click();
    assert.equal(await page.evaluate(() => fixture.sent.length), 0, 'denial prevents sending even a test message');
    await page.evaluate(() => { fixture.granted = true; });
    await page.locator('#endpoint').fill('http://localhost:8080/v1/chat/completions');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Saved.', { exact: true }).waitFor();
    state = await page.evaluate(() => fixture);
    assert.equal(state.stored.endpoint, 'http://localhost:8080/v1/chat/completions');
    assert.deepEqual(state.requests.at(-1).origins, ['http://localhost/*']);
    await page.locator('#sample').fill('From: Fixture sender\nSynthetic message');
    await page.getByRole('button', { name: 'Test classifier', exact: true }).click();
    await page.waitForFunction(() => fixture.sent.length === 1);
    assert.equal(await page.evaluate(() => fixture.sent[0].thread.text), 'Synthetic message');
    await page.locator('#endpoint').fill('file:///tmp/messages');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText(/HTTP or HTTPS endpoint/).waitFor();
    assert.equal(await page.evaluate(() => fixture.stored.endpoint), 'http://localhost:8080/v1/chat/completions');
    assert.deepEqual(errors, []);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'settings should fit a narrow window');
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
