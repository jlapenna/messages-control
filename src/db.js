import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The audit trail, the messages seen arriving and a queryable copy of the
// verdicts, in SQLite
// (state.db next to state.json). events is append-only: the JSON log the
// page keeps is capped at 300 entries, this is the whole history. The page
// itself still reads and writes state.json through the chrome.storage shim.
export class Db {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      pragma journal_mode = wal;
      create table if not exists events (
        id integer primary key,
        time integer not null,
        label text,
        thread_id text,
        name text,
        outcome text,
        reason text,
        score real,
        rule text,
        method text
      );
      create index if not exists events_time on events(time);
      create index if not exists events_thread on events(thread_id);
      create table if not exists messages (
        id integer primary key,
        time integer not null,
        thread_id text not null,
        name text,
        direction text,
        text text,
        unread integer,
        list_time text,
        msg_time integer
      );
      create index if not exists messages_time on messages(time);
      create index if not exists messages_thread on messages(thread_id, id);
      create table if not exists verdicts (
        thread_id text primary key,
        label text not null,
        score real,
        reason text,
        version integer,
        time integer,
        msg_time integer,
        media text,
        text text
      );
    `);
    // Keep the message preview with the action, even when a later verdict
    // changes or the page's bounded activity log expires.
    if (!this.db.prepare('pragma table_info(events)').all().some((c) => c.name === 'text')) {
      this.db.exec('alter table events add column text text');
    }
    // Added later: what a transactional message is about (JSON).
    try {
      this.db.exec('alter table verdicts add column extract text');
    } catch (err) {
      if (!/duplicate column/i.test(err.message)) throw err;
    }
    fs.chmodSync(file, 0o600);
    this.insertEvent = this.db.prepare(
      'insert into events (time, label, thread_id, name, outcome, reason, score, rule, method, text) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.insertMessage = this.db.prepare(
      'insert into messages (time, thread_id, name, direction, text, unread, list_time, msg_time) values (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this.upsertVerdict = this.db.prepare(`
      insert into verdicts (thread_id, label, score, reason, version, time, msg_time, media, text, extract)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(thread_id) do update set label = excluded.label, score = excluded.score, reason = excluded.reason,
        version = excluded.version, time = excluded.time, msg_time = excluded.msg_time, media = excluded.media, text = excluded.text,
        extract = excluded.extract
    `);
  }

  // One log entry (the row content.js logs), as it happened.
  recordEvent(e) {
    this.insertEvent.run(
      e.time ?? Date.now(),
      e.label ?? null,
      e.threadId ?? null,
      e.name ?? null,
      e.outcome ?? null,
      e.reason ?? null,
      e.score ?? null,
      e.rule ?? null,
      e.method ?? null,
      e.text == null ? null : String(e.text).slice(0, 500),
    );
  }

  // One new message seen in the conversation list (message-events.js).
  // Returns the stored row; its id is the cursor for the API and the stream.
  recordMessage(m) {
    const { lastInsertRowid } = this.insertMessage.run(
      m.time ?? Date.now(),
      String(m.threadId),
      m.name ?? null,
      m.direction === 'out' ? 'out' : 'in',
      m.text == null ? null : String(m.text).slice(0, 500),
      m.unread ? 1 : 0,
      m.listTime ?? null,
      m.msgTime ?? null,
    );
    return this.message(Number(lastInsertRowid));
  }

  message(id) {
    const r = this.db.prepare('select * from messages where id = ?').get(id);
    return r ? messageRow(r) : null;
  }

  // Newest first unless after is given (a cursor: rows after that id, oldest
  // first, for following along). q matches the text or the sender's name.
  messages({ after = null, since = 0, thread = null, direction = null, q = null, limit = 100 } = {}) {
    const where = ['time >= ?'];
    const args = [since];
    if (after != null) (where.push('id > ?'), args.push(after));
    if (thread) (where.push('thread_id = ?'), args.push(thread));
    if (direction) (where.push('direction = ?'), args.push(direction));
    if (q) (where.push("(text like ? escape '\\' or name like ? escape '\\')"), args.push(like(q), like(q)));
    const order = after != null ? 'id asc' : 'id desc';
    return this.db.prepare(`select * from messages where ${where.join(' and ')} order by ${order} limit ?`).all(...args, limit).map(messageRow);
  }

  // Message text is personal; it is kept only this long.
  pruneMessages(before) {
    return Number(this.db.prepare('delete from messages where time < ?').run(before).changes);
  }

  // Mirror the page's verdict cache (the whole object, as chrome.storage
  // hands it over); one transaction, upserts only.
  syncVerdicts(verdicts) {
    this.db.exec('begin');
    try {
      for (const [id, v] of Object.entries(verdicts)) {
        this.upsertVerdict.run(id, v.label, v.score ?? null, v.reason ?? null, v.version ?? null, v.time ?? null, v.msgTime ?? null, v.media ?? null, v.text ?? null, v.extract ? JSON.stringify(v.extract) : null);
      }
      this.db.exec('commit');
    } catch (err) {
      this.db.exec('rollback');
      throw err;
    }
  }

  // Transactional verdicts made since a time, with the sender's name.
  transactional(since) {
    return this.db
      .prepare(`select v.thread_id, v.time, v.extract, v.reason, (select name from events e where e.thread_id = v.thread_id and e.name is not null order by e.id desc limit 1) as name
                from verdicts v where v.label = 'transactional' and v.time >= ? order by v.time desc`)
      .all(since)
      .map((r) => ({ ...r, extract: r.extract ? JSON.parse(r.extract) : null }));
  }

  events({ since = 0, limit = 50 } = {}) {
    return this.db.prepare('select * from events where time >= ? order by time desc, id desc limit ?').all(since, limit);
  }

  event(id) {
    return this.db.prepare('select * from events where id = ?').get(id);
  }

  previousAction(event, kind) {
    if (!event.thread_id || !event.name) return null;
    return this.db.prepare(`select * from events where thread_id = ? and name = ? and id < ? and time <= ?
      and (outcome like 'blocked%' or outcome like 'archived%')
      and (? is null or outcome like ? || '%') order by time desc, id desc limit 1`)
      .get(event.thread_id, event.name, event.id, event.time, kind, kind);
  }

  // Outcome counts since a time, for status.
  counts(since) {
    const rows = this.db.prepare('select outcome, label, count(*) n from events where time >= ? group by outcome, label').all(since);
    const sum = (pred) => rows.filter(pred).reduce((n, r) => n + r.n, 0);
    return {
      blocked: sum((r) => /^blocked/.test(r.outcome ?? '')),
      deleted: sum((r) => /^deleted/.test(r.outcome ?? '')),
      archived: sum((r) => /^archived/.test(r.outcome ?? '')),
      dryRun: sum((r) => /not deleted: dry run/.test(r.outcome ?? '')),
      errors: sum((r) => r.label === 'error'),
      total: sum(() => true),
    };
  }

  close() {
    this.db.close();
  }
}

const like = (q) => `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function messageRow(r) {
  return { id: r.id, time: r.time, threadId: r.thread_id, name: r.name, direction: r.direction, text: r.text, unread: !!r.unread, listTime: r.list_time, msgTime: r.msg_time };
}
