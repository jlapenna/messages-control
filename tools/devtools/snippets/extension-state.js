(async () => {
  const self = await chrome.management.getSelf();
  const m = chrome.runtime.getManifest();
  const { log = [], lastScan } = await chrome.storage.local.get(['log', 'lastScan']);
  return JSON.stringify({ installType: self.installType, version: m.version, hasDevReload: !!m.background, files: (await (await fetch(chrome.runtime.getURL('messages-dom.js'))).text()).includes('linkThreadId'), logEntries: log.length, lastScan: lastScan?.summary }, null, 1);
})()
