import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { channels, notify, wanted } from '../src/notify.js';

const telegram = { notify: { telegram: { token: 't0k', chatId: '42' } } };

test('channels come from notify.telegram, notify.command and the old notifyCommand', () => {
  assert.deepEqual(channels({}), []);
  assert.deepEqual(channels(telegram).map((c) => c.kind), ['telegram']);
  assert.deepEqual(channels({ notifyCommand: 'x' }).map((c) => c.kind), ['command']);
  assert.deepEqual(channels({ ...telegram, notify: { ...telegram.notify, command: 'y' } }).map((c) => c.kind), ['telegram', 'command']);
});

test('events can be limited', () => {
  assert.equal(wanted({}, 'action'), true);
  assert.equal(wanted({ notify: { events: ['digest'] } }, 'action'), false);
  assert.equal(wanted({ notify: { events: ['digest'] } }, 'digest'), true);
});

test('telegram text goes to sendMessage as JSON', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => (calls.push({ url, init }), new Response('{"ok":true}'));
  const res = await notify(telegram, 'action', 'blocked +1', { fetchImpl });
  assert.deepEqual(res, [true]);
  assert.equal(calls[0].url, 'https://api.telegram.org/bott0k/sendMessage');
  assert.deepEqual(JSON.parse(calls[0].init.body), { chat_id: '42', text: 'blocked +1', disable_web_page_preview: true });
});

test('a photo goes to sendPhoto as multipart with a caption', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-n-')), 'emoji.png');
  fs.writeFileSync(file, 'png');
  const calls = [];
  const fetchImpl = async (url, init) => (calls.push({ url, init }), new Response('{"ok":true}'));
  await notify(telegram, 'pairing-approval', 'tap 590', { photo: file, fetchImpl });
  assert.equal(calls[0].url, 'https://api.telegram.org/bott0k/sendPhoto');
  assert.ok(calls[0].init.body instanceof FormData);
  assert.equal(calls[0].init.body.get('caption'), 'tap 590');
  assert.equal(calls[0].init.body.get('photo').name, 'emoji.png');
});

test('a failing channel is reported, not thrown, and the event filter is honoured', async () => {
  const fetchImpl = async () => new Response('nope', { status: 500 });
  assert.deepEqual(await notify(telegram, 'action', 'x', { fetchImpl }), [false]);
  assert.deepEqual(await notify({ ...telegram, notify: { ...telegram.notify, events: [] } }, 'action', 'x', { fetchImpl }), []);
});
