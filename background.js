import { getSettings } from './settings.js';

const LOG_LIMIT = 300;

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
      max_tokens: 200,
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
  const content = data.choices?.[0]?.message?.content ?? '';
  const json = content.match(/\{[\s\S]*\}/)?.[0];
  if (!json) throw new Error(`Unparseable LLM reply: ${content.slice(0, 200)}`);
  const verdict = JSON.parse(json);
  const confidence = Number(verdict.confidence ?? 0);
  return {
    spam: verdict.spam === true && confidence >= s.threshold,
    rawSpam: verdict.spam === true,
    confidence,
    reason: String(verdict.reason ?? ''),
  };
}

async function appendLog(entry) {
  const { log = [] } = await chrome.storage.local.get('log');
  log.unshift({ time: Date.now(), ...entry });
  await chrome.storage.local.set({ log: log.slice(0, LOG_LIMIT) });
  const deleted = log.filter((e) => e.action === 'deleted').length;
  await chrome.action.setBadgeText({ text: deleted ? String(deleted) : '' });
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
        default:
          return sendResponse({ ok: false, error: `unknown message ${msg.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: String(err?.message ?? err) });
    }
  })();
  return true;
});
