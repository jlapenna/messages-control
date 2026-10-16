// End to end: the real `run` watcher, a real headless Chromium and the page
// driver against the mock page. A text arriving on the phone becomes a
// message event (API query and stream), including one that arrived while
// the watcher was down, a conversation reads back with its channel, and a
// text goes out to a thread or a phone number, from the API and the CLI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock/server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(root, 'bin', 'messages-control.js');
const threads = JSON.parse(fs.readFileSync(path.join(root, 'test/integration/mock/threads.json'), 'utf8'));
const TOKEN = 'test-token';
const rcsThread = {
  id: 't-rcs',
  name: 'Alex Rivera',
  phone: '+15550100142',
  rcs: true,
  snippet: 'Laughed at an image',
  timestamp: 'Fri',
  messages: [{ text: 'Could you reply with their cell numbers?', outgoing: true, at: 'October 15, 2026 at 2:39 PM', status: 'Delivered' }],
};

let mock;
let work;
let env;
let port;
let watcher = null;

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: p } = s.address();
      s.close(() => resolve(p));
    });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = (p, init = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
async function until(fn, timeout = 30000, what = 'condition') {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
}

async function startWatcher() {
  watcher = spawn(process.execPath, [CLI, 'run', '--state-dir', path.join(work, 'state')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  watcher.stdout.on('data', (c) => (out += c));
  watcher.stderr.on('data', (c) => (out += c));
  watcher.output = () => out;
  await until(async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).ok, 90000, () => `healthz (watcher output: ${out.slice(-500)})`);
  // The page's first look at the list is the baseline: wait for it.
  await until(async () => JSON.parse(fs.readFileSync(path.join(work, 'state', 'state.json'), 'utf8')).messageSnapshot, 30000, 'the message baseline');
}
async function stopWatcher() {
  if (!watcher || watcher.exitCode != null) return;
  const exited = new Promise((r) => watcher.once('exit', r));
  watcher.kill('SIGTERM');
  await exited;
}

before(async () => {
  mock = await startMock({ threads: [rcsThread, ...threads] });
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-msg-e2e-'));
  port = await freePort();
  const config = path.join(work, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ endpoint: mock.endpoint, apiKey: 'mock', model: 'mock', mode: 'full', dryRun: true, api: { port, token: TOKEN } }));
  env = { ...process.env, MESSAGES_CONTROL_CONFIG: config, MESSAGES_CONTROL_MESSAGES_URL: mock.url };
  await startWatcher();
});
after(async () => {
  await stopWatcher();
  await mock?.close();
});

// Reads server-sent "message" events until one matches.
async function nextEvent(res, match) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split('\n').find((l) => l.startsWith('data: '));
        if (/^event: message$/m.test(block) && data) {
          const m = JSON.parse(data.slice(6));
          if (match(m)) return m;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

test('the history is the baseline: nothing already listed is an event', async () => {
  assert.deepEqual(await (await api('/api/messages')).json(), []);
});

test('a reply from a saved contact arrives on the stream and in the query', async () => {
  const ac = new AbortController();
  const res = await api('/api/messages/stream', { signal: ac.signal });
  assert.equal(res.status, 200);
  const got = nextEvent(res, (m) => m.threadId === 't-rcs');
  mock.arrive('t-rcs', 'Her phone is 555.010.0142, or 555.010.0187.');
  const m = await Promise.race([got, sleep(30000).then(() => null)]);
  ac.abort();
  assert.ok(m, `no stream event (watcher output: ${watcher.output().slice(-800)})`);
  assert.equal(m.name, 'Alex Rivera');
  assert.equal(m.direction, 'in');
  assert.equal(m.text, 'Her phone is 555.010.0142, or 555.010.0187.');
  const rows = await (await api('/api/messages?thread=t-rcs')).json();
  assert.deepEqual(rows.map((r) => r.text), [m.text]);
});

test('a message sent from the phone is an outgoing event', async () => {
  mock.arrive('t-friend', 'see you at 6', { outgoing: true });
  const rows = await until(async () => {
    const r = await (await api('/api/messages?thread=t-friend')).json();
    return r.length ? r : null;
  }, 20000, 'the outgoing message');
  assert.deepEqual(rows.map((r) => [r.direction, r.text]), [['out', 'see you at 6']]);
});

test('a conversation reads back with its messages, channel and labels', async () => {
  const res = await api('/api/threads/t-rcs/messages');
  assert.equal(res.status, 200);
  const thread = await res.json();
  assert.equal(thread.channel, 'rcs');
  assert.deepEqual(thread.messages.map((x) => [x.direction, x.sender, x.text]), [
    ['out', 'You', 'Could you reply with their cell numbers?'],
    ['in', 'Alex Rivera', 'Her phone is 555.010.0142, or 555.010.0187.'],
  ]);
  assert.equal(thread.messages[0].status, 'delivered');
  assert.equal(thread.messages[0].time, new Date(2026, 9, 15, 14, 39).getTime());
  assert.equal(thread.messages[1].encrypted, true);
  const sms = await (await api('/api/threads/t-friend/messages')).json();
  assert.equal(sms.channel, 'sms');
  const list = await (await api('/api/threads?q=alex')).json();
  assert.deepEqual(list.map((t) => t.id), ['t-rcs']);
  assert.equal((await api('/api/threads/t-missing/messages')).status, 404);
});

test('a message that arrives while the watcher is down is recorded when it is back', async () => {
  await stopWatcher();
  mock.arrive('t-rcs', 'Can you send to Jordan’s phone please?');
  await startWatcher();
  const rows = await until(async () => {
    const r = await (await api('/api/messages?thread=t-rcs')).json();
    return r.length === 2 ? r : null;
  }, 30000, 'the missed message');
  assert.equal(rows[0].text, 'Can you send to Jordan’s phone please?');
});

const post = (p, body) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const outgoing = (thread, text) =>
  until(async () => {
    const r = await (await api(`/api/messages?thread=${thread}&direction=out`)).json();
    return r.find((m) => m.text === text) ?? null;
  }, 20000, `the outgoing "${text}"`);

test('a text sent to a thread goes out and comes back as an outgoing message', async () => {
  const res = await post('/api/send', { thread: 't-friend', text: 'running 5 late' });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.deepEqual([body.sent.id, body.sent.started, body.row.label], ['t-friend', false, 'sent']);
  assert.ok(mock.actions().some((a) => a.action === 'send' && a.id === 't-friend' && a.text === 'running 5 late'));
  await outgoing('t-friend', 'running 5 late');
  assert.equal((await post('/api/send', { thread: 't-nope', text: 'hi' })).status, 404);
  // A number the list shows as a thread's name is that thread, without "Start chat".
  const byNumber = await (await post('/api/send', { to: '+1 555.010.0300', text: 'same thread' })).json();
  assert.deepEqual([byNumber.sent?.id, byNumber.sent?.started], ['t-friend', false], JSON.stringify(byNumber));
});

test('a text to a new number starts a conversation', async () => {
  const res = await post('/api/send', { to: '+1 555-010-0163', text: 'This is the new number' });
  const body = await res.json();
  assert.equal(res.status, 200, `${JSON.stringify(body)} (watcher output: ${watcher.output().slice(-800)})`);
  assert.deepEqual([body.sent.id, body.sent.started], ['t-new-5550100163', true]);
  await outgoing('t-new-5550100163', 'This is the new number');
  const list = await (await api('/api/threads?limit=3')).json();
  assert.equal(list[0].id, 't-new-5550100163', 'listed at the top once written to');
});

test('a saved contact\'s number lands in their conversation, and the CLI sends through the running watcher', async () => {
  const run = (args) =>
    new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, ...args, '--state-dir', path.join(work, 'state')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (c) => (out += c));
      p.stderr.on('data', (c) => (out += c));
      p.on('exit', (code) => resolve({ code, out }));
    });
  const dry = await run(['send', '--to', '555.010.0142', 'not sent']);
  assert.notEqual(dry.code, 0);
  assert.match(dry.out, /--live/);
  const sent = await run(['send', '--to', '555.010.0142', 'Got', 'it,', 'thanks', '--live']);
  assert.equal(sent.code, 0, sent.out);
  assert.match(sent.out, /sent · Alex Rivera · sent "Got it, thanks"/);
  await outgoing('t-rcs', 'Got it, thanks');
  assert.ok(!mock.actions().some((a) => a.text === 'not sent'));
});
