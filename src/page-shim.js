// Runs in the Messages page ahead of messages-dom.js and content.js: the
// slice of chrome.* those two use, backed by functions the Node side exposes
// with page.exposeFunction. Node sends its own requests (scanNow, diagnose)
// through __mcDeliver, which answers like the extension's sendResponse.
(() => {
  const listeners = [];
  // Nothing else looks at this tab, so content.js may open picture threads
  // whenever it likes, not only while the tab is in the background.
  globalThis.MessagesControlStandalone = true;
  globalThis.chrome = {
    runtime: {
      sendMessage: (msg) => globalThis.__mcSend(msg),
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
    storage: {
      local: {
        get: (keys) => globalThis.__mcStorage('get', keys),
        set: (items) => globalThis.__mcStorage('set', items),
        remove: (keys) => globalThis.__mcStorage('remove', keys),
      },
    },
  };
  globalThis.__mcDeliver = (msg) =>
    new Promise((resolve) => {
      for (const fn of listeners) {
        let answered = false;
        const later = fn(msg, {}, (res) => {
          answered = true;
          resolve(res);
        });
        if (later === true || answered) return;
      }
      resolve(undefined);
    });
  globalThis.__mcInjected = true;
})();
