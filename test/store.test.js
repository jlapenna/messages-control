import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-store-')), 'state.json');

test('get() accepts a key, a list of keys, or defaults like chrome.storage', () => {
  const s = new Store(tmp());
  s.set({ a: 1, b: { x: [1, 2] } });
  assert.deepEqual(s.get('a'), { a: 1 });
  assert.deepEqual(s.get(['a', 'b', 'missing']), { a: 1, b: { x: [1, 2] } });
  assert.deepEqual(s.get({ a: 0, c: 'default' }), { a: 1, c: 'default' });
  assert.deepEqual(s.get(null), { a: 1, b: { x: [1, 2] } });
});

test('get() returns copies, not live references', () => {
  const s = new Store(tmp());
  s.set({ list: [1] });
  s.get('list').list.push(2);
  assert.deepEqual(s.get('list'), { list: [1] });
});

test('flush() writes owner-only and the file reloads', () => {
  const file = tmp();
  const s = new Store(file);
  s.set({ seen: { t1: 5 } });
  s.remove('nothing');
  s.flush();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(new Store(file).get('seen'), { seen: { t1: 5 } });
  s.remove('seen');
  s.flush();
  assert.deepEqual(new Store(file).get('seen'), {});
});

test('a corrupt file is an error, not silent data loss', () => {
  const file = tmp();
  fs.writeFileSync(file, '{not json');
  assert.throws(() => new Store(file), /state\.json/);
});

test('nested settings merge key by key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-cfg-'));
  process.env.MESSAGES_CONTROL_CONFIG = path.join(dir, 'config.json');
  fs.writeFileSync(process.env.MESSAGES_CONTROL_CONFIG, JSON.stringify({ api: { token: 'abc' } }));
  // CONFIG_FILE is read when the module loads, so import it fresh.
  const { loadSettings } = await import(`../src/config.js?${Date.now()}`);
  const s = loadSettings();
  assert.equal(s.api.token, 'abc');
  assert.equal(s.api.port, 7373);
});
