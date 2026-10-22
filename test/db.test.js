import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Db } from '../src/db.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-db-')), 'state.db');

test('events are appended and read newest first, with counts', () => {
  const db = new Db(tmp());
  const t = Date.now();
  db.recordEvent({ time: t - 3000, label: 'spam', threadId: 'a', name: '+1', outcome: 'blocked & reported', reason: 'x', score: 0.95, rule: 'spam-block', method: 'list-menu' });
  db.recordEvent({ time: t - 2000, label: 'marketing', threadId: 'b', outcome: 'deleted', rule: 'marketing-delete' });
  db.recordEvent({ time: t - 1000, label: 'error', threadId: 'c', outcome: 'classify failed', reason: 'boom' });
  db.recordEvent({ time: t - 500, label: 'spam', threadId: 'd', outcome: 'not deleted: dry run' });
  const rows = db.events({ limit: 2 });
  assert.deepEqual(rows.map((r) => r.thread_id), ['d', 'c']);
  assert.equal(db.events({ since: t - 1500 }).length, 2);
  assert.deepEqual(db.counts(0), { blocked: 1, deleted: 1, archived: 0, dryRun: 1, errors: 1, total: 4 });
  db.close();
});

test('verdicts are mirrored with upserts', () => {
  const file = tmp();
  const db = new Db(file);
  db.syncVerdicts({ a: { label: 'spam', score: 0.9, reason: 'r', version: 7, time: 1, msgTime: 2, text: 'hi' } });
  db.syncVerdicts({ a: { label: 'ok', score: 0.1, version: 7, time: 3 }, b: { label: 'marketing', version: 7 } });
  const rows = db.db.prepare('select thread_id, label, score from verdicts order by thread_id').all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { thread_id: 'a', label: 'ok', score: 0.1 },
    { thread_id: 'b', label: 'marketing', score: null },
  ]);
  db.close();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('event previews remain tied to the action after a newer verdict and a reopen', () => {
  const file = tmp();
  const db = new Db(file);
  const original = 'Original message '.repeat(50);
  db.recordEvent({ threadId: 'a', text: original, outcome: 'blocked & reported' });
  db.recordEvent({ threadId: 'media', text: '', outcome: 'blocked & reported' });
  db.syncVerdicts({ a: { label: 'ok', text: 'A newer, different message' } });
  db.close();
  const reopened = new Db(file);
  assert.equal(reopened.event(1).text, original.slice(0, 500));
  assert.equal(reopened.event(2).text, '', 'an empty media preview remains distinct from a missing snapshot');
  assert.equal(reopened.event(999), undefined);
  reopened.close();
});

test('opening an older database preserves its events and adds nullable previews', () => {
  const file = tmp();
  const old = new DatabaseSync(file);
  old.exec(`create table events (id integer primary key, time integer not null,
    label text, thread_id text, name text, outcome text, reason text, score real, rule text, method text);
    insert into events (id, time, thread_id, outcome) values (7, 123, 'original', 'blocked & reported');`);
  old.close();
  const db = new Db(file);
  assert.equal(db.event(7).thread_id, 'original');
  assert.equal(db.event(7).text, null);
  db.recordEvent({ threadId: 'new', text: 'New saved preview', outcome: 'kept' });
  assert.equal(db.event(8).text, 'New saved preview');
  db.close();
});

test('messages seen arriving are queryable by cursor, thread, direction and text, and pruned by age', () => {
  const db = new Db(tmp());
  const t = Date.now();
  const first = db.recordMessage({ time: t - 3000, threadId: 'a', name: 'Alex', direction: 'in', text: 'Her phone is 555_010%0142', unread: true, listTime: '2:51 PM', msgTime: t - 3000 });
  db.recordMessage({ time: t - 2000, threadId: 'b', name: 'Sam', direction: 'out', text: 'ok' });
  db.recordMessage({ time: t - 1000, threadId: 'a', name: 'Alex', direction: 'in', text: 'x'.repeat(600) });
  assert.deepEqual(first, { id: 1, time: t - 3000, threadId: 'a', name: 'Alex', direction: 'in', text: 'Her phone is 555_010%0142', unread: true, listTime: '2:51 PM', msgTime: t - 3000 });
  assert.deepEqual(db.messages().map((m) => m.id), [3, 2, 1], 'newest first');
  assert.deepEqual(db.messages({ after: 1 }).map((m) => m.id), [2, 3], 'a cursor reads forward');
  assert.deepEqual(db.messages({ thread: 'a' }).map((m) => m.id), [3, 1]);
  assert.deepEqual(db.messages({ direction: 'out' }).map((m) => m.id), [2]);
  assert.deepEqual(db.messages({ q: '_010%' }).map((m) => m.id), [1], 'LIKE wildcards in the query are literal');
  assert.deepEqual(db.messages({ q: 'sam' }).map((m) => m.id), [2], 'the sender name matches too');
  assert.equal(db.message(3).text, 'x'.repeat(600));
  assert.equal(db.pruneMessages(t - 1500), 2);
  assert.deepEqual(db.messages().map((m) => m.id), [3]);
  db.close();
});
