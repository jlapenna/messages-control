import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { Db } from '../src/db.js';
import { Store } from '../src/store.js';
import { startApi } from '../src/api.js';
import { DEFAULTS } from '../settings.js';

vm.runInThisContext(fs.readFileSync(new URL('../policy.js', import.meta.url), 'utf8'), { filename: 'policy.js' });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-api-'));
const db = new Db(path.join(dir, 'state.db'));
const store = new Store(path.join(dir, 'state.json'));
store.set({ verdicts: { t1: { label: 'spam', score: 0.6, reason: 'maybe', time: 2 }, t2: { label: 'ok', score: 0.1, time: 1 } }, lastScan: { time: 1700000000000, summary: '25 threads listed' } });
db.recordEvent({ time: Date.now() - 1000, label: 'spam', threadId: 't1', name: '+1 555', outcome: 'blocked & reported', reason: 'r', score: 0.9, rule: 'spam-block' });
const settings = { ...DEFAULTS, mode: 'full', dryRun: true, apiKey: 'k' };
const delivered = [];
let healthy = { ok: true, alive: true, paired: true };
const server = await startApi({
  settings, port: 0, token: 'secret-token', db, store,
  backend: { stats: { calls: 3, failures: 1, ms: 1500 } },
  health: async () => healthy,
  deliver: async (msg) => (delivered.push(msg), { ok: true, row: { outcome: 'done' }, summary: 'scanned' }),
  policy: globalThis.MessagesPolicy,
  log: () => {},
});
const base = `http://127.0.0.1:${server.address().port}`;
const auth = { Authorization: 'Bearer secret-token' };
after(() => { server.close(); db.close(); });

test('healthz follows the health check', async () => {
  let res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  healthy = { ok: false, alive: true, paired: false };
  res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 503);
  healthy = { ok: true, alive: true, paired: true };
});

test('metrics is Prometheus text and needs no token', async () => {
  const res = await fetch(`${base}/metrics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  const text = await res.text();
  assert.match(text, /^# TYPE messages_control_up gauge$/m);
  assert.match(text, /^messages_control_healthy 1$/m);
  assert.match(text, /^messages_control_events_total\{outcome="blocked"\} 1$/m);
  assert.match(text, /^messages_control_verdicts\{label="spam"\} 1$/m);
  assert.match(text, /^messages_control_llm_calls_total 3$/m);
  assert.match(text, /^messages_control_llm_seconds_total 1\.500$/m);
  assert.match(text, /^messages_control_dry_run 1$/m);
  assert.match(text, /^messages_control_last_scan_timestamp_seconds 1700000000$/m);
});

test('a foreign Host header is refused (DNS rebinding)', async () => {
  const res = await fetch(`${base}/healthz`, { headers: { Host: 'evil.example' } });
  assert.equal(res.status, 421);
  assert.equal((await fetch(`${base}/healthz`, { headers: { Host: 'localhost:9' } })).status, 200);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
});

test('the dashboard is served at / and /api needs the token', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Messages Control<\/title>/);
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
  assert.equal((await fetch(`${base}/api/status`, { headers: { Authorization: 'Bearer wrong-token!' } })).status, 401);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test('status, events, review and policies', async () => {
  const status = await (await fetch(`${base}/api/status`, { headers: auth })).json();
  assert.equal(status.mode, 'full');
  assert.equal(status.last24h.blocked, 1);
  assert.equal(status.llm.calls, 3);
  const events = await (await fetch(`${base}/api/events?limit=5`, { headers: auth })).json();
  assert.equal(events[0].name, '+1 555');
  const review = await (await fetch(`${base}/api/review`, { headers: auth })).json();
  assert.deepEqual(review.map((r) => [r.id, r.name, r.decision.rule]), [['t1', '+1 555', 'spam-review']]);
  assert.equal(review[0].text, undefined);
  const policies = await (await fetch(`${base}/api/policies`, { headers: auth })).json();
  assert.ok(policies.rules.some((r) => r.name === 'spam-review'));
});

test('act, undo and scan go to the page; live follows dryRun', async () => {
  const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/act', { id: 't1' })).status, 400);
  assert.equal((await post('/api/act', { id: 't1', action: 'keep' })).status, 200);
  assert.deepEqual(delivered.at(-1), { type: 'act', id: 't1', action: 'keep', live: false });
  assert.equal((await post('/api/undo', { event: 1 })).status, 200);
  assert.equal(delivered.at(-1).type, 'undo');
  assert.equal(delivered.at(-1).kind, 'blocked');
  assert.equal((await post('/api/undo', { event: 999 })).status, 404);
  const scan = await (await post('/api/scan', { includeSeen: true })).json();
  assert.equal(scan.summary, 'scanned');
  assert.deepEqual(delivered.at(-1), { type: 'scanNow', includeSeen: true, checkPictures: false, trashSpam: false, processAll: false });
});
