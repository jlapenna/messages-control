import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DEFAULTS } from '../settings.js';

// policy.js is a plain script shared with the page; load it as the page does.
vm.runInThisContext(fs.readFileSync(new URL('../policy.js', import.meta.url), 'utf8'), { filename: 'policy.js' });
const policy = globalThis.MessagesPolicy;

const base = { ...DEFAULTS, dryRun: false, threshold: 0.8 };
const spam = { ...base, mode: 'spam' };
const full = { ...base, mode: 'full' };
const now = Date.UTC(2026, 9, 10, 12, 0, 0);
const thread = (hoursAgo, recent = false) => ({ msgTime: now - hoursAgo * 3600000, recent });

test('spam mode has only the spam and marketing rules', () => {
  assert.deepEqual(policy.rules(spam).map((r) => r.name), ['spam-block', 'marketing-delete']);
  assert.deepEqual(policy.rules(full).map((r) => r.name), ['spam-block', 'marketing-delete', 'otp-archive', 'notice-archive']);
});

test('spam at or above the threshold is blocked (spamAction) when new, kept when existing', () => {
  const v = { label: 'spam', score: 0.9 };
  assert.deepEqual(policy.decide(v, { isNew: true, settings: spam, thread: thread(1) }), { rule: 'spam-block', action: 'block_report', outcome: 'deleting…', del: true, trash: false });
  assert.equal(policy.decide(v, { isNew: false, settings: spam, thread: thread(1) }).outcome, 'not deleted: existing thread');
  assert.equal(policy.decide(v, { isNew: true, settings: { ...spam, spamAction: 'trash' }, thread: thread(1) }).trash, true);
});

test('spam below the threshold says so and is kept', () => {
  const d = policy.decide({ label: 'spam', score: 0.6 }, { isNew: true, settings: spam, thread: thread(1) });
  assert.equal(d.outcome, 'kept: below 80% threshold');
  assert.equal(d.del, undefined);
});

test('marketing is trashed, never blocked', () => {
  const d = policy.decide({ label: 'marketing', score: 0.1 }, { isNew: true, settings: spam, thread: thread(1) });
  assert.equal(d.rule, 'marketing-delete');
  assert.equal(d.trash, true);
});

test('dry run never deletes', () => {
  const d = policy.decide({ label: 'spam', score: 0.99 }, { isNew: true, settings: { ...spam, dryRun: true }, thread: thread(1) });
  assert.equal(d.outcome, 'not deleted: dry run');
});

test('codes and notices are only archived in full mode, after their hours, and codes only by the model', () => {
  const otp = { label: 'otp', byModel: true };
  assert.equal(policy.decide(otp, { isNew: false, settings: spam, thread: thread(10), now }).outcome, 'kept: one-time code');
  assert.equal(policy.decide(otp, { isNew: false, settings: full, thread: thread(3, true), now }).outcome, 'kept: one-time code, under 6 hours old');
  assert.equal(policy.decide(otp, { isNew: false, settings: full, thread: thread(10, true), now }).archive, true);
  assert.equal(policy.decide({ label: 'otp', byModel: false }, { isNew: false, settings: full, thread: thread(10, true), now }).outcome, 'kept: one-time code');
  assert.equal(policy.decide({ label: 'notice' }, { isNew: false, settings: full, thread: thread(30, true), now }).archive, true);
  assert.equal(policy.decide({ label: 'notice' }, { isNew: false, settings: { ...full, archiveOldNotices: false }, thread: thread(30, true), now }).outcome, 'kept: notification');
});

test('a day-only timestamp counts from the end of that day', () => {
  // 20 hours ago but only known to the day: could be as recent as midnight.
  const d = policy.decide({ label: 'notice' }, { isNew: false, settings: full, thread: thread(20, false), now });
  assert.match(d.outcome, /^kept: notification, under a day old|^archiving/);
  assert.equal(policy.minAgeHours({ msgTime: null }), null);
});

test('config policies replace the defaults and can keep a label', () => {
  const settings = { ...spam, policies: [{ name: 'keep-everything', match: { label: ['spam', 'marketing'] }, action: 'keep' }] };
  assert.equal(policy.decide({ label: 'spam', score: 0.99 }, { isNew: true, settings, thread: thread(1) }).outcome, 'kept');
  assert.equal(policy.decide({ label: 'marketing' }, { isNew: true, settings, thread: thread(1) }).rule, 'keep-everything');
});

test('rules can be turned off and limited to a mode', () => {
  const settings = { ...full, policies: [{ name: 'off', match: { label: ['spam'] }, action: 'trash', enabled: false }, { name: 'spam-only', match: { label: ['spam'] }, action: 'trash', modes: ['spam'] }] };
  assert.equal(policy.decide({ label: 'spam', score: 0.99 }, { isNew: true, settings, thread: thread(1) }).rule, null);
});
