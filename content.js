// Watches the Google Messages conversation list. New threads are classified
// and spam among them is deleted; every other listed thread is classified
// for display only (badge and side panel), never deleted.
(() => {
  const { listThreads, readThread, isMediaSnippet, deleteThread, markThread, diagnose } = globalThis.MessagesDom;
  const SEEN_LIMIT = 5000;
  const VERDICT_LIMIT = 1000;
  const MAX_ATTEMPTS = 3;
  // Existing threads labelled per scan, after new ones, so labelling a long
  // backlog never delays new mail.
  const LABEL_BATCH = 5;
  const attempts = new Map();
  let scanning = false;
  let rescan = false;

  const pct = (x) => `${Math.round(x * 100)}%`;

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

  // Verdicts are cached per thread, keyed to the text they were made on, so
  // badges survive re-renders and a thread is only re-classified when its
  // preview changes.
  async function loadVerdicts() {
    const { verdicts = {} } = await chrome.storage.local.get('verdicts');
    return verdicts;
  }

  async function rememberVerdict(id, verdict) {
    const verdicts = await loadVerdicts();
    verdicts[id] = verdict;
    const entries = Object.entries(verdicts).sort((a, b) => b[1].time - a[1].time).slice(0, VERDICT_LIMIT);
    await chrome.storage.local.set({ verdicts: Object.fromEntries(entries) });
  }

  // Bump when classification changes enough that old verdicts should be redone
  // (2: spam_probability scoring and picture checks; 3: notifications).
  const VERDICT_VERSION = 3;
  const cached = (verdicts, t) =>
    verdicts[t.id]?.text === t.text && verdicts[t.id].version === VERDICT_VERSION ? verdicts[t.id] : null;

  function badge(id, v) {
    if (v.label === 'spam') markThread(id, `Spam ${pct(v.score)}`, v.reason);
    else if (v.label === 'otp') markThread(id, 'OTP', v.reason, '#0b57d0');
    else if (v.label === 'notice') markThread(id, 'Notice', v.reason, '#5f6368');
  }

  const looksLikeNamedContact = (name) => !!name && !/[\d@]/.test(name);
  const isSkippedContact = (t, settings) => settings.skipNamedContacts && looksLikeNamedContact(t.name);

  // Opening a thread moves the user's view, so existing picture threads are
  // only opened while the Messages tab is in the background.
  const canOpen = (isNew) => isNew || document.visibilityState === 'hidden';
  let openPictures = true; // refreshed from settings at the start of each scan
  const needsOpen = (t) => openPictures && isMediaSnippet(t.text);

  async function classify(thread) {
    const payload = { name: thread.name, text: thread.text, media: isMediaSnippet(thread.text) };
    if (needsOpen(thread)) {
      try {
        Object.assign(payload, await readThread(thread.id));
      } catch (err) {
        console.warn('[spam-filter] could not read thread', thread.id, err);
      }
    }
    const { verdict } = await send({ type: 'classify', thread: payload });
    // otp is only set when the model didn't flag spam (see background.js).
    const v = {
      label: verdict.rawSpam ? 'spam' : verdict.otp ? 'otp' : verdict.notification ? 'notice' : 'ok',
      byModel: verdict.rawSpam || verdict.notification || verdict.otpByModel,
      score: verdict.score,
      reason: verdict.reason,
      text: thread.text,
      media: payload.media
        ? verdict.pictures
          ? `${verdict.pictures} picture${verdict.pictures === 1 ? '' : 's'} checked`
          : openPictures
            ? 'picture not retrieved'
            : 'picture not opened (setting off)'
        : undefined,
      time: Date.now(),
      version: VERDICT_VERSION,
    };
    await rememberVerdict(thread.id, v);
    badge(thread.id, v);
    return v;
  }

  // What should happen to a thread with this verdict, and why. Pure: the
  // caller performs the delete when this says so.
  // Notices and one-time codes stop mattering after a day; with the setting
  // on, they go to trash once 2+ calendar days old (so at least 24 hours).
  const OLD_NOTICE_DAYS = 2;
  // Trashing removes the whole conversation, not just the latest message. Only
  // automated senders, whose threads are nothing but notices, are eligible:
  // short codes (48724) and toll-free numbers (833 ...). A business on a
  // regular number may have a quote or invoice earlier in the thread.
  const TOLL_FREE = /^1?(800|833|844|855|866|877|888)\d{7}$/;
  const isAutomatedSender = (name) => {
    const digits = (name ?? '').replace(/[\s()+.-]/g, '');
    return /^\d{4,6}$/.test(digits) || TOLL_FREE.test(digits);
  };
  function decideExpiring(v, t, settings) {
    const kind = v.label === 'otp' ? 'one-time code' : 'notification';
    if (!settings.trashOldNotices) return { outcome: `kept: ${kind}` };
    if (!isAutomatedSender(t.name)) return { outcome: `kept: ${kind} (only short-code and toll-free senders are auto-trashed)` };
    if (!v.byModel) return { outcome: `kept: ${kind} (code pattern only, not confirmed by the model)` };
    if (t.ageDays == null) return { outcome: `kept: ${kind}, age unknown` };
    if (t.ageDays < OLD_NOTICE_DAYS) return { outcome: `kept: ${kind}, under 2 days old` };
    if (settings.dryRun) return { outcome: `not deleted: dry run (${kind}, ${t.ageDays} days old)` };
    return { outcome: `moving to trash (${kind}, ${t.ageDays} days old)`, del: true };
  }

  function decide(v, { isNew, settings, thread }) {
    if (v.label === 'otp' || v.label === 'notice') return decideExpiring(v, thread, settings);
    if (v.label === 'ok') return { outcome: 'kept' };
    if (v.score < settings.threshold) return { outcome: `kept: below ${pct(settings.threshold)} threshold` };
    if (!isNew) return { outcome: 'not deleted: existing thread' };
    if (settings.dryRun) return { outcome: 'not deleted: dry run' };
    return { outcome: 'deleting…', del: true };
  }


  // One row per thread, shared by the activity log and the last-scan list.
  const row = (t, fields) => ({
    threadId: t.id,
    name: t.name,
    timestamp: t.timestamp,
    text: (t.text ?? '').slice(0, 500),
    ...fields,
  });

  const fromVerdict = (t, v, outcome) => row(t, { label: v.label, score: v.score, reason: v.reason, media: v.media, outcome });
  const waitingRow = (t) => row(t, { label: 'pending', outcome: 'picture not checked yet: waits until the Messages tab is in the background' });

  // Classifies a thread and acts on it. Returns { row, done } where done
  // means it needs no retry.
  async function processThread(t, { isNew, settings, verdicts }) {
    if (isSkippedContact(t, settings)) {
      return { row: row(t, { label: 'contact', outcome: 'not checked: saved contact' }), done: true };
    }
    let v = cached(verdicts, t);
    if (!v && needsOpen(t) && !canOpen(isNew)) return { row: waitingRow(t), done: false };
    if (!v) {
      try {
        v = await classify(t);
      } catch (err) {
        const n = (attempts.get(t.id) ?? 0) + 1;
        attempts.set(t.id, n);
        const done = n >= MAX_ATTEMPTS;
        const outcome = done ? `gave up after ${n} tries` : `will retry (${n}/${MAX_ATTEMPTS})`;
        return { row: row(t, { label: 'error', outcome, reason: err.message }), done };
      }
    }
    const { outcome, del } = decide(v, { isNew, settings, thread: t });
    if (!del) return { row: fromVerdict(t, v, outcome), done: true };
    try {
      const method = await deleteThread(t.id);
      return { row: { ...fromVerdict(t, v, outcome.startsWith('moving') ? outcome.replace('moving', 'moved') : 'deleted'), method }, done: true };
    } catch (err) {
      return { row: fromVerdict(t, v, `delete failed: ${err.message}`), done: true };
    }
  }

  // Row for a thread this scan didn't process, from what is already known.
  function knownRow(t, { settings, verdicts }) {
    if (isSkippedContact(t, settings)) return row(t, { label: 'contact', outcome: 'not checked: saved contact' });
    const v = cached(verdicts, t);
    if (!v) return needsOpen(t) ? waitingRow(t) : row(t, { label: 'pending', outcome: 'not classified yet' });
    return fromVerdict(t, v, decide(v, { isNew: false, settings, thread: t }).outcome);
  }

  async function saveScan(summary, rows) {
    await chrome.storage.local.set({ lastScan: { time: Date.now(), summary, threads: rows } });
    return summary;
  }

  // Returns a one-line summary of what the scan did. With includeSeen, the
  // top threads are treated as new (for testing on a backlog).
  async function scan({ includeSeen = false } = {}) {
    if (scanning) {
      rescan = true;
      return 'A scan is already running.';
    }
    scanning = true;
    try {
      const { settings } = await send({ type: 'getSettings' });
      if (!settings.enabled && !includeSeen) return 'Watching is off.';
      openPictures = settings.openPictureThreads;
      const threads = listThreads();
      if (!threads.length) return saveScan('No conversations found on the page. Click Diagnose page.', []);

      let verdicts = await loadVerdicts();
      for (const t of threads) {
        const v = cached(verdicts, t);
        if (v) badge(t.id, v);
      }

      const { seen, baselined } = await loadSeen();
      const notes = [];
      if (!baselined && !includeSeen) {
        // First run: everything already here is history, not new mail.
        await markSeen(threads.map((t) => t.id));
        await log({ label: 'info', outcome: `started watching: ${threads.length} existing threads will never be deleted` });
        notes.push(`first run, ${threads.length} existing threads marked as not new`);
      }

      // New threads arrive at the top. Unseen threads dated before today
      // lazy-loaded after the baseline; they are history, not new mail.
      const top = threads.slice(0, settings.topN);
      const fresh = includeSeen ? top : baselined ? top.filter((t) => !seen[t.id] && t.recent) : [];
      const stale = includeSeen ? [] : threads.filter((t) => !seen[t.id] && !fresh.includes(t));
      if (stale.length) await markSeen(stale.map((t) => t.id));

      const rows = new Map();
      const publish = (summary) =>
        saveScan(summary, threads.map((t) => rows.get(t.id) ?? knownRow(t, { settings, verdicts })));

      for (const t of fresh) rows.set(t.id, row(t, { label: 'pending', outcome: 'checking…' }));
      await publish('Checking new threads…');
      for (const t of fresh) {
        const res = await processThread(t, { isNew: true, settings, verdicts });
        rows.set(t.id, res.row);
        await log(res.row);
        if (res.done) await markSeen([t.id]);
        await publish('Checking new threads…');
      }

      // Display-only labels for existing threads; decide() never deletes
      // them because isNew is false.
      verdicts = await loadVerdicts();
      const unlabelled = threads.filter(
        (t) =>
          !rows.has(t.id) &&
          !isSkippedContact(t, settings) &&
          !cached(verdicts, t) &&
          (!needsOpen(t) || canOpen(false)) &&
          (attempts.get(t.id) ?? 0) < MAX_ATTEMPTS,
      );
      for (const t of unlabelled.slice(0, LABEL_BATCH)) {
        const res = await processThread(t, { isNew: false, settings, verdicts });
        rows.set(t.id, res.row);
        await log(res.row);
        await publish('Labelling existing threads…');
      }

      // Old notices and codes that were labelled in an earlier scan.
      if (settings.trashOldNotices && !settings.dryRun) {
        verdicts = await loadVerdicts();
        const expired = threads.filter((t) => {
          const v = !rows.has(t.id) && cached(verdicts, t);
          return v && decide(v, { isNew: false, settings, thread: t }).del;
        });
        for (const t of expired.slice(0, LABEL_BATCH)) {
          const res = await processThread(t, { isNew: false, settings, verdicts });
          rows.set(t.id, res.row);
          await log(res.row);
          await publish('Moving old notices to trash…');
        }
      }

      const pending = unlabelled.length - Math.min(unlabelled.length, LABEL_BATCH);
      if (pending) {
        notes.push(`${pending} existing threads still to label`);
        rescan = true;
      }
      const summary = [`${threads.length} threads listed, ${fresh.length} new`, ...notes].join('; ');
      return publish(`${summary}.`);
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
  // Lets an unpacked install notice edits and reload itself (dev-reload.js).
  // Stops once the extension reloads and this script is orphaned.
  const devTimer = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'devPing' }).catch(() => clearInterval(devTimer));
  }, 2000);
  // Hidden is when existing picture threads may be opened.
  document.addEventListener('visibilitychange', schedule);
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
