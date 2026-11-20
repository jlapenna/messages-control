import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/db.js';
import { digestText, inspectDigestSchedule, parseSince, recordDigestSchedule } from '../src/digest.js';

test('parseSince reads h, d and m', () => {
  assert.equal(parseSince('24h'), 86400000);
  assert.equal(parseSince('7d'), 7 * 86400000);
  assert.equal(parseSince('90m'), 90 * 60000);
  assert.equal(parseSince(undefined), 86400000);
  assert.throws(() => parseSince('soon'), /--since/);
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

test('digest --send awaits notify.command and fails non-zero when delivery fails', () => {
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
  const okMeta = dbAfterOk.getMeta('lastDigest');
  const okSuccess = dbAfterOk.getMeta('lastDigestSuccess');
  dbAfterOk.close();
  assert.equal(okMeta.ok, true);
  assert.equal(okMeta.delivered, 1);
  assert.equal(okSuccess, okMeta.time);

  fs.writeFileSync(cfg, JSON.stringify({ notify: { events: ['digest'], command: 'exit 3' } }));
  assert.throws(
    () => execFileSync(process.execPath, [bin, 'digest', '--send'], { env, encoding: 'utf8', stdio: 'pipe' }),
    (err) => err.status === 1 && /digest delivery failed \(0\/1 channel\(s\) succeeded\)/.test(err.stderr),
  );
  const dbAfterFail = new Db(path.join(dir, 'state', 'state.db'));
  const failMeta = dbAfterFail.getMeta('lastDigest');
  const failSuccess = dbAfterFail.getMeta('lastDigestSuccess');
  dbAfterFail.close();
  assert.equal(failMeta.ok, false);
  assert.equal(failMeta.delivered, 0);
  assert.equal(failSuccess, okSuccess);
});

test('inspectDigestSchedule resolves effective systemd state dir across env, drop-ins and flags', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-timer-'));
  const homeDir = path.join(root, 'home');
  const unitDir = path.join(root, 'systemd', 'user');
  const wantsDir = path.join(unitDir, 'timers.target.wants');
  const dropInDir = path.join(unitDir, 'messages-control-digest.service.d');
  const defaultDir = path.join(homeDir, '.local', 'state', 'messages-control');
  const stateA = path.join(root, 'state-a');
  const stateB = path.join(root, 'state-b');
  const stateSpaced = path.join(root, 'Message State');
  const stateDropIn = path.join(root, 'state-dropin');
  for (const d of [wantsDir, dropInDir, defaultDir, stateA, stateB, stateSpaced, stateDropIn]) {
    fs.mkdirSync(d, { recursive: true });
  }

  const timerFile = path.join(unitDir, 'messages-control-digest.timer');
  const serviceFile = path.join(unitDir, 'messages-control-digest.service');
  const wantLink = path.join(wantsDir, 'messages-control-digest.timer');
  const noSystemd = async () => null;
  const baseArgv = ['/usr/bin/node', '/app/bin/messages-control.js', 'digest', '--send'];

  // Not enabled yet.
  assert.deepEqual(
    await inspectDigestSchedule(defaultDir, { unitDir, homeDir, querySystemd: noSystemd }),
    { scheduled: false, sinceMs: null },
  );

  fs.writeFileSync(timerFile, '[Timer]\nOnCalendar=*-*-* 08:00:00\n');
  fs.symlinkSync(timerFile, wantLink);
  // Missing service unit.
  assert.deepEqual(
    await inspectDigestSchedule(defaultDir, { unitDir, homeDir, querySystemd: noSystemd }),
    { scheduled: false, sinceMs: null },
  );

  // Watcher's own XDG_STATE_HOME override must NOT leak into the digest unit's default path.
  fs.writeFileSync(serviceFile, '[Service]\nType=oneshot\nExecStart=/usr/bin/node /app/bin/messages-control.js digest --send\n');
  const watcherCustomXdg = path.join(root, 'watcher-xdg', 'messages-control');
  fs.mkdirSync(watcherCustomXdg, { recursive: true });
  assert.equal((await inspectDigestSchedule(defaultDir, { unitDir, homeDir, querySystemd: noSystemd })).scheduled, true);
  assert.equal((await inspectDigestSchedule(watcherCustomXdg, { unitDir, homeDir, querySystemd: noSystemd })).scheduled, false);

  // Live probe uses loaded systemd argv[] and raw managerEnv (including paths with spaces),
  // ignoring un-reloaded edits on disk.
  fs.writeFileSync(serviceFile, `[Service]\nType=oneshot\nExecStart=/usr/bin/node /app/bin/messages-control.js digest --send --state-dir ${stateB}\n`);
  const managerQuery = async () => ({
    enabled: true,
    execStarts: [baseArgv],
    envAssignments: [],
    envFiles: [],
    workingDirectory: homeDir,
    managerEnv: { HOME: homeDir, MESSAGES_CONTROL_STATE: stateSpaced },
    sinceMs: 1700000000000,
  });
  assert.deepEqual(
    await inspectDigestSchedule(stateSpaced, { unitDir, homeDir, querySystemd: managerQuery }),
    { scheduled: true, sinceMs: 1700000000000 },
  );
  assert.deepEqual(
    await inspectDigestSchedule(stateB, { unitDir, homeDir, querySystemd: managerQuery }),
    { scheduled: false, sinceMs: null },
  );

  // Explicit --state-dir A in loaded argv[] overrides manager env and matches only A.
  const argQuery = async () => ({
    enabled: true,
    execStarts: [[...baseArgv, '--state-dir', stateA]],
    envAssignments: [],
    envFiles: [],
    workingDirectory: homeDir,
    managerEnv: { HOME: homeDir, MESSAGES_CONTROL_STATE: stateSpaced },
    sinceMs: 1700000000000,
  });
  assert.equal((await inspectDigestSchedule(stateA, { unitDir, homeDir, querySystemd: argQuery })).scheduled, true);
  assert.equal((await inspectDigestSchedule(stateB, { unitDir, homeDir, querySystemd: argQuery })).scheduled, false);

  // EnvironmentFile= overrides Environment= per systemd.exec(5) in both live and fallback paths.
  const envFile = path.join(root, 'digest.env');
  fs.writeFileSync(envFile, `MESSAGES_CONTROL_STATE=${stateB}\n`);
  const envPrecedenceQuery = async () => ({
    enabled: true,
    execStarts: [baseArgv],
    envAssignments: [`MESSAGES_CONTROL_STATE=${stateA}`],
    envFiles: [envFile],
    workingDirectory: homeDir,
    managerEnv: { HOME: homeDir },
    sinceMs: 1700001000000,
  });
  assert.equal((await inspectDigestSchedule(stateB, { unitDir, homeDir, querySystemd: envPrecedenceQuery })).scheduled, true);
  assert.equal((await inspectDigestSchedule(stateA, { unitDir, homeDir, querySystemd: envPrecedenceQuery })).scheduled, false);

  // Filesystem fallback also applies EnvironmentFile= after Environment= across drop-ins.
  fs.writeFileSync(serviceFile, `[Service]\nType=oneshot\nEnvironment=MESSAGES_CONTROL_STATE=${stateA}\nExecStart=/usr/bin/node /app/bin/messages-control.js digest --send\n`);
  const dropIn = path.join(dropInDir, '10-state.conf');
  fs.writeFileSync(dropIn, `[Service]\nEnvironmentFile=-${envFile}\n`);
  assert.equal((await inspectDigestSchedule(stateB, { unitDir, homeDir, querySystemd: noSystemd })).scheduled, true);
  assert.equal((await inspectDigestSchedule(stateA, { unitDir, homeDir, querySystemd: noSystemd })).scheduled, false);

  // An enabled timer with no ActiveEnterTimestamp (e.g. stopped/failed) remains scheduled=true
  // and falls back to the enablement symlink timestamp so staleness alerts still fire.
  const stoppedButEnabledQuery = async () => ({
    enabled: true,
    execStarts: [[...baseArgv, '--state-dir', stateDropIn]],
    envAssignments: [],
    envFiles: [],
    workingDirectory: homeDir,
    managerEnv: { HOME: homeDir },
    sinceMs: null,
  });
  const stoppedRes = await inspectDigestSchedule(stateDropIn, { unitDir, homeDir, querySystemd: stoppedButEnabledQuery });
  assert.equal(stoppedRes.scheduled, true);
  assert.equal(typeof stoppedRes.sinceMs, 'number');

  // Disabled/masked timer returns scheduled=false even if unit files exist.
  const disabledQuery = async () => ({ enabled: false });
  assert.deepEqual(
    await inspectDigestSchedule(stateB, { unitDir, homeDir, querySystemd: disabledQuery }),
    { scheduled: false, sinceMs: null },
  );

  // Without --send, the unit does not deliver or record digest success.
  fs.writeFileSync(serviceFile, `[Service]\nType=oneshot\nExecStart=/usr/bin/node /app/bin/messages-control.js digest --state-dir ${stateA}\n`);
  assert.equal((await inspectDigestSchedule(stateA, { unitDir, homeDir, querySystemd: noSystemd })).scheduled, false);
});

test('recordDigestSchedule persists schedule start across restarts and clears when unscheduled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sched-db-'));
  const dbPath = path.join(dir, 'state.db');
  const db1 = new Db(dbPath);
  assert.deepEqual(recordDigestSchedule(db1, { scheduled: false, sinceMs: null }, 1700000000000), { scheduled: false, sinceMs: 0 });
  assert.deepEqual(recordDigestSchedule(db1, { scheduled: true, sinceMs: 1700000500000 }, 1700001000000), { scheduled: true, sinceMs: 1700000500000 });
  db1.close();

  // Reopen DB (simulating watcher restart): original sinceMs stays durable even if systemd reports a newer boot timestamp.
  const db2 = new Db(dbPath);
  assert.deepEqual(recordDigestSchedule(db2, { scheduled: true, sinceMs: 1700050000000 }, 1700060000000), { scheduled: true, sinceMs: 1700000500000 });
  // Disabling clears the stored timestamp; re-enabling starts a fresh deadline.
  assert.deepEqual(recordDigestSchedule(db2, { scheduled: false, sinceMs: null }, 1700070000000), { scheduled: false, sinceMs: 0 });
  assert.deepEqual(recordDigestSchedule(db2, { scheduled: true, sinceMs: null }, 1700080000000), { scheduled: true, sinceMs: 1700080000000 });
  db2.close();
});
