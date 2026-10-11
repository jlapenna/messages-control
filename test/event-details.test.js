import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/db.js';
import { Store } from '../src/store.js';
import { eventDetails } from '../src/event-details.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-event-context-'));
const db = new Db(path.join(dir, 'state.db'));
const store = new Store(path.join(dir, 'state.json'));
const record = (e) => {
  db.recordEvent(e);
  return db.event(Number(db.db.prepare('select max(id) id from events').get().id));
};
after(() => { store.flush(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('legacy undo context identifies an earlier action, excludes later messages and never uses the verdict cache', () => {
  const block = record({ time: 10, threadId: 'context', name: 'Sender', label: 'review', rule: 'review', outcome: 'blocked & reported' });
  const undo = record({ time: 20, threadId: 'context', name: 'Sender', label: 'undo', rule: 'undo', outcome: 'unblocked' });
  record({ time: 30, threadId: 'context', name: 'Sender', text: 'Later block preview', outcome: 'blocked & reported' });
  store.set({ log: [{ time: 10, threadId: 'context', name: 'Sender', label: 'review', rule: 'review', outcome: 'blocked & reported', text: 'Earlier original preview' }],
    verdicts: { context: { label: 'ok', text: 'Current message' } } });
  const details = eventDetails(db, store, undo);
  assert.equal(details.text, 'Earlier original preview');
  assert.deepEqual(details.previewSource, { id: block.id, time: 10, outcome: 'blocked & reported' });
  assert.equal(details.outcome, 'unblocked', 'the undo result remains the selected event');
  store.set({ log: [] });
  assert.equal(eventDetails(db, store, undo).text, null, 'no historical evidence means no guessed preview');
});

test('legacy unarchive and undo failures use matching conversation actions, including empty media previews', () => {
  record({ time: 100, threadId: 'archive', name: 'Sender', text: '', outcome: 'archived (by you)' });
  record({ time: 101, threadId: 'archive', name: 'Sender', text: 'Wrong action kind', outcome: 'blocked & reported' });
  record({ time: 102, threadId: 'other', name: 'Sender', text: 'Wrong conversation', outcome: 'archived (by you)' });
  record({ time: 103, threadId: 'archive', name: 'Other sender', text: 'Wrong sender', outcome: 'archived (by you)' });
  const undo = record({ time: 104, threadId: 'archive', name: 'Sender', label: 'undo', rule: 'undo', outcome: 'unarchived' });
  assert.equal(eventDetails(db, store, undo).text, '');
  assert.equal(eventDetails(db, store, undo).previewSource.time, 100);
  const failed = record({ time: 105, threadId: 'archive', name: 'Sender', label: 'error', rule: 'undo', outcome: 'undo failed: fixture error' });
  assert.equal(eventDetails(db, store, failed).text, 'Wrong action kind', 'an old failure shows the latest earlier reversible action as labeled context');
  const unrelated = record({ time: 106, threadId: 'absent', name: 'Sender', label: 'undo', rule: 'undo', outcome: 'unblocked' });
  assert.equal(eventDetails(db, store, unrelated).text, null);
});

test('new undo snapshots take precedence over historical context and survive newer activity', () => {
  record({ time: 200, threadId: 'snapshot', name: 'Sender', text: 'Other block', outcome: 'blocked & reported' });
  const undo = record({ time: 201, threadId: 'snapshot', name: 'Sender', text: 'Selected action message', label: 'undo', rule: 'undo', outcome: 'unblocked' });
  assert.equal(eventDetails(db, store, undo).text, 'Selected action message');
  assert.equal(eventDetails(db, store, undo).previewSource, undefined);
  const media = record({ time: 202, threadId: 'snapshot', name: 'Sender', text: '', label: 'error', rule: 'undo', outcome: 'undo failed: fixture error' });
  assert.equal(eventDetails(db, store, media).text, '');
  const other = record({ time: 203, threadId: 'snapshot', name: 'Sender', label: 'ok', outcome: 'kept' });
  assert.equal(eventDetails(db, store, other).text, null, 'ordinary events do not borrow a different action preview');
});
