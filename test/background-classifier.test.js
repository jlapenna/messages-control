import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Backend } from '../src/backend.js';
import { DEFAULTS } from '../settings.js';

// Exercise the extension's message boundary and standalone backend with a fake
// provider. No Google Messages account or classifier endpoint is contacted.
const settings = { ...DEFAULTS, apiKey: 'synthetic-key', threshold: 0.8 };
const realFetch = globalThis.fetch;
const realChrome = globalThis.chrome;
let onMessage;
before(async () => {
  globalThis.chrome = {
    storage: { local: { get: async () => ({ ...settings }) } },
    permissions: { contains: async () => true },
    runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } } },
    sidePanel: { setPanelBehavior: async () => {} },
  };
  await import('../background.js');
});
afterEach(() => { globalThis.fetch = realFetch; });
after(() => { globalThis.chrome = realChrome; });

const classifyInExtension = (thread) => new Promise((resolve) => {
  onMessage({ type: 'classify', thread }, null, resolve);
});

for (const [name, reply, thread] of [
  ['spam overrides a fake login code', { spam_probability: 0.97, otp: true }, { name: '123', text: 'verify your account, code 123456' }],
  ['safe code uses the labeling backstop', { spam_probability: 0.05 }, { name: '123', texts: ['Your verification code is 482913', 'Do not share it'] }],
  ['legacy custom prompts retain their score', { spam: true, confidence: 0.6 }, { name: '123', text: 'hello' }],
  ['pictures stay in the request', { spam_probability: 0.1 }, { name: '123', text: '', media: true, images: ['data:image/jpeg;base64,AA=='] }],
]) {
  test(`extension and standalone agree: ${name}`, async () => {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return Response.json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
    };
    const extension = await classifyInExtension(thread);
    const { marketing, transactional, extract, ...standalone } = await new Backend({ settings }).classify(thread);
    assert.deepEqual(extension, { ok: true, verdict: standalone });
    assert.deepEqual(requests[0], requests[1]);
  });
}

test('provider errors and truncated replies fail through both message boundaries', async () => {
  const thread = { name: '123', text: 'hello' };
  for (const response of [
    () => new Response('unavailable', { status: 503 }),
    () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '' } }] }),
    () => Response.json({ choices: [{ message: { content: 'not JSON' } }] }),
  ]) {
    globalThis.fetch = async () => response();
    const extension = await classifyInExtension(thread);
    const standalone = await new Backend({ settings }).handle({ type: 'classify', thread });
    assert.equal(extension.ok, false);
    assert.deepEqual(extension, standalone);
  }
});
