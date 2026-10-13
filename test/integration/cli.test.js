// End to end: the real CLI, a real headless Chromium and the real page
// driver against a mock Messages page and a keyword classifier. No Google,
// no network beyond 127.0.0.1. Protects the contract that matters: what
// arrives in the inbox ends up blocked, trashed, archived or kept, and the
// log says so.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock/server.mjs';
import { Db } from '../../src/db.js';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(root, 'bin', 'messages-control.js');
const threads = JSON.parse(fs.readFileSync(path.join(root, 'test/integration/mock/threads.json'), 'utf8'));

let mock;
let work;
let env;
before(async () => {
  mock = await startMock({ threads });
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-e2e-'));
  const config = path.join(work, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ endpoint: mock.endpoint, apiKey: 'mock', model: 'mock', mode: 'full', dryRun: false, api: { port: 0 }, unsubscribeMarketing: true }));
  env = { ...process.env, MESSAGES_CONTROL_CONFIG: config, MESSAGES_CONTROL_MESSAGES_URL: mock.url };
});
after(async () => {
  await mock?.close();
});

const cli = async (...args) => {
  const { stdout, stderr } = await run(process.execPath, [CLI, ...args, '--state-dir', path.join(work, 'state')], { env, timeout: 180000 });
  return stdout + stderr;
};
const events = () => {
  const db = new Db(path.join(work, 'state', 'state.db'));
  try {
    return db.events({ limit: 500 }).map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
const byId = (list, id) => list.filter((a) => a.id === id).map((a) => a.action);

test('a scan over a fresh inbox acts on each thread as the rules say', async () => {
  const out = await cli('scan', '--include-seen', '--live');
  assert.match(out, /\d+ threads listed, \d+ new/);
  const acts = mock.actions();
  assert.deepEqual(byId(acts, 't-scam'), ['block_report'], 'scam → blocked & reported');
  assert.deepEqual(byId(acts, 't-political'), ['block_report'], 'political → blocked & reported');
  assert.deepEqual(byId(acts, 't-marketing'), ['send', 'trash'], 'marketing → STOP reply, then trash');
  assert.equal(acts.find((a) => a.id === 't-marketing' && a.action === 'send')?.text, 'STOP');
  for (const kept of ['t-otp', 't-notice', 't-shipment', 't-friend', 't-contact']) assert.deepEqual(byId(acts, kept), [], `${kept} left alone`);
  const log = events();
  const outcome = (id) => log.find((e) => e.thread_id === id)?.outcome ?? '';
  assert.match(outcome('t-scam'), /^blocked & reported/);
  assert.match(outcome('t-marketing'), /^deleted, replied STOP/);
  assert.match(outcome('t-otp'), /^kept: one-time code, under 6 hours old/);
  assert.match(outcome('t-shipment'), /^kept$/);
  assert.equal(outcome('t-contact'), 'not checked: saved contact');
  assert.equal(log.find((e) => e.thread_id === 't-scam')?.rule, 'spam-block');
  // The contact never reached the classifier; the picture thread did, with its picture.
  const asked = mock.llm();
  assert.ok(!asked.some((q) => /YOU TOOOO/.test(q.text)));
  assert.equal(asked.find((q) => /Measure G/.test(q.text))?.pictures, 1);
  // An MMS still downloading opens to a banner and no message: it waits,
  // unjudged and still new, and its row's layout is saved without its words.
  assert.deepEqual(byId(acts, 't-mms-loading'), []);
  assert.ok(!asked.some((q) => /010-0399/.test(q.text ?? '')));
  assert.equal(outcome('t-mms-loading'), 'waiting for the message to finish loading (1/3)');
  const shapes = JSON.parse(fs.readFileSync(path.join(work, 'state', 'state.json'), 'utf8')).loadingRowShapes ?? [];
  assert.equal(shapes.length, 1);
  assert.ok(!/555|0399|Texting/.test(shapes[0].shape), 'no words or numbers in the saved layout');
  // Text shaped like the banner is a message, judged as text.
  assert.deepEqual(byId(acts, 't-fake-banner'), ['block_report']);
});

test('a block can be undone through the Spam & blocked dialog', async () => {
  const blocked = events().find((e) => e.thread_id === 't-scam' && /^blocked/.test(e.outcome));
  assert.ok(blocked, 'the block event exists');
  const out = await cli('undo', String(blocked.id));
  assert.match(out, /unblocked|marked not spam/);
  assert.deepEqual(byId(mock.actions(), 't-scam').at(-1), 'unblock');
  assert.ok(mock.state().threads.find((t) => t.id === 't-scam' && !t.gone), 'the thread is back in the list');
  const undo = events().find((e) => e.thread_id === 't-scam' && e.rule === 'undo');
  assert.equal(undo.text, blocked.text, 'the result keeps the selected block preview after undo clears the verdict text');
});

test('act keeps a thread, and the next scan leaves it alone', async () => {
  const before = mock.actions().length;
  const out = await cli('act', 't-scam', 'keep');
  assert.match(out, /kept by you/);
  await cli('scan', '--include-seen', '--live');
  assert.equal(mock.actions().length, before, 'no new page actions after keep');
});

test('status describes the state', async () => {
  const out = await cli('status');
  assert.match(out, /mode full, live/);
  assert.match(out, /baseline:\s+done/);
});

test('a waiting MMS keeps its look count across scans and is judged on the third', async () => {
  // Look 1 was the first scan, look 2 the scan after "keep"; each is its own process.
  await cli('scan', '--live');
  const looks = events().filter((e) => e.thread_id === 't-mms-loading').map((e) => e.outcome);
  assert.ok(looks.includes('waiting for the message to finish loading (2/3)'), looks.join(' | '));
  assert.ok(!/waiting/.test(looks[0]), `third look judges it: ${looks[0]}`);
  const state = JSON.parse(fs.readFileSync(path.join(work, 'state', 'state.json'), 'utf8'));
  assert.deepEqual(state.newRetries ?? {}, {});
});
