import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { Db } from '../src/db.js';
import { Store } from '../src/store.js';
import { sendRequest, startApi } from '../src/api.js';
import { DEFAULTS } from '../settings.js';

vm.runInThisContext(fs.readFileSync(new URL('../policy.js', import.meta.url), 'utf8'), { filename: 'policy.js' });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-msg-api-'));
const db = new Db(path.join(dir, 'state.db'));
const store = new Store(path.join(dir, 'state.json'));
const messageEvents = new EventEmitter();
const delivered = [];
const page = {
  threads: { ok: true, threads: [{ id: 'a', name: 'Alex', snippet: 'hi', timestamp: '2:51 PM', msgTime: 1, unread: true }] },
  sendMessage: { ok: true, sent: { id: 'a', name: 'Alex', started: false, text: 'on my way' }, row: { label: 'sent' } },
  readMessages: { ok: true, thread: { id: 'a', name: 'Alex', channel: 'rcs', messages: [{ direction: 'in', sender: 'Alex', text: 'hi', images: 0, time: 1, status: null, encrypted: true }] } },
};
const server = await startApi({
  settings: { ...DEFAULTS, apiKey: 'k' }, port: 0, token: 'secret-token', db, store,
  backend: { stats: { calls: 0, failures: 0, ms: 0 } },
  health: async () => ({ ok: true }),
  deliver: async (msg) => (delivered.push(msg), page[msg.type]),
  messageEvents,
  policy: globalThis.MessagesPolicy,
  log: () => {},
});
const base = `http://127.0.0.1:${server.address().port}`;
const auth = { Authorization: 'Bearer secret-token' };
after(() => {
  server.closeAllConnections();
  server.close();
  db.close();
});

// What the runner does when the page reports a new message.
const arrive = (m) => messageEvents.emit('message', db.recordMessage(m));

test('recorded messages are queryable and need the token', async () => {
  arrive({ threadId: 'a', name: 'Alex', direction: 'in', text: 'Her phone is 555.010.0142' });
  arrive({ threadId: 'b', name: 'Sam', direction: 'out', text: 'see you' });
  assert.equal((await fetch(`${base}/api/messages`)).status, 401);
  const all = await (await fetch(`${base}/api/messages`, { headers: auth })).json();
  assert.deepEqual(all.map((m) => m.text), ['see you', 'Her phone is 555.010.0142']);
  const mine = await (await fetch(`${base}/api/messages?thread=a&q=phone`, { headers: auth })).json();
  assert.deepEqual(mine.map((m) => m.id), [1]);
  const forward = await (await fetch(`${base}/api/messages?after=1`, { headers: auth })).json();
  assert.deepEqual(forward.map((m) => m.id), [2]);
});

// Reads server-sent events until n "message" events have arrived.
async function readEvents(res, n) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  while (events.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const fields = Object.fromEntries(block.split('\n').filter((l) => !l.startsWith(':') && l.includes(': ')).map((l) => [l.slice(0, l.indexOf(': ')), l.slice(l.indexOf(': ') + 2)]));
      if (fields.event === 'message') events.push({ id: Number(fields.id), ...JSON.parse(fields.data) });
    }
  }
  await reader.cancel();
  return events;
}

test('the stream replays after a cursor, then pushes new messages as they arrive', async () => {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/messages/stream?after=1&direction=in`, { headers: auth, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/event-stream/);
  const got = readEvents(res, 1);
  // Message 2 is outgoing (filtered out); this one arrives live.
  setTimeout(() => {
    arrive({ threadId: 'b', name: 'Sam', direction: 'out', text: 'filtered' });
    arrive({ threadId: 'c', name: 'Jordan', direction: 'in', text: 'got it, thanks' });
  }, 50);
  const events = await got;
  ac.abort();
  assert.deepEqual(events.map((e) => [e.id, e.name, e.text]), [[4, 'Jordan', 'got it, thanks']]);
});

test('a reconnecting client resumes from Last-Event-ID without losing messages', async () => {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/messages/stream`, { headers: { ...auth, 'Last-Event-ID': '2' }, signal: ac.signal });
  const events = await readEvents(res, 2);
  ac.abort();
  assert.deepEqual(events.map((e) => e.id), [3, 4]);
});

test('threads and one conversation are read live from the page', async () => {
  const list = await (await fetch(`${base}/api/threads?q=ale&limit=5`, { headers: auth })).json();
  assert.equal(list[0].name, 'Alex');
  assert.deepEqual(delivered.at(-1), { type: 'threads', q: 'ale', limit: 5 });
  const thread = await (await fetch(`${base}/api/threads/a/messages?limit=20`, { headers: auth })).json();
  assert.equal(thread.channel, 'rcs');
  assert.equal(thread.messages[0].encrypted, true);
  assert.deepEqual(delivered.at(-1), { type: 'readMessages', id: 'a', limit: 20 });
  page.readMessages = { ok: false, error: 'thread zz is not in the loaded conversation list' };
  assert.equal((await fetch(`${base}/api/threads/zz/messages`, { headers: auth })).status, 404);
  page.readMessages = { ok: false, error: 'a scan is running; try again shortly' };
  assert.equal((await fetch(`${base}/api/threads/a/messages`, { headers: auth })).status, 409);
});

test('a send is checked, then handed to the page', async () => {
  const post = (body, headers = auth) => fetch(`${base}/api/send`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ thread: 'a', text: 'x' }, {})).status, 401);
  const before = delivered.length;
  for (const bad of [{ thread: 'a' }, { thread: 'a', text: '   ' }, { text: 'hi' }, { thread: 'a', to: '5550100142', text: 'hi' }, { to: 'Alex', text: 'hi' }, { to: '12345', text: 'hi' }, { thread: 'a', text: 'x'.repeat(2001) }, { thread: 'a', text: 'two\nlines' }]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(delivered.length, before, 'nothing invalid reaches the page');
  const res = await post({ thread: 'a', text: ' on my way ' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sent.id, 'a');
  assert.deepEqual(delivered.at(-1), { type: 'sendMessage', thread: 'a', to: null, text: 'on my way' });
  await post({ to: '+1 (555) 010-0142', text: 'hi' });
  assert.deepEqual(delivered.at(-1), { type: 'sendMessage', thread: null, to: '+1 (555) 010-0142', text: 'hi' });
  page.sendMessage = { ok: false, error: 'thread zz is not in the loaded conversation list' };
  assert.equal((await post({ thread: 'zz', text: 'hi' })).status, 404);
  page.sendMessage = { ok: false, error: 'Message did not show as sent' };
  assert.equal((await post({ thread: 'a', text: 'hi' })).status, 409);
});

test('sendRequest accepts the usual ways of writing a number', () => {
  for (const to of ['+15550100142', '555-010-0142', '(555) 010-0142', '555.010.0142', '+44 20 7946 0958']) assert.equal(sendRequest({ to, text: 'x' }).to, to);
  assert.match(sendRequest({ to: '555-010-0142; rm', text: 'x' }).error, /phone number/);
});
