import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Backend } from '../src/backend.js';
import { DEFAULTS } from '../settings.js';

const settings = { ...DEFAULTS, apiKey: 'test-key', threshold: 0.8 };
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// The LLM answers with whatever the test says; the request is kept for
// inspection.
function answerWith(reply, { status = 200 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status });
  };
  return calls;
}

test('marketing is not spam: marketing flag set, spam false', async () => {
  answerWith({ spam_probability: 0.1, marketing: true, otp: false, notification: false, reason: 'store promo' });
  const v = await new Backend({ settings }).classify({ name: '22822', text: 'Old Navy: 40% off. Reply STOP to opt out' });
  assert.equal(v.spam, false);
  assert.equal(v.rawSpam, false);
  assert.equal(v.marketing, true);
  assert.equal(v.otp, false);
});

test('transactional messages carry a trimmed extract', async () => {
  answerWith({ spam_probability: 0.02, transactional: true, extract: { summary: 'Order 4821 shipped', date: '2026-10-12', amount: '$42.10', code: '1Z999', junk: 'ignored', nothing: '' }, reason: 'shipping' });
  const v = await new Backend({ settings }).classify({ name: '12345', text: 'Your order shipped' });
  assert.equal(v.transactional, true);
  assert.deepEqual(v.extract, { summary: 'Order 4821 shipped', date: '2026-10-12', amount: '$42.10', code: '1Z999' });
  answerWith({ spam_probability: 0.02, transactional: false, extract: {}, reason: 'chat' });
  const w = await new Backend({ settings }).classify({ name: 'x', text: 'y' });
  assert.equal(w.transactional, false);
  assert.equal(w.extract, null);
});

test('spam wins over marketing and otp', async () => {
  answerWith({ spam_probability: 0.97, marketing: true, otp: true, reason: 'phishing' });
  const v = await new Backend({ settings }).classify({ name: '+15550100199', text: 'verify your account, code 123456: http://x' });
  assert.equal(v.spam, true);
  assert.equal(v.marketing, false);
  assert.equal(v.otp, false);
  assert.equal(v.score, 0.97);
});

test('spam below the threshold is rawSpam but not spam', async () => {
  answerWith({ spam_probability: 0.6, reason: 'maybe' });
  const v = await new Backend({ settings }).classify({ name: '+15550100199', text: 'hi is this Mark?' });
  assert.equal(v.rawSpam, true);
  assert.equal(v.spam, false);
});

test('otp regex backstop labels a code the model missed, but not byModel', async () => {
  answerWith({ spam_probability: 0.05, otp: false, reason: 'login' });
  const v = await new Backend({ settings }).classify({ name: '262966', text: 'Your verification code is 482913' });
  assert.equal(v.otp, true);
  assert.equal(v.otpByModel, false);
});

test('old-style {spam, confidence} answers still score', async () => {
  answerWith({ spam: true, confidence: 0.9, reason: 'old prompt' });
  const v = await new Backend({ settings }).classify({ name: 'x', text: 'y' });
  assert.equal(v.score, 0.9);
  assert.equal(v.spam, true);
});

test('request carries the prompt, the sender and the model', async () => {
  const calls = answerWith({ spam_probability: 0 });
  await new Backend({ settings: { ...settings, model: 'm1' } }).classify({ name: 'Alice', text: 'see you at 6' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, settings.endpoint);
  assert.equal(calls[0].body.model, 'm1');
  assert.equal(calls[0].body.messages[0].content, settings.prompt);
  assert.match(calls[0].body.messages[1].content, /^From: Alice\nsee you at 6/);
});

test('handle() counts consecutive failures and calls onFatal at the limit', async () => {
  globalThis.fetch = async () => new Response('down', { status: 503 });
  let fatal = null;
  const backend = new Backend({ settings, onFatal: (m) => (fatal = m) });
  for (let i = 0; i < 4; i++) {
    const res = await backend.handle({ type: 'classify', thread: { name: 'x', text: 'y' } });
    assert.equal(res.ok, false);
  }
  assert.equal(fatal, null);
  await backend.handle({ type: 'classify', thread: { name: 'x', text: 'y' } });
  assert.match(fatal, /LLM endpoint failing/);
});

test('a success resets the failure count', async () => {
  let fatal = null;
  const backend = new Backend({ settings, onFatal: (m) => (fatal = m) });
  globalThis.fetch = async () => new Response('down', { status: 503 });
  for (let i = 0; i < 4; i++) await backend.handle({ type: 'classify', thread: { name: 'x', text: 'y' } });
  answerWith({ spam_probability: 0 });
  await backend.handle({ type: 'classify', thread: { name: 'x', text: 'y' } });
  globalThis.fetch = async () => new Response('down', { status: 503 });
  await backend.handle({ type: 'classify', thread: { name: 'x', text: 'y' } });
  assert.equal(fatal, null);
});

test('pictures are fetched only from Google picture hosts', async () => {
  const backend = new Backend({ settings, context: { request: { get: async () => ({ ok: () => true, body: async () => Buffer.from('x'), headers: () => ({}) }) } }, page: { evaluate: async () => 'data:image/jpeg;base64,AA==' } });
  assert.equal(await backend.toDataUrl('https://evil.example/x.png'), null);
  assert.equal(await backend.toDataUrl('http://lh3.googleusercontent.com/x'), null);
  assert.equal(await backend.toDataUrl('https://lh3.googleusercontent.com/x'), 'data:image/jpeg;base64,AA==');
  assert.equal(await backend.toDataUrl('data:image/png;base64,BB=='), 'data:image/png;base64,BB==');
});
