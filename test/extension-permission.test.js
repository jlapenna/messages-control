import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointPermission } from '../endpoint-permission.js';

test('endpoint access is restricted to the configured HTTP(S) host', () => {
  assert.deepEqual(endpointPermission('https://provider.example/v1/chat/completions?x=1'), { origins: ['https://provider.example/*'] });
  assert.deepEqual(endpointPermission('http://localhost:8080/v1/chat/completions'), { origins: ['http://localhost/*'] });
  for (const url of ['not a URL', 'file:///tmp/messages', 'javascript:alert(1)', 'https://user:password@provider.example/api']) {
    assert.throws(() => endpointPermission(url), /endpoint/);
  }
});

test('extension classifier refuses ungranted or invalid endpoints before any network request', async () => {
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  let handler;
  let allowed = false;
  let endpoint = 'https://provider.example/v1/chat/completions';
  const requests = [];
  const permissions = [];
  try {
    globalThis.chrome = {
      storage: { local: { get: async () => ({ endpoint, apiKey: 'fixture-key' }) } },
      permissions: { contains: async (p) => (permissions.push(p), allowed) },
      runtime: { onMessage: { addListener: fn => { handler = fn; } } },
      sidePanel: { setPanelBehavior: async () => {} },
    };
    globalThis.fetch = async (url, opts) => {
      requests.push({ url, opts });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"spam_probability":0.1,"reason":"fixture"}' } }] }));
    };
    await import('../background.js');
    const classify = () => new Promise(resolve => handler({ type: 'classify', thread: { name: 'Fixture sender', text: 'Synthetic text' } }, {}, resolve));
    const denied = await classify();
    assert.equal(denied.ok, false);
    assert.match(denied.error, /access is missing/);
    assert.equal(requests.length, 0);
    assert.deepEqual(permissions[0], { origins: ['https://provider.example/*'] });
    allowed = true;
    assert.equal((await classify()).ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, endpoint);
    endpoint = 'file:///tmp/messages';
    assert.equal((await classify()).ok, false);
    assert.equal(requests.length, 1, 'invalid schemes never receive messages or API keys');
  } finally {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  }
});
