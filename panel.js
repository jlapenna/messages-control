import { getSettings } from './settings.js';

const $ = (id) => document.getElementById(id);
const status = (text) => ($('status').textContent = text);

async function messagesTab() {
  const [tab] = await chrome.tabs.query({ url: 'https://messages.google.com/web/*' });
  if (!tab) throw new Error('Open messages.google.com/web first.');
  return tab;
}

const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text ?? '' });

// Log entries written before rows had label/outcome.
const LEGACY = {
  'would-delete': ['spam', 'not deleted: dry run'],
  spam: ['spam', 'not deleted: dry run'],
  deleted: ['spam', 'deleted'],
  kept: ['ok', 'kept'],
  otp: ['otp', 'kept: one-time code'],
  skipped: ['contact', 'not checked: saved contact'],
  baseline: ['info', null],
  error: ['error', null],
};

function normalize(e) {
  if (e.label) return e;
  const [label, outcome] = LEGACY[e.action] ?? ['info', e.action];
  const score = e.score ?? (e.confidence != null ? (e.spam ? e.confidence : 1 - e.confidence) : undefined);
  return { ...e, label, score, outcome: outcome ?? e.reason, reason: outcome ? e.reason : undefined };
}

// One line per thread: verdict and score, what happened, then who/when,
// the model's reason, and the message preview.
function renderRow(raw, { loggedAt } = {}) {
  const e = normalize(raw);
  const li = document.createElement('li');
  const head = el('div', 'head');
  head.append(el('span', `tag ${e.label}`, e.label));
  if (e.score != null) head.append(el('span', 'score', ` ${Math.round(e.score * 100)}%`));
  if (e.outcome) head.append(el('span', `outcome ${e.outcome.split(/[ :]/)[0]}`, ` · ${e.outcome}`));
  li.append(head);
  const who = [e.name, e.timestamp, loggedAt && `logged ${new Date(loggedAt).toLocaleString()}`, e.method && `via ${e.method}`]
    .filter(Boolean)
    .join(' · ');
  if (who) li.append(el('div', 'muted', who));
  if (e.reason) li.append(el('div', 'reason', e.reason));
  if (e.text) li.append(el('div', 'snippet muted', e.text));
  return li;
}

async function renderLog() {
  const { log = [] } = await chrome.storage.local.get('log');
  $('log').replaceChildren(...log.slice(0, 100).map((e) => renderRow(e, { loggedAt: e.time })));
  if (!log.length) $('log').append(el('li', 'muted', 'No activity yet.'));
}

async function renderScan() {
  const { lastScan } = await chrome.storage.local.get('lastScan');
  $('scanTime').textContent = lastScan ? new Date(lastScan.time).toLocaleTimeString() : '';
  $('scanSummary').textContent = lastScan?.summary ?? 'No scan yet.';
  $('scanList').replaceChildren(...(lastScan?.threads ?? []).map((t) => renderRow(t)));
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
    const res = await chrome.runtime.sendMessage({ type: 'clearLog' });
    if (!res?.ok) status(`Clear failed: ${res?.error ?? 'no response'}`);
    await Promise.all([renderLog(), renderScan()]);
  });
  const runScan = async (includeSeen) => {
    try {
      const tab = await messagesTab();
      status(includeSeen ? 'Checking top threads…' : 'Scanning…');
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'scanNow', includeSeen });
      status(res?.summary ?? 'No response from the Messages tab. Reload it.');
    } catch (err) {
      status(`${err.message} (reload the Messages tab if the extension was just reloaded)`);
    }
  };
  $('scan').addEventListener('click', () => runScan(false));
  $('checkTop').addEventListener('click', () => runScan(true));
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
    if (changes.lastScan) renderScan();
  });
  await Promise.all([renderLog(), renderScan()]);
}

init();
