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
      return { done: true, action: 'skipped (contact)' };
    }

    let verdict;
    try {
      ({ verdict } = await send({ type: 'classify', thread: { name: thread.name, text: thread.text } }));
    } catch (err) {
      const n = (attempts.get(thread.id) ?? 0) + 1;
      attempts.set(thread.id, n);
      await log({ ...base, action: 'error', reason: `classify failed (${n}/${MAX_ATTEMPTS}): ${err.message}` });
      // Give up after a few tries, otherwise retry next scan.
      return { done: n >= MAX_ATTEMPTS, action: 'error' };
    }

    const entry = { ...base, spam: verdict.rawSpam, confidence: verdict.confidence, reason: verdict.reason };
    let action;
    if (!verdict.spam) {
      action = 'kept';
      await log({ ...entry, action });
    } else if (settings.dryRun) {
      action = 'would-delete';
      await log({ ...entry, action });
    } else {
      try {
        const method = await deleteThread(thread.id);
        action = 'deleted';
        await log({ ...entry, action, method });
      } catch (err) {
        action = 'error';
        await log({ ...entry, action, reason: `delete failed: ${err.message} (${verdict.reason})` });
      }
    }
    return { done: true, action };
  }

  // Saves what a scan looked at, for the side panel.
  async function saveScan(summary, threads, states) {
    const rows = threads.map((t) => ({ id: t.id, name: t.name, timestamp: t.timestamp, snippet: t.snippet || t.text, state: states.get(t.id) }));
    await chrome.storage.local.set({ lastScan: { time: Date.now(), summary, threads: rows } });
    return summary;
  }

  // Returns a one-line summary of what the scan did. With includeSeen, the
  // top threads are checked even if already seen (for testing on a backlog).
  async function scan({ includeSeen = false } = {}) {
    if (scanning) {
      rescan = true;
      return 'A scan is already running.';
    }
    scanning = true;
    try {
      const { settings } = await send({ type: 'getSettings' });
      if (!settings.enabled && !includeSeen) return 'Watching is off.';
      const threads = listThreads();
      if (!threads.length) return saveScan('No conversations found on the page. Click Diagnose page.', [], new Map());

      const { seen, baselined } = await loadSeen();
      const states = new Map(threads.map((t, i) => [t.id, i < settings.topN ? 'already seen' : `below top ${settings.topN}`]));
      if (!baselined && !includeSeen) {
        // First run: everything already here is history, not new mail.
        await markSeen(threads.map((t) => t.id));
        await log({ action: 'baseline', reason: `marked ${threads.length} existing threads as seen` });
        for (const t of threads) states.set(t.id, 'baseline (seen)');
        return saveScan(`First run: marked ${threads.length} existing threads as seen. Only new threads will be checked.`, threads, states);
      }

      // New threads arrive at the top; older unseen ones further down are
      // just the list lazy-loading history as you scroll.
      const top = threads.slice(0, settings.topN);
      // Unseen but dated before today means it lazy-loaded after the baseline,
      // not that it just arrived: mark it seen without asking the LLM.
      const old = includeSeen ? [] : top.filter((t) => !seen[t.id] && !t.recent);
      for (const t of old) states.set(t.id, `old (${t.timestamp || 'no timestamp'}), skipped`);
      if (old.length) await markSeen(old.map((t) => t.id));
      const candidates = includeSeen ? top : top.filter((t) => !seen[t.id] && t.recent);
      for (const t of candidates) states.set(t.id, 'checking…');
      await saveScan('Checking…', threads, states);
      for (const thread of candidates) {
        const { done, action } = await handle(thread, settings);
        states.set(thread.id, action);
        await saveScan('Checking…', threads, states);
        if (done) await markSeen([thread.id]);
      }
      return saveScan(`Found ${threads.length} threads; checked ${candidates.length}${includeSeen ? '' : ' new'}.`, threads, states);
    } catch (err) {
      console.warn('[spam-filter] scan failed', err);
      return `Scan failed: ${err.message}`;
    } finally {
      scanning = false;
      if (rescan) {
        rescan = false;
        setTimeout(() => scan(), 500);
      }
    }
  }

  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => scan(), 1500);
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  setInterval(() => scan(), 30000);
  schedule();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'diagnose') {
      sendResponse({ ok: true, report: diagnose() });
    } else if (msg.type === 'scanNow') {
      scan({ includeSeen: !!msg.includeSeen }).then((summary) => sendResponse({ ok: true, summary }));
      return true;
    }
  });
})();
