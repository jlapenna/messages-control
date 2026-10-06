import { getSettings } from './settings.js';

const LOG_LIMIT = 300;
// Backstop for the model: a code-ish word near a 4-8 digit number.
const OTP_RE = /\b(code|passcode|otp|one[- ]time|verification|verify|2fa|login|sign[- ]in)\b[\s\S]{0,60}\b\d{4,8}\b|\b\d{4,8}\b[\s\S]{0,60}\b(code|passcode|otp|verification)\b/i;

async function classify(thread) {
  const s = await getSettings();
  if (!s.apiKey) throw new Error('No API key set (open the extension options).');
  const text = `From: ${thread.name}\n${thread.text}`.slice(0, 4000);
  const res = await fetch(s.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.apiKey}` },
    body: JSON.stringify({
      model: s.model,
      temperature: 0,
      // The default model reasons before answering; a tight cap can leave no
      // room for the JSON on harder messages.
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: s.prompt },
        { role: 'user', content: text },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const choice = data.choices?.[0];
  const content = choice?.message?.content ?? '';
  if (!content && choice?.finish_reason === 'length') throw new Error('LLM ran out of tokens before answering');
  const json = content.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`Unparseable LLM reply: ${content.slice(0, 200)}`);
  const verdict = JSON.parse(json);
  const confidence = Number(verdict.confidence ?? 0);
  return {
    // Spam wins: sender-written text can always look like a code ("verify
    // your account, code 123456: http://..."), so OTP never overrides it.
    otp: verdict.spam !== true && (verdict.otp === true || OTP_RE.test(text)),
    spam: verdict.spam === true && confidence >= s.threshold,
    rawSpam: verdict.spam === true,
    confidence,
    // Probability-like spam score: confidence when the model says spam, its
    // complement when it says not spam.
    score: verdict.spam === true ? confidence : 1 - confidence,
    reason: String(verdict.reason ?? ''),
  };
}

// Log writes are read-modify-write, so run them one at a time; otherwise a
// clear landing mid-append gets overwritten with the old entries.
let logQueue = Promise.resolve();
function withLog(fn) {
  const run = logQueue.then(fn);
  logQueue = run.catch(() => {});
  return run;
}

function appendLog(entry) {
  return withLog(async () => {
    const { log = [] } = await chrome.storage.local.get('log');
    log.unshift({ time: Date.now(), ...entry });
    await chrome.storage.local.set({ log: log.slice(0, LOG_LIMIT) });
    const deleted = log.filter((e) => e.action === 'deleted').length;
    await chrome.action.setBadgeText({ text: deleted ? String(deleted) : '' });
  });
}

function clearLog() {
  return withLog(async () => {
    await chrome.storage.local.set({ log: [] });
    await chrome.storage.local.remove('lastScan');
    await chrome.action.setBadgeText({ text: '' });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.type) {
        case 'getSettings':
          return sendResponse({ ok: true, settings: await getSettings() });
        case 'classify':
          return sendResponse({ ok: true, verdict: await classify(msg.thread) });
        case 'log':
          await appendLog(msg.entry);
          return sendResponse({ ok: true });
        case 'clearLog':
          await clearLog();
          return sendResponse({ ok: true });
        default:
          return sendResponse({ ok: false, error: `unknown message ${msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    }
  })();
  return true;
});

// Clicking the toolbar icon opens the side panel.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('setPanelBehavior failed', err));
