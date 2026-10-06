import { getSettings } from './settings.js';

const $ = (id) => document.getElementById(id);
const status = (text) => ($('status').textContent = text);

async function messagesTab() {
  const [tab] = await chrome.tabs.query({ url: 'https://messages.google.com/web/*' });
  if (!tab) throw new Error('Open messages.google.com/web first.');
  return tab;
}

async function renderLog() {
  const { log = [] } = await chrome.storage.local.get('log');
  const ul = $('log');
  ul.replaceChildren();
  for (const e of log.slice(0, 100)) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    const tag = document.createElement('span');
    tag.className = `tag ${e.action}`;
    tag.textContent = e.action;
    head.append(tag, ` ${e.name ?? ''} `);
    const when = document.createElement('span');
    when.className = 'muted';
    when.textContent = new Date(e.time).toLocaleString();
    head.append(when);
    li.append(head);
    const detail = [e.confidence != null ? `${Math.round(e.confidence * 100)}%` : '', e.reason, e.method && `via ${e.method}`]
      .filter(Boolean)
      .join(' · ');
    if (detail) li.append(Object.assign(document.createElement('div'), { textContent: detail, className: 'muted' }));
    if (e.text) li.append(Object.assign(document.createElement('div'), { textContent: e.text }));
    ul.append(li);
  }
  if (!log.length) status('No activity yet.');
}

async function init() {
  const s = await getSettings();
  $('enabled').checked = s.enabled;
  $('dryRun').checked = s.dryRun;
  if (!s.apiKey) status('Set your API key in Settings.');
  for (const key of ['enabled', 'dryRun']) {
    $(key).addEventListener('change', async (e) => {
      await chrome.storage.local.set({ [key]: e.target.checked });
    });
  }
  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('clear').addEventListener('click', async () => {
    await chrome.storage.local.set({ log: [] });
    await chrome.action.setBadgeText({ text: '' });
    await renderLog();
  });
  $('scan').addEventListener('click', async () => {
    try {
      const tab = await messagesTab();
      status('Scanning…');
      await chrome.tabs.sendMessage(tab.id, { type: 'scanNow' });
      status('Scan finished.');
    } catch (err) {
      status(err.message);
    }
  });
  $('diagnose').addEventListener('click', async () => {
    try {
      const tab = await messagesTab();
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'diagnose' });
      $('report').hidden = false;
      $('report').textContent = JSON.stringify(res.report, null, 2);
    } catch (err) {
      status(err.message);
    }
  });
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.log) renderLog();
  });
  await renderLog();
}

init();
