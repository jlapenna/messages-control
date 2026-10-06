// Holds one DevTools connection to the user's Chrome (approved once) and
// serves commands on 127.0.0.1:9339 for call.mjs.
import fs from 'node:fs';
import http from 'node:http';
const [port, path] = fs.readFileSync(`${process.env.LOCALAPPDATA}\\Google\\Chrome\\User Data\\DevToolsActivePort`, 'utf8').trim().split(/\r?\n/);
const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
let next = 0; const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
  const id = ++next; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (!p) return; pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); };
ws.onclose = () => { console.log('devtools connection closed'); process.exit(1); };
await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('cannot connect')); });
console.log('connected to', (await send('Browser.getVersion')).product);

async function evaluate(match, expression) {
  const { targetInfos } = await send('Target.getTargets');
  const t = targetInfos.find((t) => t.url.includes(match) && ['page', 'service_worker'].includes(t.type));
  if (!t) throw new Error(`no page or worker matching ${match}`);
  const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  try {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  } finally {
    await send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  try {
    const q = body ? JSON.parse(body) : {};
    let out;
    if (req.url === '/targets') out = (await send('Target.getTargets')).targetInfos.map((t) => `${t.type.padEnd(15)} ${t.url.slice(0, 110)}`).join('\n');
    else if (req.url === '/eval') out = await evaluate(q.match, q.expression);
    else if (req.url === '/cdp') out = await send(q.method, q.params ?? {});
    else throw new Error('unknown endpoint');
    res.end(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
  } catch (err) {
    res.statusCode = 500; res.end('ERROR ' + err.message);
  }
}).listen(9339, '127.0.0.1', () => console.log('listening on 127.0.0.1:9339'));
