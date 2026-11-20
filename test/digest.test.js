import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/db.js';
import { digestText, parseDigestScheduleConfig, parseSince, startDigestScheduler, syncDigestSchedule } from '../src/digest.js';

test('parseSince reads h, d and m', () => {
  assert.equal(parseSince('24h'), 86400000);
  assert.equal(parseSince('7d'), 7 * 86400000);
  assert.equal(parseSince('90m'), 90 * 60000);
  assert.equal(parseSince(undefined), 86400000);
  assert.throws(() => parseSince('soon'), /--since/);
});

test('parseDigestScheduleConfig validates HH:MM and optional timeZone', () => {
  assert.equal(parseDigestScheduleConfig(undefined), null);
  assert.equal(parseDigestScheduleConfig({ time: '' }), null);
  assert.deepEqual(parseDigestScheduleConfig({ time: '8:05', timeZone: 'America/Los_Angeles' }), {
    time: '08:05',
    hour: 8,
    minute: 5,
    timeZone: 'America/Los_Angeles',
  });
  assert.throws(() => parseDigestScheduleConfig('08:00'), /object/);
  assert.throws(() => parseDigestScheduleConfig({ time: '25:00' }), /00:00–23:59/);
  assert.throws(() => parseDigestScheduleConfig({ time: '08:60' }), /00:00–23:59/);
  assert.throws(() => parseDigestScheduleConfig({ time: '8am' }), /HH:MM/);
  assert.throws(() => parseDigestScheduleConfig({ time: '08:00', timeZone: 'Not/A_Zone' }), /IANA/);
});

test('digest summarises actions, dry-run holds and errors', () => {
  const db = new Db(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-d-')), 'state.db'));
  const now = Date.now();
  db.recordEvent({ time: now - 1000, label: 'spam', name: '+1 555', outcome: 'blocked & reported', reason: 'political blast', score: 0.95 });
  db.recordEvent({ time: now - 2000, label: 'marketing', name: '22822', outcome: 'deleted', reason: 'sale' });
  db.recordEvent({ time: now - 3000, label: 'spam', name: '+1 666', outcome: 'not deleted: dry run', reason: 'loan' });
  db.recordEvent({ time: now - 4000, label: 'error', name: '+1 777', outcome: 'classify failed', reason: 'LLM HTTP 503' });
  db.recordEvent({ time: now - 3 * 86400000, label: 'spam', name: 'old', outcome: 'blocked & reported', reason: 'too old to show' });
  db.syncVerdicts({ k1: { label: 'transactional', score: 0.01, reason: 'receipt', time: now - 500, extract: { summary: 'Order 4821 shipped', date: '2026-10-12', amount: '$42.10', code: '1Z999' } } });
  db.recordEvent({ time: now - 400, label: 'transactional', threadId: 'k1', name: 'Amazon', outcome: 'kept' });
  const text = digestText(db, { since: now - 86400000, now });
  assert.match(text, /To keep:\n• Amazon: Order 4821 shipped · 2026-10-12 · \$42\.10 · #1Z999/);
  assert.match(text, /^Messages Control, last 24 h: 1 blocked, 1 deleted, 0 archived, 1 would-be \(dry run\), 1 errors\./);
  assert.match(text, /• blocked \+1 555 \(spam 95%\): political blast/);
  assert.match(text, /• deleted 22822 \(marketing\): sale/);
  assert.match(text, /Dry run held 1 action\(s\): \+1 666/);
  assert.match(text, /Errors: LLM HTTP 503/);
  assert.doesNotMatch(text, /too old/);
  assert.equal(digestText(db, { since: now - 100, now }).split('\n')[1], 'Nothing to report.');
  db.close();
});

test('manual CLI digest --send awaits notify.command, fails non-zero on error, and does not touch scheduled metrics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-digest-cli-'));
  const cfg = path.join(dir, 'config.json');
  const receipt = path.join(dir, 'sent.txt');
  const writer = path.join(dir, 'write.mjs');
  fs.writeFileSync(writer, `import fs from 'node:fs'; setTimeout(() => fs.writeFileSync(${JSON.stringify(receipt)}, process.env.MC_EVENT + ':' + process.env.MC_MESSAGE), 80);`);
  fs.writeFileSync(cfg, JSON.stringify({ notify: { events: ['digest'], command: `${JSON.stringify(process.execPath)} ${JSON.stringify(writer)}` } }));
  const env = { ...process.env, MESSAGES_CONTROL_CONFIG: cfg, MESSAGES_CONTROL_STATE: path.join(dir, 'state') };
  const bin = path.resolve('bin/messages-control.js');

  const out = execFileSync(process.execPath, [bin, 'digest', '--send'], { env, encoding: 'utf8' });
  assert.match(out, /sent via 1 channel\(s\)/);
  assert.match(fs.readFileSync(receipt, 'utf8'), /^digest:Messages Control, last 24 h:/);
  const dbAfterOk = new Db(path.join(dir, 'state', 'state.db'));
  assert.equal(dbAfterOk.getMeta('lastDigest'), null);
  assert.equal(dbAfterOk.getMeta('lastDigestSuccess'), null);
  dbAfterOk.close();

  fs.writeFileSync(cfg, JSON.stringify({ notify: { events: ['digest'], command: 'exit 3' } }));
  assert.throws(
    () => execFileSync(process.execPath, [bin, 'digest', '--send'], { env, encoding: 'utf8', stdio: 'pipe' }),
    (err) => err.status === 1 && /digest delivery failed \(0\/1 channel\(s\) succeeded\)/.test(err.stderr),
  );
  const dbAfterFail = new Db(path.join(dir, 'state', 'state.db'));
  assert.equal(dbAfterFail.getMeta('lastDigest'), null);
  assert.equal(dbAfterFail.getMeta('lastDigestSuccess'), null);
  dbAfterFail.close();
});

test('syncDigestSchedule persists schedule start across restarts, resets on disable/reschedule, and waits if enabled after slot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sched-db-'));
  const dbPath = path.join(dir, 'state.db');
  const t1 = Date.parse('2026-11-20T15:00:00Z'); // 07:00 America/Los_Angeles (before 08:00)
  const t2 = Date.parse('2026-11-20T20:00:00Z'); // 12:00 America/Los_Angeles (after 08:00)
  const cfg8 = parseDigestScheduleConfig({ time: '08:00', timeZone: 'America/Los_Angeles' });
  const cfg20 = parseDigestScheduleConfig({ time: '20:00', timeZone: 'America/Los_Angeles' });

  const db1 = new Db(dbPath);
  assert.equal(syncDigestSchedule(db1, null, t1), null);
  const initial = syncDigestSchedule(db1, cfg8, t1);
  assert.equal(initial.enabled, true);
  assert.equal(initial.since, t1);
  assert.equal(initial.lastDay, null);
  db1.close();

  // Reopen DB (simulating watcher restart): same config keeps original since.
  const db2 = new Db(dbPath);
  const reopened = syncDigestSchedule(db2, cfg8, t2);
  assert.equal(reopened.since, t1);

  // Rescheduling to a different time resets since to now.
  const rescheduled = syncDigestSchedule(db2, cfg20, t2);
  assert.equal(rescheduled.since, t2);
  assert.equal(rescheduled.lastDay, null);

  // Disabling clears metadata; re-enabling after 08:00 marks today elapsed so it waits until tomorrow.
  assert.equal(syncDigestSchedule(db2, null, t2), null);
  assert.equal(db2.getMeta('digestSchedule'), null);
  const reenabled = syncDigestSchedule(db2, cfg8, t2);
  assert.equal(reenabled.since, t2);
  assert.equal(reenabled.lastDay, '2026-11-20');
  db2.close();
});

test('startDigestScheduler delivers once per local day, catches up after downtime, records failures, and never logs digest text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sched-run-'));
  const db = new Db(path.join(dir, 'state.db'));
  let clock = Date.parse('2026-11-20T15:30:00Z'); // 07:30 America/Los_Angeles
  db.recordEvent({ time: clock - 60000, label: 'spam', name: 'Secret Contact', outcome: 'blocked & reported', reason: 'private payload' });

  const sent = [];
  const logs = [];
  const warns = [];
  let notifyResult = [true];
  const scheduler = startDigestScheduler({
    db,
    settings: { digest: { time: '08:00', timeZone: 'America/Los_Angeles' } },
    notify: async (_settings, event, text) => {
      sent.push({ event, text });
      return notifyResult;
    },
    now: () => clock,
    intervalMs: 600000,
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
  });
  try {
    // Before 08:00: does not fire.
    assert.equal(await scheduler.tick(), false);
    assert.equal(sent.length, 0);

    // At 08:05 (e.g. catch-up after restart): fires once and records success.
    clock = Date.parse('2026-11-20T16:05:00Z');
    assert.equal(await scheduler.tick(), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].event, 'digest');
    assert.match(sent[0].text, /Secret Contact/);
    assert.equal(db.getMeta('lastDigest').ok, true);
    assert.equal(db.getMeta('lastDigestSuccess'), clock);
    assert.ok(logs.every((m) => !m.includes('Secret Contact') && !m.includes('private payload')));

    // Second tick same day (or DST fall-back repeat): never double-sends.
    clock = Date.parse('2026-11-20T17:00:00Z');
    assert.equal(await scheduler.tick(), false);
    assert.equal(sent.length, 1);

    // Next day with no notify channels configured: records failure without overwriting lastDigestSuccess.
    const prevSuccess = db.getMeta('lastDigestSuccess');
    notifyResult = [];
    clock = Date.parse('2026-11-21T16:00:00Z');
    assert.equal(await scheduler.tick(), true);
    assert.equal(db.getMeta('lastDigest').ok, false);
    assert.equal(db.getMeta('lastDigestSuccess'), prevSuccess);
    assert.match(warns.at(-1), /no notify channel configured/);
  } finally {
    scheduler.stop();
    db.close();
  }
});
