import { DEFAULT_PROMPT, getSettings } from './settings.js';

const $ = (id) => document.getElementById(id);
const status = (text) => ($('status').textContent = text);
const FIELDS = ['endpoint', 'model', 'apiKey', 'threshold', 'topN', 'skipNamedContacts', 'openPictureThreads', 'trashOldNotices', 'prompt'];

function read() {
  const out = {};
  for (const f of FIELDS) {
    const el = $(f);
    out[f] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value.trim();
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
