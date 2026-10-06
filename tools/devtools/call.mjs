// node call.mjs targets
// node call.mjs eval <urlSubstring> <file.js>
// node call.mjs open <url>          new background tab, prints targetId
// node call.mjs close <targetId>
import fs from 'node:fs';
const [cmd, a, b] = process.argv.slice(2);
const post = async (path, body) => (await fetch(`http://127.0.0.1:9339/${path}`, { method: 'POST', body: body ? JSON.stringify(body) : '' })).text();
if (cmd === 'targets') console.log(await post('targets'));
else if (cmd === 'eval') console.log(await post('eval', { match: a, expression: fs.readFileSync(b, 'utf8') }));
else if (cmd === 'open') console.log(JSON.parse(await post('cdp', { method: 'Target.createTarget', params: { url: a, background: true } })).targetId);
else if (cmd === 'close') console.log(await post('cdp', { method: 'Target.closeTarget', params: { targetId: a } }));
