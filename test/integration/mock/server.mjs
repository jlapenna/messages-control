import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Serves the mock Messages page (any /web/* path), its state, the actions the
// page reports, and a stand-in for the OpenAI-compatible classifier that
// judges by keywords. One process per test run; `reset(threads)` reloads.
const dir = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');

export function verdictFor(text) {
  const t = text.toLowerCase();
  const reply = (v) => ({ spam_probability: 0.03, marketing: false, otp: false, notification: false, transactional: false, extract: {}, reason: 'mock', ...v });
  if (/prize|claim now|tax refund|usps.*confirm/.test(t)) return reply({ spam_probability: 0.97, reason: 'scam' });
  if (/vote|campaign|donate/.test(t)) return reply({ spam_probability: 0.95, reason: 'political blast' });
  if (/% off|flash sale|reply stop/.test(t)) return reply({ marketing: true, reason: 'promotion from a real store' });
  if (/verification code|your code is/.test(t)) return reply({ otp: true, reason: 'one-time code' });
  if (/order is ready|out for delivery/.test(t)) return reply({ notification: true, reason: 'status notice' });
  if (/order #|has shipped/.test(t)) return reply({ transactional: true, extract: { summary: 'Order shipped', code: '1Z999' }, reason: 'shipment' });
  return reply({ reason: 'personal' });
}

export async function startMock({ threads = [], port = 0 } = {}) {
  let state = { threads: structuredClone(threads), blocked: [], archived: [] };
  const actions = [];
  const llm = [];
  const json = (res, status, body) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };
  const body = (req) =>
    new Promise((resolve) => {
      let s = '';
      req.on('data', (c) => (s += c));
      req.on('end', () => resolve(s ? JSON.parse(s) : {}));
    });
  // What the phone would remember between page loads.
  function apply(a) {
    const t = state.threads.find((x) => x.id === a.id);
    if (!t) return;
    if (a.action === 'trash' || a.action === 'archive' || a.action === 'block' || a.action === 'block_report') t.gone = true;
    if (a.action === 'archive') state.archived.push({ id: t.id, name: t.name, snippet: t.snippet, timestamp: t.timestamp });
    if (a.action === 'block' || a.action === 'block_report') state.blocked.push({ id: t.id, name: t.name, snippet: t.snippet, timestamp: t.timestamp, spam: a.action === 'block_report' });
    if (a.action === 'unblock' || a.action === 'unarchive') {
      t.gone = false;
      state.blocked = state.blocked.filter((r) => r.id !== t.id);
      state.archived = state.archived.filter((r) => r.id !== t.id);
    }
    if (a.action === 'send') t.messages.push({ text: a.text, outgoing: true });
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/__state') return json(res, 200, state);
    if (url.pathname === '/__actions') {
      if (req.method === 'POST') {
        const a = await body(req);
        actions.push(a);
        apply(a);
        return json(res, 200, { ok: true });
      }
      return json(res, 200, actions);
    }
    if (url.pathname === '/__llm') return json(res, 200, llm);
    if (url.pathname === '/v1/chat/completions') {
      const req2 = await body(req);
      const user = req2.messages?.find((m) => m.role === 'user')?.content;
      const text = typeof user === 'string' ? user : (user ?? []).map((p) => p.text ?? '').join(' ');
      llm.push({ model: req2.model, text, pictures: Array.isArray(user) ? user.filter((p) => p.type === 'image_url').length : 0 });
      return json(res, 200, { choices: [{ message: { content: JSON.stringify(verdictFor(text)) } }] });
    }
    if (url.pathname.startsWith('/web')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    url: `${base}/web/`,
    endpoint: `${base}/v1/chat/completions`,
    actions: () => actions.slice(),
    llm: () => llm.slice(),
    state: () => state,
    reset(next = threads) {
      state = { threads: structuredClone(next), blocked: [], archived: [] };
      actions.length = 0;
      llm.length = 0;
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

// `node test/integration/mock/server.mjs [port]` runs it by hand with the fixture.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const threads = JSON.parse(fs.readFileSync(path.join(dir, 'threads.json'), 'utf8'));
  const mock = await startMock({ threads, port: Number(process.argv[2] ?? 7474) });
  console.log(`mock Messages at ${mock.url} (classifier at ${mock.endpoint})`);
}
