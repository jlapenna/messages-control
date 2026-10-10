import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
