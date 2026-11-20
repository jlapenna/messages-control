import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Db } from '../src/db.js';
import { digestText, parseSince } from '../src/digest.js';

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

  fs.writeFileSync(cfg, JSON.stringify({ notify: { events: ['digest'], command: 'exit 3' } }));
  assert.throws(
    () => execFileSync(process.execPath, [bin, 'digest', '--send'], { env, encoding: 'utf8', stdio: 'pipe' }),
    (err) => err.status === 1 && /digest delivery failed \(0\/1 channel\(s\) succeeded\)/.test(err.stderr),
  );
});
