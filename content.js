// Watches the Google Messages conversation list. New threads are classified
// and spam among them is deleted; every other listed thread is classified
// for display only (badge and side panel), never deleted.
(() => {
  const { listThreads, loadAllThreads, readThread, isMediaSnippet, isPlaceholderSnippet, deleteThread, archiveThread, blockThread, unblockThread, unarchiveThread, sendText, markThread, diagnose, waitFor } = globalThis.MessagesDom;
  const SEEN_LIMIT = 5000;
  // Above the size of a long history, so "Process all messages" doesn't evict
  // the verdicts it just made for the newest threads.
  const VERDICT_LIMIT = 5000;
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
  // Options of requests that arrived while a scan was running, merged, and
  // the callers waiting for that follow-up scan's result.
  let pendingOpts = {};
  let pendingWaiters = [];

  const pct = (x) => `${Math.round(x * 100)}%`;

  async function send(msg) {
    const res = await chrome.runtime.sendMessage(msg);
    if (!res?.ok) throw new Error(res?.error ?? 'no response from background');
    return res;
  }

  const log = (entry) => send({ type: 'log', entry }).catch((e) => console.warn('[messages-control] log failed', e));

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

  // Writes are read-modify-write of one stored object; parallel classify
  // workers would overwrite each other, so they go through a queue.
  let verdictQueue = Promise.resolve();
  function rememberVerdict(id, verdict) {
    const run = verdictQueue.then(async () => {
      const verdicts = await loadVerdicts();
      verdicts[id] = verdict;
      const entries = Object.entries(verdicts).sort((a, b) => b[1].time - a[1].time).slice(0, VERDICT_LIMIT);
      await chrome.storage.local.set({ verdicts: Object.fromEntries(entries) });
    });
    verdictQueue = run.catch(() => {});
    return run;
  }


  // Bump when classification changes enough that old verdicts should be redone
  // (2: spam_probability scoring and picture checks; 3: notifications;
  // 4: byModel, so codes can be archived; 5: marketing; 6: utility and bank
  // alerts are no longer marketing; 7: a missing picture no longer caps the
  // score, so only verdicts made without their picture are redone).
  const VERDICT_VERSION = 7;
  // A verdict is reused only for the same preview text and the same latest
  // message: picture threads all say "Picture", so a newer message (by list
  // timestamp, 5 minutes' slack for "34 min" drifting) invalidates it.
  const STALE_SLACK_MS = 5 * 60000;
  // Each version only redraws one line, so older verdicts on the other side
  // of it still hold (throwing them away cost the history its labels):
  // 6 narrowed marketing, 5 split marketing out of "ok", 4 changed codes.
  const versionOk = (v) =>
    v.version === VERDICT_VERSION ||
    (v.media !== 'picture not retrieved' &&
      (v.version === 6 ||
        (v.label !== 'marketing' &&
          (v.version === 5 || (v.label !== 'ok' && (v.version === 4 || (v.version === 3 && v.label !== 'otp')))))));
  const cached = (verdicts, t) => {
    const v = verdicts[t.id];
    if (!v || v.text !== t.text || !versionOk(v)) return null;
    if (t.msgTime != null && v.msgTime != null && t.msgTime > v.msgTime + STALE_SLACK_MS) return null;
    return v;
  };

  function badge(id, v) {
    if (v.label === 'spam') markThread(id, `Spam ${pct(v.score)}`, v.reason);
    else if (v.label === 'held') markThread(id, 'Review', v.reason, '#b26a00');
    else if (v.label === 'transactional') markThread(id, 'Keep', v.extract?.summary ?? v.reason, '#1a7f37');
    else if (v.label === 'marketing') markThread(id, 'Marketing', v.reason, '#7b1fa2');
    else if (v.label === 'otp') markThread(id, 'OTP', v.reason, '#0b57d0');
    else if (v.label === 'notice') markThread(id, 'Notice', v.reason, '#5f6368');
  }

  const looksLikeNamedContact = (name) => !!name && !/[\d@]/.test(name);
  const isSkippedContact = (t, settings) => settings.skipNamedContacts && looksLikeNamedContact(t.name);

  // Opening a thread moves the user's view, so existing picture threads are
  // only opened while the Messages tab is in the background.
  // forceOpen: the user pressed "Check pictures now".
  let forceOpen = false;
  // Standalone (src/cli.js) owns its tab, so there it may open at any time.
  const canOpen = (isNew) => isNew || forceOpen || document.visibilityState === 'hidden' || !!globalThis.MessagesControlStandalone;
  let openPictures = true; // refreshed from settings at the start of each scan
  const needsOpen = (t) => openPictures && isMediaSnippet(t.text);

  async function classify(thread) {
    const payload = { name: thread.name, text: thread.text, media: isMediaSnippet(thread.text) };
    if (needsOpen(thread)) {
      try {
        Object.assign(payload, await readThread(thread.id));
      } catch (err) {
        console.warn('[messages-control] could not read thread', thread.id, err);
      }
    }
    const { verdict } = await send({ type: 'classify', thread: payload });
    // otp is only set when the model didn't flag spam (see background.js).
    const v = {
      // The model's own labels beat the OTP regex: "pickup code 4821" in an
      // order notice is a notice (24 h), not a one-time code (6 h).
      label: verdict.rawSpam
        ? 'spam'
        : verdict.marketing
          ? 'marketing'
          : verdict.otpByModel
            ? 'otp'
            : verdict.notification
              ? 'notice'
              : verdict.transactional
                ? 'transactional'
                : verdict.otp
                  ? 'otp'
                  : 'ok',
      byModel: verdict.rawSpam || verdict.notification || verdict.otpByModel,
      score: verdict.score,
      reason: verdict.reason,
      extract: verdict.extract ?? undefined,
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

  // What should happen to a thread with this verdict, and why (policy.js).
  // Pure: the caller performs the action when this says so.
  const decide = (v, ctx) => globalThis.MessagesPolicy.decide(v, ctx);

  // One row per thread, shared by the activity log and the last-scan list.
  const row = (t, fields) => ({
    threadId: t.id,
    name: t.name,
    timestamp: t.timestamp,
    text: (t.text ?? '').slice(0, 500),
    ...fields,
  });

  const fromVerdict = (t, v, outcome, rule) => row(t, { label: v.label, score: v.score, reason: v.reason, media: v.media, outcome, rule: rule ?? undefined });
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
    // An MMS still downloading shows a banner, not the message: classifying
    // it would judge nothing. Unseen threads stay new until it loads.
    if (isPlaceholderSnippet(t.text)) {
      return { row: row(t, { label: 'pending', outcome: 'waiting for the message to finish loading' }), done: false };
    }
    let v = recheck && needsOpen(t) ? null : cached(verdicts, t);
    // A new picture thread checked before its picture loaded gets another
    // look as new, so a spam verdict can still act on it.
    if (isNew && v?.media === 'picture not retrieved') v = null;
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
    const { outcome, del, archive, trash, rule } = decide(v, { isNew, settings, thread: t });
    if (isNew && !del && v.media === 'picture not retrieved') {
      const n = (attempts.get(t.id) ?? 0) + 1;
      attempts.set(t.id, n);
      if (n < MAX_ATTEMPTS) return { row: fromVerdict(t, v, `${outcome}; picture not loaded, will check again (${n}/${MAX_ATTEMPTS})`, rule), done: false };
    }
    if (!del && !archive) return { row: fromVerdict(t, v, outcome, rule), done: true };

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
    // Opening the thread for its pictures re-renders the list on the way
    // back; give the row a moment to reappear before calling it changed.
    const current = (await waitFor(() => listThreads().find((x) => x.id === t.id), 5000)) || null;
    const newer = current && current.msgTime != null && t.msgTime != null && current.msgTime > t.msgTime + STALE_SLACK_MS;
    // Opening a picture thread swaps its snippet from "Picture" to the text;
    // that one change is expected when the timestamp agrees. Any other
    // snippet change means a new message.
    const swapped = current && isMediaSnippet(t.text) && current.msgTime != null && t.msgTime != null;
    if (!current || newer || (!swapped && current.text !== t.text)) {
      const what = !current ? 'gone from the list' : newer ? `newer message (${current.timestamp} vs ${t.timestamp})` : `snippet "${current.text.slice(0, 20)}" vs "${t.text.slice(0, 20)}"`;
      return { row: fromVerdict(t, v, `${not}: thread changed since it was checked: ${what}`), done: false };
    }
    // Spam is blocked & reported or trashed, per settings (read fresh);
    // marketing is always trashed.
    const block = !archive && !trash && now.spamAction === 'block';
    // Opt-in: tell a marketing sender to stop before the thread goes. A
    // failed reply is noted and never blocks the trash.
    let replied = '';
    if (trash && v.label === 'marketing' && now.unsubscribeMarketing) {
      try {
        await sendText(t.id, now.unsubscribeText || 'STOP');
        replied = `, replied ${now.unsubscribeText || 'STOP'}`;
      } catch (err) {
        replied = ` (reply failed: ${err.message})`;
      }
    }
    try {
      const method = archive ? await archiveThread(t.id) : block ? await blockThread(t.id) : await deleteThread(t.id);
      const done = (archive ? outcome.replace('archiving', 'archived') : block ? 'blocked & reported' : 'deleted') + replied;
      return { row: { ...fromVerdict(t, v, done, rule), method }, done: true };
    } catch (err) {
      const what = archive ? 'archive' : block ? 'block & report' : 'delete';
      return { row: fromVerdict(t, v, `${what} failed: ${err.message}`, rule), done: true };
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
      // Answer when the follow-up scan that carries these options finishes.
      return new Promise((resolve) => pendingWaiters.push(resolve));
    }
    // processAll: "Process all messages" — load the whole list, label every
    // thread (pictures excepted, see checkPictures), archive old notices, and
    // trash spam unless dry run is on.
    const { includeSeen = false, checkPictures = false, trashSpam = false, processAll = false } = opts;
    scanning = true;
    globalThis.MessagesControlScanning = true; // read by the standalone runner
    try {
      const { settings } = await send({ type: 'getSettings' });
      if (!settings.enabled && !includeSeen && !checkPictures && !trashSpam && !processAll) return 'Watching is off.';
      if (trashSpam && settings.dryRun) return 'Dry run is on; turn it off to act on spam.';
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

      // "Check pictures now" covers picture threads anywhere in the history.
      if (processAll || checkPictures) {
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
      const shown = () => (processAll || checkPictures ? threads : threads.slice(0, Math.max(LABEL_SCOPE, settings.topN)));
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
      // A verdict made without its picture ("picture not retrieved") is
      // redone by "Check pictures now".
      const unlabelled = shown().filter(
        (t) =>
          !rows.has(t.id) &&
          !isPlaceholderSnippet(t.text) &&
          !isSkippedContact(t, settings) &&
          (!cached(verdicts, t) || (checkPictures && needsOpen(t) && cached(verdicts, t).media === 'picture not retrieved')) &&
          (!needsOpen(t) || canOpen(false)) &&
          (attempts.get(t.id) ?? 0) < MAX_ATTEMPTS,
      );
      // "Check pictures now" handles every pending picture thread, not a batch.
      // labelExisting off (spam mode): new threads only, so the history is
      // never classified, opened or read-receipted on the user's behalf.
      const batch = checkPictures
        ? [...unlabelled.filter(needsOpen), ...unlabelled.filter((t) => !needsOpen(t)).slice(0, LABEL_BATCH)]
        : settings.labelExisting === false
          ? []
          : unlabelled.slice(0, LABEL_BATCH);
      if (processAll) {
        // Classify the whole backlog four at a time. Only the LLM calls run in
        // parallel; archiving and trashing (page actions) happen one by one
        // below. Picture threads follow one by one when checkPictures is set,
        // otherwise they're left to "Check pictures now".
        const todo = unlabelled.filter((t) => !needsOpen(t));
        let done = 0;
        const failed = [];
        const worker = async () => {
          for (let t = todo.shift(); t; t = todo.shift()) {
            try {
              await classify(t);
            } catch (err) {
              attempts.set(t.id, (attempts.get(t.id) ?? 0) + 1);
              failed.push(t);
              await log(row(t, { label: 'error', outcome: 'classify failed; will retry in a later scan', reason: err.message }));
            }
            done++;
            if (done % 4 === 0) await publish(`Classifying ${done}/${done + todo.length}…`);
          }
        };
        await Promise.all([worker(), worker(), worker(), worker()]);
        // One more try for calls that failed (gateway blips, timeouts).
        const retry = failed.splice(0);
        for (const t of retry) {
          try {
            await classify(t);
          } catch (err) {
            failed.push(t);
          }
        }
        // Picture threads have to be opened, one at a time (it moves the view).
        let pictures = 0;
        if (checkPictures) {
          for (const t of unlabelled.filter(needsOpen)) {
            await publish(`Checking pictures ${++pictures}…`);
            try {
              await classify(t);
            } catch (err) {
              failed.push(t);
            }
          }
        }
        verdicts = await loadVerdicts();
        notes.push(`classified ${done + pictures - failed.length} threads`);
        if (failed.length) notes.push(`${failed.length} could not be classified (see the log)`);
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

      if (processAll && settings.dryRun) notes.push('dry run is on, so spam was labelled but not blocked or trashed');
      if (trashSpam || (processAll && !settings.dryRun)) {
        verdicts = await loadVerdicts();
        // Spam further down the history isn't rendered until the list loads.
        if (!processAll) {
          await publish('Loading the whole conversation list…');
          threads = (await loadAllThreads()).threads;
        }
        for (const t of threads) {
          const v = cached(verdicts, t);
          if (v) badge(t.id, v);
        }
        // Threads only labelled earlier in this scan still count; skip only
        // those already acted on.
        const acted = (t) => /^(deleted|blocked)/.test(rows.get(t.id)?.outcome ?? '');
        // "Process all messages" acts on everything the rules would delete
        // (marketing too); "Act on existing spam" only on what gets blocked
        // or trashed as spam.
        const spam = threads.filter((t) => {
          const v = !acted(t) && cached(verdicts, t);
          if (!v) return false;
          const d = decide(v, { isNew: true, settings: { ...settings, dryRun: false }, thread: t });
          return d.del && (processAll || !d.trash);
        });
        let moved = 0;
        const actFailed = [];
        for (const t of spam) {
          // isNew: true makes decide() act on it like a newly arrived thread.
          const res = await processThread(t, { isNew: true, settings, verdicts, explicit: true, recheck: true });
          rows.set(t.id, res.row);
          await log(res.row);
          if (['deleted', 'blocked & reported'].includes(res.row.outcome)) moved++;
          else if (/failed/.test(res.row.outcome)) actFailed.push(t);
          await publish(settings.spamAction === 'block' ? 'Blocking & reporting spam…' : 'Moving spam to trash…');
          if (res.abort) break;
        }
        // One more try for the ones that failed (slow dialogs, stray menus).
        for (const t of actFailed) {
          const current = listThreads().find((x) => x.id === t.id);
          if (!current) continue;
          const res = await processThread(current, { isNew: true, settings, verdicts, explicit: true });
          rows.set(t.id, res.row);
          await log(res.row);
          if (['deleted', 'blocked & reported'].includes(res.row.outcome)) moved++;
          if (res.abort) break;
        }
        notes.push(`acted on ${moved} of ${spam.length} spam${processAll ? ' and marketing' : ''} threads`);
      }

      // In "Process all messages" the whole backlog was just classified; what
      // remains is picture threads (left to Check pictures now) and failures.
      const pending = processAll ? 0 : unlabelled.length - batch.length;
      if (processAll && !checkPictures) {
        const pictures = unlabelled.filter(needsOpen).length;
        if (pictures) notes.push(`${pictures} picture threads left for Check pictures now`);
      }
      if (pending) {
        notes.push(`${pending} existing threads still to label`);
        rescan = true;
      }
      const summary = [`${threads.length} threads listed, ${fresh.length} new`, ...notes].join('; ');
      return publish(`${summary}.`);
    } catch (err) {
      console.warn('[messages-control] scan failed', err);
      return `Scan failed: ${err.message}`;
    } finally {
      forceOpen = false;
      scanning = false;
      globalThis.MessagesControlScanning = false;
      if (rescan) {
        rescan = false;
        const next = pendingOpts;
        const waiters = pendingWaiters;
        pendingOpts = {};
        pendingWaiters = [];
        setTimeout(async () => {
          const summary = await scan(next);
          for (const w of waiters) w(summary);
        }, 500);
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
    // Moving to a new list may have missed a message in between.
    if (watched) schedule();
    watched = list;
  }
  attachObserver();
  // If Messages replaces the list element, the old one sends no more events;
  // notice that quickly rather than at the next backstop scan.
  setInterval(attachObserver, 5000);
  // Backstop only; the observer is the main trigger.
  setInterval(() => {
    attachObserver();
    scan();
  }, 120000);
  // Hidden is when existing picture threads may be opened.
  document.addEventListener('visibilitychange', schedule);
  schedule();

  // An explicit action on one thread (the review queue): block, trash,
  // archive, or keep (remembered as a verdict of "ok" so no rule fires
  // again). Destructive actions need live: true from the caller.
  // A thread by id (a prefix is accepted when it names exactly one), loading
  // the whole list if it isn't rendered yet. Throws when not found.
  async function threadById(id) {
    const find = () => {
      const hits = listThreads().filter((x) => x.id === id || x.id.startsWith(id));
      if (hits.length > 1 && !hits.some((x) => x.id === id)) throw new Error(`${id} matches ${hits.length} threads; give more of the id`);
      return hits.find((x) => x.id === id) ?? hits[0];
    };
    let t = find();
    if (!t) {
      await loadAllThreads();
      t = find();
    }
    if (!t) throw new Error(`thread ${id} is not in the conversation list`);
    return t;
  }

  async function act(msg) {
    let t;
    try {
      t = await threadById(msg.id);
    } catch (err) {
      return { ok: false, error: err.message };
    }
    if (msg.action === 'keep') {
      await rememberVerdict(t.id, { label: 'ok', byModel: true, score: 0, reason: 'kept by you', text: t.text, msgTime: t.msgTime, time: Date.now(), version: VERDICT_VERSION });
      await markSeen([t.id]);
      const r = row(t, { label: 'ok', outcome: 'kept by you', rule: 'review' });
      await log(r);
      return { ok: true, row: r };
    }
    if (!msg.live) return { ok: false, error: `${msg.action} needs --live` };
    const fn = { block: blockThread, trash: deleteThread, archive: archiveThread }[msg.action];
    if (!fn) return { ok: false, error: `unknown action ${msg.action}` };
    try {
      const method = await fn(t.id);
      const outcome = { block: 'blocked & reported', trash: 'deleted', archive: 'archived (by you)' }[msg.action];
      const r = { ...row(t, { label: 'review', outcome, rule: 'review' }), method };
      await log(r);
      await markSeen([t.id]);
      return { ok: true, row: r };
    } catch (err) {
      const r = row(t, { label: 'error', outcome: `${msg.action} failed: ${err.message}`, rule: 'review' });
      await log(r);
      return { ok: false, error: err.message };
    }
  }

  // Undo a block or an archive by the sender's name (from the event being
  // undone). The thread is then remembered as "ok" so no rule acts on it
  // again; the person can re-decide with `act`.
  async function undo(msg) {
    const fn = { blocked: unblockThread, archived: unarchiveThread }[msg.kind];
    if (!fn) return { ok: false, error: `cannot undo "${msg.kind}"` };
    const context = { threadId: msg.threadId, name: msg.name, text: msg.text ?? null, rule: 'undo' };
    try {
      const clicked = await fn(msg.name);
      if (msg.threadId) {
        await rememberVerdict(msg.threadId, { label: 'ok', byModel: true, score: 0, reason: `undone by you (${clicked})`, text: '', msgTime: null, time: Date.now(), version: VERDICT_VERSION });
      }
      const r = { ...context, label: 'undo', outcome: clicked === 'Unarchive' ? 'unarchived' : clicked === 'Not spam' ? 'marked not spam' : 'unblocked' };
      await log(r);
      return { ok: true, row: r };
    } catch (err) {
      const r = { ...context, label: 'error', outcome: `undo failed: ${err.message}` };
      await log(r);
      return { ok: false, error: err.message };
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'send') {
      (async () => {
        if (!msg.live) return { ok: false, error: 'sending needs --live' };
        try {
          const t = await threadById(msg.id);
          await sendText(t.id, msg.text);
          const r = row(t, { label: 'sent', outcome: `sent "${msg.text.slice(0, 40)}"`, rule: 'send' });
          await log(r);
          return { ok: true, row: r };
        } catch (err) {
          return { ok: false, error: err.message };
        }
      })().then(sendResponse);
      return true;
    } else if (msg.type === 'undo') {
      undo(msg).then(sendResponse);
      return true;
    } else if (msg.type === 'diagnose') {
      sendResponse({ ok: true, report: diagnose() });
    } else if (msg.type === 'act') {
      act(msg).then(sendResponse);
      return true;
    } else if (msg.type === 'scanNow') {
      scan({ includeSeen: !!msg.includeSeen, checkPictures: !!msg.checkPictures, trashSpam: !!msg.trashSpam, processAll: !!msg.processAll }).then(
        (summary) => sendResponse({ ok: true, summary }),
      );
      return true;
    }
  });
})();
