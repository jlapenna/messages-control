// A plain-text summary of what happened, from the events table, plus the
// watcher's in-process daily digest scheduler.
const ACTED = /^(blocked|deleted|archived)/;
const PERIOD = { h: 3600000, d: 86400000, m: 60000 };

// "24h", "7d", "90m" → milliseconds.
export function parseSince(text, fallback = '24h') {
  const m = /^(\d+)([hdm])$/.exec(String(text ?? fallback).trim());
  if (!m) throw new Error(`--since wants a number and h, d or m (got "${text}")`);
  return Number(m[1]) * PERIOD[m[2]];
}

// Parses settings.digest ({ time: "HH:MM", timeZone?: "America/Los_Angeles" }).
// Returns null when disabled (empty time), or { time: "HH:MM", hour, minute, timeZone }.
export function parseDigestScheduleConfig(cfg) {
  if (cfg == null) return null;
  if (typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('digest config must be an object');
  const rawTime = String(cfg.time ?? '').trim();
  const timeZone = String(cfg.timeZone ?? '').trim();
  if (timeZone) {
    try {
      new Intl.DateTimeFormat('en-CA', { timeZone });
    } catch {
      throw new Error(`digest.timeZone is not a valid IANA time zone (got "${timeZone}")`);
    }
  }
  if (!rawTime) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(rawTime);
  if (!m) throw new Error(`digest.time wants HH:MM (got "${rawTime}")`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`digest.time wants 00:00–23:59 (got "${rawTime}")`);
  return {
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    hour,
    minute,
    timeZone,
  };
}

export function localDayAndTime(ms, timeZone = '') {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || undefined,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
}

// Synchronizes the durable digestSchedule record in state.db with config.
// When newly enabled or rescheduled, anchors `since` to now and marks today
// already elapsed if the target time already passed today so enabling mid-day
// waits for the next scheduled slot instead of blasting immediately.
export function syncDigestSchedule(db, scheduleConfig, now = Date.now()) {
  const stored = db.getMeta('digestSchedule');
  if (!scheduleConfig) {
    if (stored != null) db.setMeta('digestSchedule', null);
    return null;
  }
  if (
    stored &&
    stored.enabled === true &&
    stored.time === scheduleConfig.time &&
    (stored.timeZone ?? '') === scheduleConfig.timeZone &&
    typeof stored.since === 'number' &&
    stored.since > 0
  ) {
    return stored;
  }
  const local = localDayAndTime(now, scheduleConfig.timeZone);
  const nowMins = local.hour * 60 + local.minute;
  const targetMins = scheduleConfig.hour * 60 + scheduleConfig.minute;
  const next = {
    enabled: true,
    since: now,
    time: scheduleConfig.time,
    timeZone: scheduleConfig.timeZone,
    lastDay: nowMins >= targetMins ? local.day : null,
  };
  db.setMeta('digestSchedule', next);
  return next;
}

// Runs the configured daily digest inside the watcher process, recording
// scheduled delivery metrics in state.db without logging private digest text.
export function startDigestScheduler({
  db,
  settings,
  notify,
  now = () => Date.now(),
  intervalMs = 30000,
  log = (msg) => console.log(msg),
  warn = (msg) => console.warn(msg),
}) {
  const scheduleConfig = parseDigestScheduleConfig(settings?.digest);
  syncDigestSchedule(db, scheduleConfig, now());
  if (!scheduleConfig) return { stop() {}, tick: async () => false };

  let stopped = false;
  let running = false;

  async function tick() {
    if (stopped || running) return false;
    const startedAt = now();
    const state = syncDigestSchedule(db, scheduleConfig, startedAt);
    if (!state) return false;
    const local = localDayAndTime(startedAt, scheduleConfig.timeZone);
    if (local.hour * 60 + local.minute < scheduleConfig.hour * 60 + scheduleConfig.minute) return false;
    if (state.lastDay === local.day) return false;

    running = true;
    try {
      const text = digestText(db, { since: startedAt - 86400000, now: startedAt });
      const sent = await notify(settings, 'digest', text);
      const delivered = sent.filter(Boolean).length;
      const ok = sent.length > 0 && delivered === sent.length;
      const doneAt = now();
      if (!stopped) {
        db.setMeta('lastDigest', { time: doneAt, ok, delivered, total: sent.length });
        if (ok) db.setMeta('lastDigestSuccess', doneAt);
        db.setMeta('digestSchedule', { ...state, lastDay: local.day });
      }
      if (ok) log(`daily digest sent via ${delivered} channel(s)`);
      else if (!sent.length) warn('daily digest failed: no notify channel configured');
      else warn(`daily digest failed (${delivered}/${sent.length} channel(s) succeeded)`);
      return true;
    } catch (err) {
      const doneAt = now();
      if (!stopped) {
        db.setMeta('lastDigest', { time: doneAt, ok: false, delivered: 0, total: 0 });
        db.setMeta('digestSchedule', { ...state, lastDay: local.day });
      }
      warn(`daily digest failed: ${err?.message ?? String(err)}`);
      return true;
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
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
