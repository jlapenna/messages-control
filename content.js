// Watches the Google Messages conversation list and sends each newly arrived
// thread to the background worker for spam classification.
(() => {
  const { listThreads, deleteThread, diagnose } = globalThis.MessagesDom;
  const SEEN_LIMIT = 5000;
  const MAX_ATTEMPTS = 3;
  const attempts = new Map();
  let scanning = false;
  let rescan = false;

  async function send(msg) {
    const res = await chrome.runtime.sendMessage(msg);
    if (!res?.ok) throw new Error(res?.error ?? 'no response from background');
    return res;
  }

  const log = (entry) => send({ type: 'log', entry }).catch((e) => console.warn('[spam-filter] log failed', e));

  async function loadSeen() {
    const { seen = {}, baselined = false } = await chrome.storage.local.get(['seen', 'baselined']);
    return { seen, baselined };
  }

  async function markSeen(ids) {
    const { seen } = await loadSeen();
    const now = Date.now();
    for (const id of ids) seen[id] = now;
    const entries = Object.entries(seen);
    const trimmed =
      entries.length > SEEN_LIMIT
        ? Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, SEEN_LIMIT))
        : seen;
    await chrome.storage.local.set({ seen: trimmed, baselined: true });
  }

  const looksLikeNamedContact = (name) => !!name && !/[\d@]/.test(name);

  async function handle(thread, settings) {
    const base = { threadId: thread.id, name: thread.name, text: thread.text.slice(0, 500) };

    if (settings.skipNamedContacts && looksLikeNamedContact(thread.name)) {
      await log({ ...base, action: 'skipped', reason: 'named contact' });
      return true;
    }

    let verdict;
    try {
      ({ verdict } = await send({ type: 'classify', thread: { name: thread.name, text: thread.text } }));
    } catch (err) {
      const n = (attempts.get(thread.id) ?? 0) + 1;
      attempts.set(thread.id, n);
      await log({ ...base, action: 'error', reason: `classify failed (${n}/${MAX_ATTEMPTS}): ${err.message}` });
      return n >= MAX_ATTEMPTS; // give up after a few tries, otherwise retry next scan
    }

    const entry = { ...base, spam: verdict.rawSpam, confidence: verdict.confidence, reason: verdict.reason };
    if (!verdict.spam) {
      await log({ ...entry, action: 'kept' });
    } else if (settings.dryRun) {
      await log({ ...entry, action: 'would-delete' });
    } else {
      try {
        const method = await deleteThread(thread.id);
        await log({ ...entry, action: 'deleted', method });
      } catch (err) {
        await log({ ...entry, action: 'error', reason: `delete failed: ${err.message} (${verdict.reason})` });
      }
    }
    return true;
  }

  async function scan() {
    if (scanning) {
      rescan = true;
      return;
    }
    scanning = true;
    try {
      const { settings } = await send({ type: 'getSettings' });
      if (!settings.enabled) return;
      const threads = listThreads();
      if (!threads.length) return;

      const { seen, baselined } = await loadSeen();
      if (!baselined) {
        // First run: everything already here is history, not new mail.
        await markSeen(threads.map((t) => t.id));
        await log({ action: 'baseline', reason: `marked ${threads.length} existing threads as seen` });
        return;
      }

      // New threads arrive at the top; older unseen ones further down are
      // just the list lazy-loading history as you scroll.
      const fresh = threads.slice(0, settings.topN).filter((t) => !seen[t.id]);
      for (const thread of fresh) {
        if (await handle(thread, settings)) await markSeen([thread.id]);
      }
    } catch (err) {
      console.warn('[spam-filter] scan failed', err);
    } finally {
      scanning = false;
      if (rescan) {
        rescan = false;
        setTimeout(scan, 500);
      }
    }
  }

  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(scan, 1500);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  setInterval(scan, 30000);
  schedule();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'diagnose') {
      sendResponse({ ok: true, report: diagnose() });
    } else if (msg.type === 'scanNow') {
      scan().then(() => sendResponse({ ok: true }));
      return true;
    }
  });
})();
