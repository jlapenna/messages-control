// Exercise the downloader used by electron-builder, including the scoped
// proxy dependency override. No real Electron artifacts or external network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');

test('electron-builder downloader validates an artifact through the configured proxy', { timeout: 15000 }, async () => {
  const requests = [];
  const artifact = Buffer.from('Synthetic Electron archive bytes');
  const version = require('../package.json').devDependencies.electron;
  const filename = `electron-v${version}-linux-x64.zip`;
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url !== `http://download.invalid/fixture/${filename}`) { res.writeHead(404); return res.end(); }
    res.end(artifact);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-desktop-proxy-'));
  try {
    process.env.ELECTRON_GET_USE_PROXY = '1';
    process.env.GLOBAL_AGENT_HTTP_PROXY = `http://127.0.0.1:${server.address().port}`;
    process.env.GLOBAL_AGENT_NO_PROXY = '';
    const builderRequire = createRequire(require.resolve('app-builder-lib/package.json'));
    const { downloadArtifact } = builderRequire('@electron/get');
    const downloaded = await downloadArtifact({ version, artifactName: 'electron', platform: 'linux', arch: 'x64',
      cacheRoot: dir, mirrorOptions: { mirror: 'http://download.invalid/', customDir: 'fixture' },
      checksums: { [filename]: createHash('sha256').update(artifact).digest('hex') } });
    assert.deepEqual(fs.readFileSync(downloaded), artifact);
    assert.deepEqual(requests, [`http://download.invalid/fixture/${filename}`]);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
