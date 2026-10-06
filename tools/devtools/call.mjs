// node call.mjs targets
// node call.mjs eval <urlSubstring> <file.js>
// node call.mjs open <url>          new background tab, prints targetId
// node call.mjs close <targetId>
import fs from 'node:fs';
import http from 'node:http';
import { PIPE, TOKEN_FILE } from './channel.mjs';

const token = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
const post = (path, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : '';
  const req = http.request({
    socketPath: PIPE, path: `/${path}`, method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  }, (res) => { let out = ''; res.on('data', (c) => (out += c)); res.on('end', () => resolve(out)); });
  req.on('error', reject);
  req.end(data);
});

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'targets') console.log(await post('targets'));
else if (cmd === 'eval') console.log(await post('eval', { match: a, expression: fs.readFileSync(b, 'utf8') }));
else if (cmd === 'open') console.log(JSON.parse(await post('cdp', { method: 'Target.createTarget', params: { url: a, background: true } })).targetId);
else if (cmd === 'close') console.log(await post('cdp', { method: 'Target.closeTarget', params: { targetId: a } }));
