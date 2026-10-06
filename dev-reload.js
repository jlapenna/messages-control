// Development auto-reload. When the extension is loaded unpacked, Chrome
// serves its files straight from disk, so the worker can notice edits by
// re-reading them. On a change it reloads the extension and then any open
// Messages tabs, so saving a file is the whole edit/test loop. Does nothing
// for store installs.

const FILES = [
  'manifest.json',
  'background.js',
  'dev-reload.js',
  'settings.js',
  'messages-dom.js',
  'content.js',
  'panel.html',
  'panel.js',
  'options.html',
  'options.js',
  'style.css',
];
const MESSAGES_TABS = 'https://messages.google.com/web/*';

async function isDev() {
  return (await chrome.management.getSelf()).installType === 'development';
}

async function fingerprint() {
  const texts = await Promise.all(
    FILES.map(async (f) => {
      try {
        return await (await fetch(chrome.runtime.getURL(f), { cache: 'no-store' })).text();
      } catch {
        return '';
      }
    }),
  );
  // FNV-1a; only needs to notice that something changed.
  let h = 0x811c9dc5;
  for (const ch of texts.join('\0')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16);
}

// Reload now, from the side panel's Reload button.
export async function reloadEverything() {
  await chrome.storage.local.set({ devReloadTabs: true });
  chrome.runtime.reload();
}

let checking = false;
export async function checkForChanges() {
  if (checking || !(await isDev())) return false;
  checking = true;
  try {
    const { devFingerprint } = await chrome.storage.local.get('devFingerprint');
    const now = await fingerprint();
    if (!devFingerprint || devFingerprint === now) return false;
    console.log('[dev-reload] files changed, reloading');
    await reloadEverything();
    return true;
  } finally {
    checking = false;
  }
}

// Runs on every extension (re)load: record what was loaded, and finish a
// reload by reloading the Messages tabs so their content scripts are new.
chrome.runtime.onInstalled.addListener(async () => {
  if (await isDev()) await chrome.storage.local.set({ devFingerprint: await fingerprint() });
  const { devReloadTabs } = await chrome.storage.local.get('devReloadTabs');
  if (!devReloadTabs) return;
  await chrome.storage.local.remove('devReloadTabs');
  for (const tab of await chrome.tabs.query({ url: MESSAGES_TABS })) await chrome.tabs.reload(tab.id);
});
