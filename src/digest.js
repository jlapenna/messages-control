import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

function parseEnvFile(filePath, target) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return;
  }
  for (const raw of content.replace(/\\\r?\n/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    target[key] = val;
  }
}

function parseServiceUnit(content, state) {
  const lines = content.replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  let inService = false;
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
      if (!val) state.execStarts = [];
      else state.execStarts.push(val);
      continue;
    }
    const envFileMatch = /^EnvironmentFile\s*=\s*(.*)$/.exec(line);
    if (envFileMatch) {
      const val = envFileMatch[1].trim();
      if (!val) state.envFiles = [];
      else state.envFiles.push(val);
      continue;
    }
    const envMatch = /^Environment\s*=\s*(.*)$/.exec(line);
    if (envMatch) {
      const val = envMatch[1].trim();
      if (!val) state.envAssignments = [];
      else state.envAssignments.push(...splitUnitArgs(val));
      continue;
    }
    const wdMatch = /^WorkingDirectory\s*=\s*(.*)$/.exec(line);
    if (wdMatch) {
      state.workingDirectory = wdMatch[1].trim().replace(/^-/, '');
    }
  }
}

function parseEnvAssignments(entries, target) {
  for (const pair of entries) {
    const eq = pair.indexOf('=');
    if (eq > 0) target[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
}

function resolveEffectiveStateDir({ execStarts, envAssignments, envFiles, managerEnv = {}, homeDir = os.homedir(), workingDirectory = '' }) {
  // Apply systemd.exec(5) precedence: user-manager env -> Environment= -> EnvironmentFile= -> CLI --state-dir.
  const effectiveEnv = { ...managerEnv };
  parseEnvAssignments(envAssignments, effectiveEnv);
  for (const file of envFiles) {
    const cleaned = String(file ?? '').replace(/^-/, '');
    if (cleaned) parseEnvFile(cleaned, effectiveEnv);
  }

  const effectiveHome = effectiveEnv.HOME || homeDir;
  const fallbackStateDir =
    effectiveEnv.MESSAGES_CONTROL_STATE ||
    path.join(effectiveEnv.XDG_STATE_HOME || path.join(effectiveHome, '.local', 'state'), 'messages-control');
  const rawWd = String(workingDirectory ?? '').replace(/^!/, '');
  const baseDir = !rawWd || rawWd === '~' ? effectiveHome : rawWd.startsWith('~/') ? path.join(effectiveHome, rawWd.slice(2)) : rawWd;

  const matches = [];
  for (const argv of execStarts) {
    if (!argv.includes('digest') || !argv.includes('--send')) continue;
    let serviceStateDir = fallbackStateDir;
    let invalid = false;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--state-dir') {
        if (i + 1 >= argv.length) {
          invalid = true;
          break;
        }
        serviceStateDir = argv[++i];
      } else if (argv[i].startsWith('--state-dir=')) {
        serviceStateDir = argv[i].slice('--state-dir='.length);
      }
    }
    if (!invalid && serviceStateDir) matches.push(canonicalPath(serviceStateDir, baseDir));
  }
  return matches;
}

function unitFilesMatchStateDir(unitFiles, targetStateDir, { managerEnv = {}, homeDir = os.homedir(), workingDirectory } = {}) {
  const state = { execStarts: [], envFiles: [], envAssignments: [], workingDirectory: workingDirectory ?? '' };
  let readAny = false;
  for (const file of unitFiles) {
    if (!file) continue;
    try {
      const text = fs.readFileSync(file, 'utf8');
      parseServiceUnit(text, state);
      readAny = true;
    } catch {}
  }
  if (!readAny || !state.execStarts.length) return false;
  const expected = canonicalPath(targetStateDir);
  const dirs = resolveEffectiveStateDir({
    execStarts: state.execStarts.map(splitUnitArgs),
    envAssignments: state.envAssignments,
    envFiles: state.envFiles,
    managerEnv,
    homeDir,
    workingDirectory: state.workingDirectory,
  });
  return dirs.includes(expected);
}

const ENABLED_UNIT_STATES = new Set(['enabled', 'enabled-runtime', 'linked', 'linked-runtime']);

function parseJsonLines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function busctlJson(args) {
  const { stdout } = await execFileAsync('busctl', ['--user', '--json=short', ...args], {
    timeout: 3000,
    encoding: 'utf8',
  });
  return parseJsonLines(stdout);
}

// Queries systemd's live in-memory manager state via D-Bus JSON (busctl),
// returning exact loaded ExecStart argv[], Environment, EnvironmentFiles,
// WorkingDirectory, and raw user-manager Environment without shell-quoting.
async function defaultQuerySystemd() {
  try {
    const [loadTimer] = await busctlJson([
      'call',
      'org.freedesktop.systemd1',
      '/org/freedesktop/systemd1',
      'org.freedesktop.systemd1.Manager',
      'LoadUnit',
      's',
      'messages-control-digest.timer',
    ]);
    const timerPath = loadTimer?.data?.[0];
    if (!timerPath) return { enabled: false };

    const [timerProps, timerUnitProp] = await Promise.all([
      busctlJson([
        'get-property',
        'org.freedesktop.systemd1',
        timerPath,
        'org.freedesktop.systemd1.Unit',
        'LoadState',
        'UnitFileState',
        'ActiveEnterTimestamp',
      ]),
      busctlJson([
        'get-property',
        'org.freedesktop.systemd1',
        timerPath,
        'org.freedesktop.systemd1.Timer',
        'Unit',
      ]),
    ]);
    const loadState = timerProps[0]?.data;
    const unitFileState = timerProps[1]?.data;
    const activeEnterUs = Number(timerProps[2]?.data ?? 0);
    if (loadState !== 'loaded' || !ENABLED_UNIT_STATES.has(unitFileState)) {
      return { enabled: false };
    }

    const serviceUnit = timerUnitProp[0]?.data || 'messages-control-digest.service';
    const [loadSvc] = await busctlJson([
      'call',
      'org.freedesktop.systemd1',
      '/org/freedesktop/systemd1',
      'org.freedesktop.systemd1.Manager',
      'LoadUnit',
      's',
      serviceUnit,
    ]);
    const svcPath = loadSvc?.data?.[0];
    if (!svcPath) return { enabled: false };

    const [svcUnitProps, svcProps, mgrEnvProps] = await Promise.all([
      busctlJson([
        'get-property',
        'org.freedesktop.systemd1',
        svcPath,
        'org.freedesktop.systemd1.Unit',
        'LoadState',
      ]),
      busctlJson([
        'get-property',
        'org.freedesktop.systemd1',
        svcPath,
        'org.freedesktop.systemd1.Service',
        'ExecStart',
        'Environment',
        'EnvironmentFiles',
        'WorkingDirectory',
      ]),
      busctlJson([
        'get-property',
        'org.freedesktop.systemd1',
        '/org/freedesktop/systemd1',
        'org.freedesktop.systemd1.Manager',
        'Environment',
      ]),
    ]);
    if (svcUnitProps[0]?.data !== 'loaded') return { enabled: false };

    const execStarts = (svcProps[0]?.data ?? []).map((entry) => entry?.[1]).filter(Array.isArray);
    const envAssignments = Array.isArray(svcProps[1]?.data) ? svcProps[1].data : [];
    const envFiles = (svcProps[2]?.data ?? []).map((entry) => entry?.[0]).filter(Boolean);
    const workingDirectory = typeof svcProps[3]?.data === 'string' ? svcProps[3].data : '';
    const managerEnv = {};
    parseEnvAssignments(Array.isArray(mgrEnvProps[0]?.data) ? mgrEnvProps[0].data : [], managerEnv);

    return {
      enabled: true,
      execStarts,
      envAssignments,
      envFiles,
      workingDirectory,
      managerEnv,
      sinceMs: Number.isFinite(activeEnterUs) && activeEnterUs > 0 ? Math.floor(activeEnterUs / 1000) : null,
    };
  } catch {
    return null;
  }
}

function timerWantMtimeMs(unitDir) {
  if (!unitDir) return null;
  const timerWant = path.join(unitDir, 'timers.target.wants', 'messages-control-digest.timer');
  try {
    if (fs.realpathSync(timerWant) === '/dev/null') return null;
    return Math.floor(fs.lstatSync(timerWant).mtimeMs);
  } catch {
    return null;
  }
}

// Resolves whether messages-control-digest.timer is enabled to run
// `digest --send` against targetStateDir, using systemd's loaded in-memory
// unit and user-manager environment (or unit files + drop-ins when systemd is
// unavailable). Remains true even if an enabled timer has stopped or failed so
// staleness alerts still fire.
export async function inspectDigestSchedule(targetStateDir, { unitDir, homeDir = os.homedir(), managerEnv, querySystemd = defaultQuerySystemd } = {}) {
  if (!targetStateDir) return { scheduled: false, sinceMs: null };
  const live = querySystemd ? await querySystemd() : null;
  if (live) {
    if (!live.enabled) return { scheduled: false, sinceMs: null };
    const expected = canonicalPath(targetStateDir);
    const dirs = resolveEffectiveStateDir({
      execStarts: live.execStarts ?? [],
      envAssignments: live.envAssignments ?? [],
      envFiles: live.envFiles ?? [],
      managerEnv: live.managerEnv ?? {},
      homeDir,
      workingDirectory: live.workingDirectory ?? '',
    });
    const matches = dirs.includes(expected);
    const sinceMs = live.sinceMs ?? timerWantMtimeMs(unitDir);
    return { scheduled: matches, sinceMs: matches ? sinceMs : null };
  }
  if (!unitDir) return { scheduled: false, sinceMs: null };
  const sinceMs = timerWantMtimeMs(unitDir);
  if (sinceMs == null) return { scheduled: false, sinceMs: null };
  const dropInDir = path.join(unitDir, 'messages-control-digest.service.d');
  let dropIns = [];
  try {
    dropIns = fs
      .readdirSync(dropInDir)
      .filter((f) => f.endsWith('.conf'))
      .sort()
      .map((f) => path.join(dropInDir, f));
  } catch {}
  const unitFiles = [path.join(unitDir, 'messages-control-digest.service'), ...dropIns];
  const matches = unitFilesMatchStateDir(unitFiles, targetStateDir, {
    managerEnv: managerEnv ?? { HOME: homeDir },
    homeDir,
  });
  return { scheduled: matches, sinceMs: matches ? sinceMs : null };
}

// Persists a durable schedule-start timestamp in state.db so first-delivery
// deadlines survive watcher restarts and start when the schedule activates.
export function recordDigestSchedule(db, status, now = Date.now()) {
  const scheduled = typeof status === 'object' && status !== null ? Boolean(status.scheduled) : Boolean(status);
  const hint = typeof status === 'object' && status !== null && typeof status.sinceMs === 'number' ? status.sinceMs : null;
  let stored = db.getMeta('digestScheduledSince');
  if (scheduled) {
    if (typeof stored !== 'number' || stored <= 0) {
      stored = hint && hint > 0 && hint <= now ? hint : now;
      db.setMeta('digestScheduledSince', stored);
    }
    return { scheduled: true, sinceMs: stored };
  }
  if (stored != null) db.setMeta('digestScheduledSince', null);
  return { scheduled: false, sinceMs: 0 };
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
