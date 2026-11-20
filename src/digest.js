import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A plain-text summary of what happened, from the events table.
const ACTED = /^(blocked|deleted|archived)/;
const PERIOD = { h: 3600000, d: 86400000, m: 60000 };

function canonicalPath(p, baseDir) {
  const resolved = baseDir ? path.resolve(baseDir, p) : path.resolve(p);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function splitUnitArgs(line) {
  const args = [];
  let cur = '';
  let quote = null;
  let esc = false;
  for (const ch of line) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (quote === '"') {
      if (ch === '\\') esc = true;
      else if (ch === '"') quote = null;
      else cur += ch;
    } else if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '\\') {
      esc = true;
    } else if (/\s/.test(ch)) {
      if (cur) {
        args.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) args.push(cur);
  return args;
}

// True only when messages-control-digest.timer is enabled and its service unit
// runs `digest --send` against the same state directory as this watcher.
export function isDigestTimerScheduled(targetStateDir, { unitDir, defaultStateDir, homeDir = os.homedir() } = {}) {
  if (!unitDir || !targetStateDir) return false;
  const timerWant = path.join(unitDir, 'timers.target.wants', 'messages-control-digest.timer');
  try {
    if (fs.realpathSync(timerWant) === '/dev/null') return false;
  } catch {
    return false;
  }
  let unit;
  try {
    unit = fs.readFileSync(path.join(unitDir, 'messages-control-digest.service'), 'utf8');
  } catch {
    return false;
  }
  const lines = unit.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  let inService = false;
  let execStarts = [];
  const unitEnv = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      inService = sec[1] === 'Service';
      continue;
    }
    if (!inService) continue;
    const execMatch = /^ExecStart\s*=\s*(.*)$/.exec(line);
    if (execMatch) {
      const val = execMatch[1].trim();
      if (!val) execStarts = [];
      else execStarts.push(val);
      continue;
    }
    const envMatch = /^Environment\s*=\s*(.*)$/.exec(line);
    if (envMatch) {
      for (const pair of splitUnitArgs(envMatch[1].trim())) {
        const eq = pair.indexOf('=');
        if (eq > 0) unitEnv[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
    }
  }
  const fallbackStateDir =
    unitEnv.MESSAGES_CONTROL_STATE ||
    (unitEnv.XDG_STATE_HOME ? path.join(unitEnv.XDG_STATE_HOME, 'messages-control') : defaultStateDir);
  const expected = canonicalPath(targetStateDir);
  for (const cmd of execStarts) {
    const args = splitUnitArgs(cmd);
    if (!args.includes('digest') || !args.includes('--send')) continue;
    let serviceStateDir = fallbackStateDir;
    let invalid = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--state-dir') {
        if (i + 1 >= args.length) {
          invalid = true;
          break;
        }
        serviceStateDir = args[++i];
      } else if (args[i].startsWith('--state-dir=')) {
        serviceStateDir = args[i].slice('--state-dir='.length);
      }
    }
    if (!invalid && serviceStateDir && canonicalPath(serviceStateDir, homeDir) === expected) return true;
  }
  return false;
}

// "24h", "7d", "90m" → milliseconds.
export function parseSince(text, fallback = '24h') {
  const m = /^(\d+)([hdm])$/.exec(String(text ?? fallback).trim());
  if (!m) throw new Error(`--since wants a number and h, d or m (got "${text}")`);
  return Number(m[1]) * PERIOD[m[2]];
}

export function digestText(db, { since = Date.now() - 86400000, now = Date.now(), maxLines = 25 } = {}) {
  const events = db.events({ since, limit: 5000 });
  const c = db.counts(since);
  const hours = Math.round((now - since) / 3600000);
  const lines = [`Messages Control, last ${hours >= 48 ? `${Math.round(hours / 24)} days` : `${hours} h`}: ${c.blocked} blocked, ${c.deleted} deleted, ${c.archived} archived, ${c.dryRun} would-be (dry run), ${c.errors} errors.`];
  const acted = events.filter((e) => ACTED.test(e.outcome ?? ''));
  for (const e of acted.slice(0, maxLines)) {
    const verb = e.outcome.startsWith('blocked') ? 'blocked' : e.outcome.startsWith('deleted') ? 'deleted' : 'archived';
    lines.push(`• ${verb} ${e.name ?? '?'} (${e.label}${e.score != null ? ` ${Math.round(e.score * 100)}%` : ''}): ${(e.reason ?? '').slice(0, 90)}`);
  }
  if (acted.length > maxLines) lines.push(`… and ${acted.length - maxLines} more`);
  const keep = db.transactional(since);
  if (keep.length) {
    lines.push('To keep:');
    for (const k of keep.slice(0, 15)) {
      const x = k.extract ?? {};
      const bits = [x.summary ?? k.reason, x.date, x.amount, x.code ? `#${x.code}` : null].filter(Boolean);
      lines.push(`• ${k.name ?? '?'}: ${bits.join(' · ').slice(0, 140)}`);
    }
  }
  const held = events.filter((e) => /not deleted: dry run/.test(e.outcome ?? ''));
  if (held.length) lines.push(`Dry run held ${held.length} action(s): ${[...new Set(held.map((e) => e.name ?? '?'))].slice(0, 8).join(', ')}`);
  const errors = events.filter((e) => e.label === 'error');
  if (errors.length) lines.push(`Errors: ${[...new Set(errors.map((e) => (e.reason ?? e.outcome ?? '').slice(0, 60)))].slice(0, 3).join(' | ')}`);
  const info = events.filter((e) => e.label === 'info').map((e) => e.outcome).filter(Boolean);
  if (info.length) lines.push(`Notes: ${[...new Set(info)].slice(0, 2).join(' | ')}`);
  if (lines.length === 1) lines.push('Nothing to report.');
  return lines.join('\n');
}
