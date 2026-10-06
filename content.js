// Watches the Google Messages conversation list. New threads are classified
// and spam among them is deleted; every other listed thread is classified
// for display only (badge and side panel), never deleted.
(() => {
  const { listThreads, loadAllThreads, readThread, isMediaSnippet, deleteThread, archiveThread, markThread, diagnose } = globalThis.MessagesDom;
  const SEEN_LIMIT = 5000;
  const VERDICT_LIMIT = 1000;
  const MAX_ATTEMPTS = 3;
  // Existing threads labelled per scan, after new ones, so labelling a long
  // backlog never delays new mail.
  const LABEL_BATCH = 5;
  // Existing threads are labelled (and listed in the panel) only this far down
  // the list. After the full-list sweep the page holds the whole history;
  // labelling all of it would never settle once it outgrew VERDICT_LIMIT.
  const LABEL_SCOPE = 50;
  const attempts = new Map();
  let scanning = false;
  let rescan = false;
  // Options of requests that arrived while a scan was running, merged.
  let pendingOpts = {};

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
  // (2: spam_probability scoring and picture checks; 3: notifications;
  // 4: byModel, so codes can be archived).
  const VERDICT_VERSION = 4;
  // A verdict is reused only for the same preview text and the same latest
  // message: picture threads all say "Picture", so a newer message (by list
  // timestamp, 5 minutes' slack for "34 min" drifting) invalidates it.
  const STALE_SLACK_MS = 5 * 60000;
  const cached = (verdicts, t) => {
    const v = verdicts[t.id];
    if (!v || v.text !== t.text || v.version !== VERDICT_VERSION) return null;
    if (t.msgTime != null && v.msgTime != null && t.msgTime > v.msgTime + STALE_SLACK_MS) return null;
    return v;
  };

  function badge(id, v) {
    if (v.label === 'spam') markThread(id, `Spam ${pct(v.score)}`, v.reason);
    else if (v.label === 'otp') markThread(id, 'OTP', v.reason, '#0b57d0');
    else if (v.label === 'notice') markThread(id, 'Notice', v.reason, '#5f6368');
  }

  const looksLikeNamedContact = (name) => !!name && !/[\d@]/.test(name);
  const isSkippedContact = (t, settings) => settings.skipNamedContacts && looksLikeNamedContact(t.name);

  // Opening a thread moves the user's view, so existing picture threads are
  // only opened while the Messages tab is in the background.
  // forceOpen: the user pressed "Check pictures now".
  let forceOpen = false;
  const canOpen = (isNew) => isNew || forceOpen || document.visibilityState === 'hidden';
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
      msgTime: thread.msgTime,
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
  // Notices stop mattering after a day, one-time codes after a few hours, so
  // they are archived past these ages. Archiving keeps the history and
  // Messages brings the thread back on a new message, so any sender qualifies
  // and dry run (which only forbids trashing) doesn't apply. Only labels the
  // model gave count: the OTP regex backstop can match a person's "gate code
  // is 4821".
  const ARCHIVE_AFTER_HOURS = { otp: 6, notice: 24 };
  // Minimum possible age in hours of the thread's latest message. Before
  // today the list shows only a day ("Yesterday", "Monday", "Sep 29"), so
  // assume the message came at the very end of that day: never archive early.
  function minAgeHours(t, now = Date.now()) {
    if (t.msgTime == null) return null;
    const end = t.recent ? t.msgTime : t.msgTime + 86400000;
    return Math.max(0, (now - end) / 3600000);
  }
  const fmtHours = (h) => (h < 48 ? `${Math.floor(h)} hours old` : `${Math.floor(h / 24)} days old`);

  function decideExpiring(v, t, settings) {
    const kind = v.label === 'otp' ? 'one-time code' : 'notification';
    const limit = ARCHIVE_AFTER_HOURS[v.label];
    if (!settings.archiveOldNotices) return { outcome: `kept: ${kind}` };
    // Notices only ever come from the model; a code may come from the regex.
    if (v.label === 'otp' && v.byModel !== true) {
      return { outcome: `kept: ${kind} (code pattern only, not confirmed by the model)` };
    }
    const age = minAgeHours(t);
    if (age == null) return { outcome: `kept: ${kind}, age unknown` };
    if (age < limit) return { outcome: `kept: ${kind}, under ${limit === 24 ? 'a day' : `${limit} hours`} old` };
    return { outcome: `archiving (${kind}, at least ${fmtHours(age)})`, archive: true };
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
  // means it needs no retry; abort tells a delete loop to stop. explicit: the
  // user asked for this action from the panel (runs with watching off; dry run
  // still applies). recheck: ignore a cached verdict for picture threads,
  // whose list timestamp can't always show that a newer picture arrived.
  async function processThread(t, { isNew, settings, verdicts, explicit = false, recheck = false }) {
    if (isSkippedContact(t, settings)) {
      return { row: row(t, { label: 'contact', outcome: 'not checked: saved contact' }), done: true };
    }
    let v = recheck && needsOpen(t) ? null : cached(verdicts, t);
    if (!v && needsOpen(t) && !canOpen(isNew || recheck)) return { row: waitingRow(t), done: false };
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
    const { outcome, del, archive } = decide(v, { isNew, settings, thread: t });
    if (!del && !archive) return { row: fromVerdict(t, v, outcome), done: true };

    // Right before the trash, check again everything the decision rested on.
    // Settings were read when the scan started and may have changed since.
    const { settings: now } = await send({ type: 'getSettings' });
    const not = archive ? 'not archived' : 'not deleted';
    if (del && now.dryRun) return { row: fromVerdict(t, v, 'not deleted: dry run turned on'), done: false, abort: true };
    if (!now.enabled && !explicit) {
      return { row: fromVerdict(t, v, `${not}: watching turned off`), done: false, abort: true };
    }
    const again = decide(v, { isNew, settings: now, thread: t });
    if (!(del ? again.del : again.archive)) {
      return { row: fromVerdict(t, v, `${not}: settings changed (${again.outcome})`), done: true };
    }
    // The thread itself may have changed: the list snapshot can be minutes
    // old by now (LLM calls, opened picture threads), and a new message could
    // be in it, e.g. a fresh login code in an old notice thread.
    const current = listThreads().find((x) => x.id === t.id);
    const newer = current && current.msgTime != null && t.msgTime != null && current.msgTime > t.msgTime + STALE_SLACK_MS;
    if (!current || current.text !== t.text || newer) {
      return { row: fromVerdict(t, v, `${not}: thread changed since it was checked`), done: false };
    }
    try {
      const method = archive ? await archiveThread(t.id) : await deleteThread(t.id);
      return { row: { ...fromVerdict(t, v, archive ? outcome.replace('archiving', 'archived') : 'deleted'), method }, done: true };
    } catch (err) {
      return { row: fromVerdict(t, v, `${archive ? 'archive' : 'delete'} failed: ${err.message}`), done: true };
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
  // top threads are treated as new (for testing on a backlog). checkPictures
  // opens every pending picture thread now; trashSpam moves existing threads
  // already labelled spam (at or above the threshold) to trash. Both are
  // explicit user actions from the side panel.
  async function scan(opts = {}) {
    if (scanning) {
      rescan = true;
      pendingOpts = { ...pendingOpts, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v)) };
      return 'A scan is running; this request will run right after it.';
    }
    // processAll: "Process all messages" — load the whole list, label every
    // thread (pictures excepted, see checkPictures), archive old notices, and
    // trash spam unless dry run is on.
    const { includeSeen = false, checkPictures = false, trashSpam = false, processAll = false } = opts;
    scanning = true;
    try {
      const { settings } = await send({ type: 'getSettings' });
      if (!settings.enabled && !includeSeen && !checkPictures && !trashSpam && !processAll) return 'Watching is off.';
      if (trashSpam && settings.dryRun) return 'Dry run is on; turn it off to move spam to trash.';
      forceOpen = checkPictures;
      openPictures = settings.openPictureThreads;
      let threads = listThreads();
      if (!threads.length) return saveScan('No conversations found on the page. Click Diagnose page.', []);

      let verdicts = await loadVerdicts();
      const publishEarly = (summary) =>
        saveScan(summary, listThreads().slice(0, LABEL_SCOPE).map((t) => knownRow(t, { settings, verdicts })));
      for (const t of threads) {
        const v = cached(verdicts, t);
        if (v) badge(t.id, v);
      }

      let { seen, baselined } = await loadSeen();
      const notes = [];
      // 2: the first sweep missed the real page's "Load more conversations".
      const SWEEP_VERSION = 2;
      const { fullSweep } = await chrome.storage.local.get('fullSweep');
      if ((!baselined || fullSweep !== SWEEP_VERSION) && !includeSeen) {
        // Everything already in the conversation list is history, not new
        // mail, including threads the list hasn't rendered yet: load it all
        // first. Installs baselined before this did it once from the visible
        // part only, so they sweep once too (after nothing new is pending).
        // Unseen threads from today at the top may be genuinely new: leave
        // those for the new-thread check below.
        const maybeNew = new Set(
          baselined ? threads.slice(0, settings.topN).filter((t) => !seen[t.id] && t.recent).map((t) => t.id) : [],
        );
        const { threads: all, complete } = await loadAllThreads();
        // The sweep can take a while; anything unseen from today now at the
        // top may have arrived during it.
        // (On a first run everything listed is history, so nothing is held back.)
        if (baselined) for (const t of all.slice(0, settings.topN)) if (!seen[t.id] && t.recent) maybeNew.add(t.id);
        await markSeen(all.map((t) => t.id).filter((id) => !maybeNew.has(id)));
        if (complete) await chrome.storage.local.set({ fullSweep: SWEEP_VERSION });
        await log({
          label: 'info',
          outcome: complete
            ? `loaded the whole list: ${all.length} existing threads will never be auto-deleted`
            : `loaded ${all.length} threads, but the list didn't finish loading; will try again`,
        });
        notes.push(`${all.length} existing threads marked as not new`);
        if (!baselined) return publishEarly(`First run: ${all.length} existing threads marked as not new. Only new threads will be checked.`);
        ({ seen, baselined } = await loadSeen());
        threads = listThreads(); // scrolling may have re-rendered rows
      }

      if (processAll) {
        const { threads: all } = await loadAllThreads();
        threads = all;
      }

      // New threads arrive at the top. Unseen threads dated before today
      // lazy-loaded after the baseline; they are history, not new mail.
      const top = threads.slice(0, settings.topN);
      const fresh = !settings.enabled && !includeSeen ? [] : includeSeen ? top : top.filter((t) => !seen[t.id] && t.recent);
      const stale = includeSeen ? [] : threads.filter((t) => !seen[t.id] && !fresh.includes(t));
      if (stale.length) await markSeen(stale.map((t) => t.id));

      const rows = new Map();
      const shown = () => (processAll ? threads : threads.slice(0, Math.max(LABEL_SCOPE, settings.topN)));
      const publish = (summary) =>
        saveScan(summary, [...new Set([...shown(), ...threads.filter((t) => rows.has(t.id))])].map((t) => rows.get(t.id) ?? knownRow(t, { settings, verdicts })));

      for (const t of fresh) rows.set(t.id, row(t, { label: 'pending', outcome: 'checking…' }));
      await publish('Checking new threads…');
      for (const t of fresh) {
        const res = await processThread(t, { isNew: true, settings, verdicts });
        rows.set(t.id, res.row);
        await log(res.row);
        if (res.done) await markSeen([t.id]);
        await publish('Checking new threads…');
        if (res.abort) break;
      }

      // Display-only labels for existing threads; decide() never deletes
      // them because isNew is false.
      verdicts = await loadVerdicts();
      const unlabelled = shown().filter(
        (t) =>
          !rows.has(t.id) &&
          !isSkippedContact(t, settings) &&
          !cached(verdicts, t) &&
          (!needsOpen(t) || canOpen(false)) &&
          (attempts.get(t.id) ?? 0) < MAX_ATTEMPTS,
      );
      // "Check pictures now" handles every pending picture thread, not a batch.
      const batch = checkPictures
        ? [...unlabelled.filter(needsOpen), ...unlabelled.filter((t) => !needsOpen(t)).slice(0, LABEL_BATCH)]
        : unlabelled.slice(0, LABEL_BATCH);
      if (processAll) {
        // Classify the whole backlog four at a time. Only the LLM calls run in
        // parallel; archiving and trashing (page actions) happen one by one
        // below. Picture threads are left to "Check pictures now".
        const todo = unlabelled.filter((t) => !needsOpen(t));
        let done = 0;
        const worker = async () => {
          for (let t = todo.shift(); t; t = todo.shift()) {
            try {
              await classify(t);
            } catch (err) {
              attempts.set(t.id, (attempts.get(t.id) ?? 0) + 1);
            }
            done++;
            if (done % 4 === 0) await publish(`Classifying ${done}/${done + todo.length}…`);
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        verdicts = await loadVerdicts();
        notes.push(`classified ${done} threads`);
      } else {
        for (const t of batch) {
          const res = await processThread(t, { isNew: false, settings, verdicts });
          rows.set(t.id, res.row);
          await log(res.row);
          await publish('Labelling existing threads…');
        }
      }

      // Old notices and codes that were labelled in an earlier scan.
      if ((settings.enabled || processAll) && settings.archiveOldNotices) {
        verdicts = await loadVerdicts();
        const expired = threads.filter((t) => {
          const v = !rows.has(t.id) && cached(verdicts, t);
          return v && decide(v, { isNew: false, settings, thread: t }).archive;
        });
        let archived = 0;
        for (const t of processAll ? expired : expired.slice(0, LABEL_BATCH)) {
          const res = await processThread(t, { isNew: false, settings, verdicts, explicit: processAll });
          rows.set(t.id, res.row);
          await log(res.row);
          if (res.row.outcome?.startsWith('archived')) archived++;
          await publish('Archiving old notices…');
          if (res.abort) break;
        }
        if (archived) notes.push(`archived ${archived} old notices`);
      }

      if (processAll && settings.dryRun) notes.push('dry run is on, so spam was labelled but not trashed');
      if (trashSpam || (processAll && !settings.dryRun)) {
        verdicts = await loadVerdicts();
        const spam = threads.filter((t) => {
          const v = !rows.has(t.id) && cached(verdicts, t);
          return v && v.label === 'spam' && v.score >= settings.threshold;
        });
        let moved = 0;
        for (const t of spam) {
          // isNew: true makes decide() act on it like a newly arrived thread.
          const res = await processThread(t, { isNew: true, settings, verdicts, explicit: true, recheck: true });
          rows.set(t.id, res.row);
          await log(res.row);
          if (res.row.outcome === 'deleted') moved++;
          await publish('Moving spam to trash…');
          if (res.abort) break;
        }
        notes.push(`moved ${moved} of ${spam.length} spam threads to trash`);
      }

      const pending = unlabelled.length - batch.length;
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
      forceOpen = false;
      scanning = false;
      if (rescan) {
        rescan = false;
        const next = pendingOpts;
        pendingOpts = {};
        setTimeout(() => scan(next), 500);
      }
    }
  }

  let timer;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => scan(), 1500);
  };
  // Event-driven: Messages renders new texts (pushed to it by Google) into
  // the conversation list, so watch just that list. Changes that aren't new
  // messages are ignored: our own badges, and the timestamps ticking from
  // "34 min" to "35 min". Until the list exists (page still loading), and if
  // Messages replaces it, the observer falls back to the body.
  const IGNORED = '.msf-badge, mws-relative-timestamp';
  const isOwnOrTick = (node) => {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return !!el?.closest?.(IGNORED) || !!el?.matches?.(IGNORED);
  };
  // Judge a change by where it happened: removed nodes are already detached,
  // so they can't be traced back to a timestamp. Inside a timestamp or badge:
  // ignore. Elsewhere: relevant unless it only adds or removes our badges.
  const isBadge = (n) => n.nodeType === Node.ELEMENT_NODE && n.matches('.msf-badge');
  const relevant = (records) =>
    records.some((r) => {
      if (isOwnOrTick(r.target)) return false;
      const nodes = [...r.addedNodes, ...r.removedNodes];
      return !nodes.length || nodes.some((n) => !isBadge(n));
    });
  let watched = null;
  const observer = new MutationObserver((records) => {
    if (relevant(records)) schedule();
    attachObserver();
  });
  function attachObserver() {
    const list = document.querySelector('mws-conversations-list') ?? document.body;
    if (list === watched && list.isConnected) return;
    observer.disconnect();
    observer.observe(list, { childList: true, subtree: true, characterData: true });
    watched = list;
  }
  attachObserver();
  // Backstop only; the observer is the main trigger.
  setInterval(() => {
    attachObserver();
    scan();
  }, 120000);
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
      scan({ includeSeen: !!msg.includeSeen, checkPictures: !!msg.checkPictures, trashSpam: !!msg.trashSpam, processAll: !!msg.processAll }).then(
        (summary) => sendResponse({ ok: true, summary }),
      );
      return true;
    }
  });
})();
