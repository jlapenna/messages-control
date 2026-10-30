import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { eventDetails } from './event-details.js';

// The watcher's local HTTP API, on 127.0.0.1 only.
//   GET  /healthz         200 when paired and the page answers, else 503 (no token)
//   GET  /metrics         Prometheus text (no token)
//   GET  /                the dashboard (asks for the token in the browser)
//   GET  /api/status, /api/events?since&limit, /api/events/:id, /api/review, /api/policies, /api/verdicts
//   GET  /api/messages?after&since&thread&direction&q&limit   new messages seen arriving (recorded)
//   GET  /api/messages/stream?after&thread&direction          the same, live, as server-sent events
//   GET  /api/threads?q&limit                                 the conversation list, live from the page
//   GET  /api/threads/:id/messages?limit                      one conversation, opened (marks it read)
//   POST /api/act {id, action}, /api/undo {event}, /api/scan {includeSeen, checkPictures, trashSpam, processAll}
//   POST /api/send {thread | to, text}                         sends a text now (dry run does not apply)
// /api/* needs "Authorization: Bearer <api.token>".
const DASHBOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard.html');
const START = Date.now();
const REPLAY_PAGE = 500;

// A send request checked before it reaches the page: a text, and exactly
// one of a listed thread's id or a phone number. Returns {thread, to, text}
// or {error}.
export function sendRequest(body) {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  const thread = body?.thread ? String(body.thread) : null;
  const to = body?.to ? String(body.to).trim() : null;
  if (!text) return { error: 'text required' };
  if (text.length > 2000) return { error: 'text is over 2000 characters' };
  // Typing a line break presses Enter, which sends what is typed so far.
  if (/[\r\n]/.test(text)) return { error: 'text must be one line' };
  if (!thread === !to) return { error: 'exactly one of thread (an id) or to (a phone number) required' };
  if (to) {
    const digits = to.replace(/\D/g, '').length;
    if (!/^\+?[\d\s().-]+$/.test(to) || digits < 7 || digits > 15) return { error: `to must be a phone number, not "${to}"` };
  }
  return { thread, to, text };
}

export function startApi({ settings, bind = '127.0.0.1', port, token, hosts = [], db, store, backend, health, deliver, messageEvents = null, policy, log = console.log }) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      send(res, 500, { error: err.message });
    });
  });

  const send = (res, status, body, type = 'application/json') => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': `${type}; charset=utf-8`,
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(data),
      'X-Content-Type-Options': 'nosniff',
      ...(type === 'text/html' ? { 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'" } : {}),
    });
    res.end(data);
  };

  // Only names this server is meant to be reached by are accepted: loopback,
  // the bind address, and api.hosts from the config (a reverse proxy's public
  // name, the tailnet name). A browser sent here by DNS rebinding carries the
  // attacker's Host and is refused.
  const allowed = new Set([bind, '127.0.0.1', 'localhost', '[::1]', ...hosts.map((h) => String(h).toLowerCase())]);
  const hostOk = (req) => {
    const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    return allowed.has(host);
  };

  const authorized = (req) => {
    const given = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
    if (!token || !given || given.length !== token.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(token));
  };

  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 65536) reject(new Error('body too large'));
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new Error('bad JSON'));
        }
      });
    });

  async function handle(req, res) {
    if (!hostOk(req)) return send(res, 421, { error: 'unexpected Host' });
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const h = await health();
      return send(res, h.ok ? 200 : 503, h);
    }
    if (req.method === 'GET' && url.pathname === '/metrics') {
      return send(res, 200, await metrics(), 'text/plain; version=0.0.4');
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(DASHBOARD, 'utf8'), 'text/html');
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (!authorized(req)) return send(res, 401, { error: 'bearer token required (api.token in the config)' });

    if (req.method === 'GET') {
      if (url.pathname === '/api/messages/stream') return stream(req, res, url);
      const threadMatch = /^\/api\/threads\/([^/]+)\/messages$/.exec(url.pathname);
      if (threadMatch) {
        const limit = clamp(url.searchParams.get('limit'), 50, 500);
        const r = await deliver({ type: 'readMessages', id: decodeURIComponent(threadMatch[1]), limit });
        if (!r) return send(res, 409, { ok: false, error: 'no answer from the page' });
        if (!r.ok) return send(res, /not in the loaded/.test(r.error ?? '') ? 404 : 409, r);
        return send(res, 200, r.thread);
      }
      const eventMatch = /^\/api\/events\/(\d+)$/.exec(url.pathname);
      if (eventMatch) {
        const event = db.event(Number(eventMatch[1]));
        if (!event) return send(res, 404, { error: 'event not found' });
        return send(res, 200, eventDetails(db, store, event));
      }
      switch (url.pathname) {
        case '/api/status':
          return send(res, 200, await status());
        case '/api/events': {
          const since = Number(url.searchParams.get('since') ?? 0);
          const limit = Math.min(1000, Number(url.searchParams.get('limit') ?? 100));
          return send(res, 200, db.events({ since, limit }).map(({ text, ...r }) => r));
        }
        case '/api/messages':
          return send(res, 200, db.messages(messageQuery(url)));
        case '/api/threads': {
          const r = await deliver({ type: 'threads', q: url.searchParams.get('q') ?? '', limit: clamp(url.searchParams.get('limit'), 50, 1000) });
          return r?.ok ? send(res, 200, r.threads) : send(res, 409, r ?? { ok: false, error: 'no answer from the page' });
        }
        case '/api/review':
          return send(res, 200, review());
        case '/api/policies':
          return send(res, 200, { mode: settings.mode, dryRun: settings.dryRun, threshold: settings.threshold, spamAction: settings.spamAction, rules: policy.rules(settings) });
        case '/api/verdicts': {
          const { verdicts = {} } = store.get('verdicts');
          return send(res, 200, verdicts);
        }
        default:
          return send(res, 404, { error: 'not found' });
      }
    }
    if (req.method === 'POST') {
      const body = await readJson(req);
      switch (url.pathname) {
        case '/api/act': {
          if (!body.id || !/^(block|trash|archive|keep)$/.test(body.action ?? '')) return send(res, 400, { error: 'id and action (block|trash|archive|keep) required' });
          const r = await deliver({ type: 'act', id: String(body.id), action: body.action, live: !settings.dryRun });
          return send(res, r?.ok ? 200 : 409, r ?? { ok: false, error: 'no answer from the page' });
        }
        case '/api/undo': {
          const event = db.db.prepare('select * from events where id = ?').get(Number(body.event));
          if (!event) return send(res, 404, { error: `no event ${body.event}` });
          const kind = /^blocked/.test(event.outcome ?? '') ? 'blocked' : /^archived/.test(event.outcome ?? '') ? 'archived' : null;
          if (!kind || !event.name) return send(res, 400, { error: `event ${event.id} ("${event.outcome}") cannot be undone` });
          const { text } = eventDetails(db, store, event);
          const r = await deliver({ type: 'undo', kind, name: event.name, threadId: event.thread_id, text });
          return send(res, r?.ok ? 200 : 409, r ?? { ok: false, error: 'no answer from the page' });
        }
        case '/api/send': {
          const request = sendRequest(body);
          if (request.error) return send(res, 400, { ok: false, error: request.error });
          const r = await deliver({ type: 'sendMessage', ...request });
          if (!r) return send(res, 409, { ok: false, error: 'no answer from the page' });
          return send(res, r.ok ? 200 : /not in the loaded/.test(r.error ?? '') ? 404 : 409, r);
        }
        case '/api/scan': {
          const opts = Object.fromEntries(['includeSeen', 'checkPictures', 'trashSpam', 'processAll'].map((k) => [k, !!body[k]]));
          const r = await deliver({ type: 'scanNow', ...opts });
          return send(res, 200, r ?? {});
        }
        default:
          return send(res, 404, { error: 'not found' });
      }
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  const clamp = (value, fallback, max) => {
    const n = Number(value ?? fallback);
    return Number.isFinite(n) && n > 0 ? Math.min(max, Math.floor(n)) : fallback;
  };
  const cursor = (value) => (value != null && /^\d+$/.test(String(value)) ? Number(value) : null);
  function messageQuery(url, { after = cursor(url.searchParams.get('after')) } = {}) {
    const direction = url.searchParams.get('direction');
    return {
      after,
      since: Number(url.searchParams.get('since') ?? 0) || 0,
      thread: url.searchParams.get('thread') || null,
      direction: direction === 'in' || direction === 'out' ? direction : null,
      q: url.searchParams.get('q') || null,
      limit: clamp(url.searchParams.get('limit'), 100, 1000),
    };
  }

  // Server-sent events: one "message" event per new message, its id the
  // row id. With ?after=ID (or the Last-Event-ID a reconnecting client
  // sends) every row after that id is replayed first, so nothing is lost
  // across a reconnect. The replay goes page by page, waits whenever the
  // client is behind (drain) and yields between pages, so a long backlog
  // neither fills memory nor holds up other requests; live messages that
  // arrive meanwhile wait their turn. A comment line every 25 s keeps
  // proxies from timing out.
  function stream(req, res, url) {
    const after = cursor(url.searchParams.get('after') ?? req.headers['last-event-id']);
    const query = messageQuery(url, { after });
    const matches = (m) => (!query.thread || m.threadId === query.thread) && (!query.direction || m.direction === query.direction);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'X-Content-Type-Options': 'nosniff',
    });
    let last = after ?? 0;
    let closed = false;
    let replaying = after != null;
    const waiting = [];
    // False when the client is behind and the replay should wait.
    const write = (m) => {
      if (m.id <= last) return true;
      last = m.id;
      return res.write(`id: ${m.id}\nevent: message\ndata: ${JSON.stringify(m)}\n\n`);
    };
    const drained = () =>
      new Promise((resolve) => {
        const done = () => {
          res.off('drain', done);
          res.off('close', done);
          resolve();
        };
        res.on('drain', done);
        res.on('close', done);
      });
    res.write(`retry: 5000\n: ${settings.messageRetentionDays > 0 ? 'watching for messages' : 'messageRetentionDays is 0: no messages are recorded'}\n\n`);
    // Subscribed before the replay reads anything, so no row falls between
    // the two; the ids drop whatever both deliver.
    const onMessage = (m) => {
      if (!matches(m)) return;
      if (replaying) waiting.push(m);
      else write(m);
    };
    messageEvents?.on('message', onMessage);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    const stop = () => {
      closed = true;
      clearInterval(ping);
      messageEvents?.off('message', onMessage);
    };
    req.on('close', stop);
    res.on('error', stop);
    if (!replaying) return;
    (async () => {
      for (let page; !closed && (!page || page.length === REPLAY_PAGE); ) {
        page = db.messages({ ...query, after: last, limit: REPLAY_PAGE });
        for (const m of page) if (!write(m) && !closed) await drained();
        await new Promise((resolve) => setImmediate(resolve));
      }
      replaying = false;
      for (const m of waiting.splice(0)) if (!closed) write(m);
    })().catch((err) => {
      log(`message stream replay failed: ${err.message}`);
      res.destroy();
    });
  }

  function review() {
    const { verdicts = {} } = store.get('verdicts');
    const names = new Map(db.db.prepare('select thread_id, name from events where name is not null group by thread_id').all().map((r) => [r.thread_id, r.name]));
    return Object.entries(verdicts)
      .map(([id, v]) => ({ id, name: names.get(id) ?? null, ...v, decision: policy.decide(v, { isNew: true, settings: { ...settings, dryRun: false }, thread: { msgTime: v.msgTime, recent: false } }) }))
      .filter((x) => x.decision.hold)
      .sort((a, b) => (b.time ?? 0) - (a.time ?? 0))
      .map(({ text, ...rest }) => rest); // message text stays local
  }

  async function status() {
    const { lastScan, baselined = false } = store.get(['lastScan', 'baselined']);
    const h = await health();
    return {
      ...h,
      mode: settings.mode,
      dryRun: settings.dryRun,
      spamAction: settings.spamAction,
      model: settings.model,
      baselined,
      lastScan: lastScan ? { time: lastScan.time, summary: lastScan.summary } : null,
      last24h: db.counts(Date.now() - 86400000),
      llm: { ...backend.stats, retryAt: backend.pausedUntil || null },
      startedAt: START,
    };
  }

  async function metrics() {
    const h = await health();
    const all = db.counts(0);
    const { verdicts = {} } = store.get('verdicts');
    const labels = {};
    for (const v of Object.values(verdicts)) labels[v.label] = (labels[v.label] ?? 0) + 1;
    const { lastScan } = store.get('lastScan');
    const lines = [
      '# HELP messages_control_up 1 while the watcher process runs.',
      '# TYPE messages_control_up gauge',
      'messages_control_up 1',
      '# HELP messages_control_healthy 1 when paired and the page answers.',
      '# TYPE messages_control_healthy gauge',
      `messages_control_healthy ${h.ok ? 1 : 0}`,
      '# HELP messages_control_paired 1 when the browser profile is paired with the phone.',
      '# TYPE messages_control_paired gauge',
      `messages_control_paired ${h.paired ? 1 : 0}`,
      '# HELP messages_control_dry_run 1 when actions are only logged.',
      '# TYPE messages_control_dry_run gauge',
      `messages_control_dry_run ${settings.dryRun ? 1 : 0}`,
      '# HELP messages_control_last_scan_timestamp_seconds When the page last finished a scan.',
      '# TYPE messages_control_last_scan_timestamp_seconds gauge',
      `messages_control_last_scan_timestamp_seconds ${lastScan ? Math.floor(lastScan.time / 1000) : 0}`,
      '# HELP messages_control_events_total Log entries ever recorded, by outcome.',
      '# TYPE messages_control_events_total counter',
      `messages_control_events_total{outcome="blocked"} ${all.blocked}`,
      `messages_control_events_total{outcome="deleted"} ${all.deleted}`,
      `messages_control_events_total{outcome="archived"} ${all.archived}`,
      `messages_control_events_total{outcome="dry_run"} ${all.dryRun}`,
      `messages_control_events_total{outcome="error"} ${all.errors}`,
      `messages_control_events_total{outcome="any"} ${all.total}`,
      '# HELP messages_control_verdicts Cached verdicts, by label.',
      '# TYPE messages_control_verdicts gauge',
      ...Object.entries(labels).map(([k, n]) => `messages_control_verdicts{label="${k}"} ${n}`),
      '# HELP messages_control_llm_calls_total Classifier calls since the process started.',
      '# TYPE messages_control_llm_calls_total counter',
      `messages_control_llm_calls_total ${backend.stats.calls}`,
      '# HELP messages_control_llm_failures_total Classifier calls that failed since the process started.',
      '# TYPE messages_control_llm_failures_total counter',
      `messages_control_llm_failures_total ${backend.stats.failures}`,
      '# HELP messages_control_llm_seconds_total Time spent in the classifier since the process started.',
      '# TYPE messages_control_llm_seconds_total counter',
      `messages_control_llm_seconds_total ${(backend.stats.ms / 1000).toFixed(3)}`,
      '# HELP process_start_time_seconds Start time of the process since unix epoch in seconds.',
      '# TYPE process_start_time_seconds gauge',
      `process_start_time_seconds ${Math.floor(START / 1000)}`,
    ];
    return `${lines.join('\n')}\n`;
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => {
      log(`API on http://${bind}:${port} (healthz, metrics; dashboard at /)`);
      resolve(server);
    });
  });
}
