import { DEFAULTS, DEFAULT_PROMPT, getSettings } from './settings.js';

const $ = (id) => document.getElementById(id);
const status = (text) => ($('status').textContent = text);
const FIELDS = ['spamAction', 'endpoint', 'model', 'apiKey', 'threshold', 'topN', 'skipNamedContacts', 'openPictureThreads', 'archiveOldNotices', 'prompt'];

// An empty number field reads as 0, which would make every spam verdict
// deletable (threshold) or nothing count as new (topN). Clamp to sane ranges
// and fall back to the default when empty.
const RANGES = { threshold: [0.5, 1], topN: [1, 100] };

function read() {
  const out = {};
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') out[f] = el.checked;
    else if (el.tagName === 'SELECT') out[f] = el.value;
    else if (el.type === 'number') {
      const n = el.value.trim() === '' ? NaN : Number(el.value);
      const [lo, hi] = RANGES[f];
      out[f] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULTS[f];
      el.value = out[f];
    } else out[f] = el.value.trim() || DEFAULTS[f];
  }
  return out;
}

// Only a customized prompt is stored, so prompt improvements reach everyone else.
async function save() {
  const values = read();
  if (values.prompt === DEFAULT_PROMPT) {
    delete values.prompt;
    await chrome.storage.local.remove('prompt');
  }
  await chrome.storage.local.set(values);
}

async function init() {
  const s = await getSettings();
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') el.checked = s[f];
    else el.value = s[f];
  }
  $('save').addEventListener('click', async () => {
    await save();
    status('Saved.');
  });
  $('resetPrompt').addEventListener('click', () => ($('prompt').value = DEFAULT_PROMPT));
  $('resetSeen').addEventListener('click', async () => {
    await chrome.storage.local.set({ seen: {}, baselined: false });
    status('Forgot seen threads. The next scan re-baselines from whatever is listed.');
  });
  $('test').addEventListener('click', async () => {
    await save();
    status('Classifying…');
    const [first, ...rest] = $('sample').value.split('\n');
    const thread = /^from:/i.test(first)
      ? { name: first.replace(/^from:\s*/i, ''), text: rest.join('\n') }
      : { name: '', text: $('sample').value };
    const res = await chrome.runtime.sendMessage({ type: 'classify', thread });
    status(res.ok ? JSON.stringify(res.verdict) : `Error: ${res.error}`);
  });
}

init();
