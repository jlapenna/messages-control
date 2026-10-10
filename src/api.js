import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

// The watcher's local HTTP API, on 127.0.0.1 only.
//   GET  /healthz         200 when paired and the page answers, else 503 (no token)
//   GET  /metrics         Prometheus text (no token)
//   GET  /                the dashboard (asks for the token in the browser)
//   GET  /api/status, /api/events?since&limit, /api/review, /api/policies, /api/verdicts
//   POST /api/act {id, action}, /api/undo {event}, /api/scan {includeSeen, checkPictures, trashSpam, processAll}
// /api/* needs "Authorization: Bearer <api.token>".
const DASHBOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard.html');
const START = Date.now();

export function startApi({ settings, bind = '127.0.0.1', port, token, db, store, backend, health, deliver, policy, log = console.log }) {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      send(res, 500, { error: err.message });
    });
  });

  const send = (res, status, body, type = 'application/json') => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
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
      switch (url.pathname) {
        case '/api/status':
          return send(res, 200, await status());
        case '/api/events': {
          const since = Number(url.searchParams.get('since') ?? 0);
          const limit = Math.min(1000, Number(url.searchParams.get('limit') ?? 100));
          return send(res, 200, db.events({ since, limit }).map((r) => ({ ...r })));
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
          const r = await deliver({ type: 'undo', kind, name: event.name, threadId: event.thread_id });
          return send(res, r?.ok ? 200 : 409, r ?? { ok: false, error: 'no answer from the page' });
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
      llm: backend.stats,
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
