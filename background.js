import { getSettings } from './settings.js';
import { checkForChanges, reloadEverything } from './dev-reload.js';

const LOG_LIMIT = 300;
// Backstop for the model: a code-ish word near a 4-8 digit number.
const OTP_RE = /\b(code|passcode|otp|one[- ]time|verification|verify|2fa|login|sign[- ]in)\b[\s\S]{0,60}\b\d{4,8}\b|\b\d{4,8}\b[\s\S]{0,60}\b(code|passcode|otp|verification)\b/i;

// One quick retry on network-level failures ("Failed to fetch"), which the
// gateway occasionally produces; HTTP errors are returned as-is.
async function fetchWithRetry(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (init.signal?.aborted) throw err;
    await new Promise((r) => setTimeout(r, 2000));
    return fetch(url, init);
  }
}

// Pictures arrive as data URLs, or as plain URLs when the page wouldn't let
// the content script read the pixels; fetch and downscale those here.
async function toDataUrl(src) {
  if (!src || src.startsWith('data:')) return src || null;
  try {
    const res = await fetch(src, { credentials: 'include', signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob());
    const scale = Math.min(1, 768 / Math.max(bitmap.width, bitmap.height));
    const canvas = new OffscreenCanvas(Math.round(bitmap.width * scale), Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    const bytes = new Uint8Array(await jpeg.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/jpeg;base64,${btoa(binary)}`;
  } catch (err) {
    console.warn('picture fetch failed', src, err);
    return null;
  }
}

async function classify(thread) {
  const s = await getSettings();
  if (!s.apiKey) throw new Error('No API key set (open the extension options).');
  const body = thread.texts?.length ? thread.texts.join('\n---\n') : thread.text;
  const media = thread.media
    ? thread.images?.length
      ? `\n[${thread.images.length} picture(s) attached below]`
      : '\n[picture message; the picture could not be retrieved]'
    : '';
  const text = `From: ${thread.name}\n${body}${media}`.slice(0, 4000);
  const images = await Promise.all((thread.images ?? []).map(toDataUrl));
  const userContent = images.filter(Boolean).length
    ? [{ type: 'text', text }, ...images.filter(Boolean).map((url) => ({ type: 'image_url', image_url: { url } }))]
    : text;
  const res = await fetchWithRetry(s.endpoint, {
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
        { role: 'user', content: userContent },
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
  // Custom prompts from before spam_probability may still answer with
  // {spam, confidence}.
  const score = Math.min(1, Math.max(0, Number(
    verdict.spam_probability ??
      (verdict.spam === true ? verdict.confidence ?? 1 : 1 - (verdict.confidence ?? 1)),
  ) || 0));
  const rawSpam = score >= 0.5;
  return {
    // Spam wins: sender-written text can always look like a code ("verify
    // your account, code 123456: http://..."), so OTP never overrides it.
    otp: !rawSpam && (verdict.otp === true || OTP_RE.test(text)),
    // The regex is only a labelling backstop; cleanup acts on the model's own
    // flag, since a person's "gate code is 4821" can match the regex.
    otpByModel: !rawSpam && verdict.otp === true,
    notification: !rawSpam && verdict.notification === true,
    spam: rawSpam && score >= s.threshold,
    rawSpam,
    score,
    reason: String(verdict.reason ?? ''),
    pictures: images.filter(Boolean).length,
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
        case 'devPing':
          // Sent every few seconds by open Messages tabs and the side panel;
          // also keeps this worker alive so it can notice edits.
          return sendResponse({ ok: true, reloading: await checkForChanges() });
        case 'reload':
          sendResponse({ ok: true });
          return reloadEverything();
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
