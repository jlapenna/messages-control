// A plain-text summary of what happened, from the events table.
const ACTED = /^(blocked|deleted|archived)/;
const PERIOD = { h: 3600000, d: 86400000, m: 60000 };

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
