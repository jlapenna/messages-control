/* Messages Control — triage console prototype. All data is embedded mock data;
   every action is simulated locally and announced with a SIMULATED toast. */
(function () {
  'use strict';

  const D = window.MC_DATA;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const NOW = new Date(D.now);
  const VIEWS = ['feed', 'log', 'settings', 'runner', 'panel'];
  const STATES = [
    ['normal', 'Normal', 'Mock threads, runner watching'],
    ['empty', 'Empty', 'No new threads since first scan'],
    ['loading', 'Loading', 'Waiting on the runner'],
    ['error', 'Classifier error', 'LiteLLM returns 401'],
    ['offline', 'Offline runner', 'No heartbeat; cached data only'],
  ];
  const CLS = {
    spam: 'Spam', otp: 'One-time code', notice: 'Automated notice',
    important: 'Important', unsure: 'Unsure', pending: 'Not classified', system: 'System',
  };
  const ICONS = {
    check: '<path d="M3.5 8.5l3 3 6-7"/>',
    clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
    block: '<circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
    archive: '<path d="M2.5 3.5h11v3h-11zM3.5 6.5v6h9v-6M6.5 9h3"/>',
    hold: '<path d="M8 2.5v6M8 11.5v.5"/><circle cx="8" cy="8" r="6"/>',
    alert: '<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.3v.2"/>',
    plug: '<path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 01-7 0zM8 11.5v2"/>',
    x: '<path d="M4 4l8 8M12 4l-8 8"/>',
    gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"/>',
  };
  const ic = (n) => `<svg class="ic" viewBox="0 0 16 16" aria-hidden="true">${ICONS[n]}</svg>`;

  const store = {
    get(k) { try { return localStorage.getItem('mc.' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('mc.' + k, v); } catch (e) { /* file:// without storage */ } },
  };

  const S = {
    view: VIEWS.includes(store.get('view')) ? store.get('view') : 'feed',
    demo: 'normal',
    mode: 'dry',
    saved: clone(D.config),
    draft: clone(D.config),
    threads: clone(D.threads),
    reserve: clone(D.reserve),
    log: [],
    selected: D.threads[0].id,
    logSel: null,
    panelSel: null,
    panelOpen: null,
    feedFilter: 'all',
    logCls: 'all',
    logMode: 'all',
    lastAction: { text: 'Sweep 09:28 · dry run · 1 new thread', at: D.lastSweep },
    sweeping: false,
    processing: null,
    testText: D.samples[0].text,
    testState: null,
    replacingKey: false,
    clock: new Date(NOW),
  };

  /* ---------- time ---------- */
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function when(iso) {
    const d = new Date(iso);
    if (sameDay(d, NOW)) return hm(d);
    const y = new Date(NOW); y.setDate(y.getDate() - 1);
    const t = new Date(NOW); t.setDate(t.getDate() + 1);
    if (sameDay(d, y)) return `yesterday ${hm(d)}`;
    if (sameDay(d, t)) return `tomorrow ${hm(d)}`;
    return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm(d)}`;
  }
  function dayLabel(iso) {
    const d = new Date(iso);
    const y = new Date(NOW); y.setDate(y.getDate() - 1);
    const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
    if (sameDay(d, NOW)) return `Today · ${base}`;
    if (sameDay(d, y)) return `Yesterday · ${base}`;
    return base;
  }
  function tick() {
    S.clock = new Date(S.clock.getTime() + 60000);
    return `${S.clock.getFullYear()}-${pad(S.clock.getMonth() + 1)}-${pad(S.clock.getDate())}T${hm(S.clock)}`;
  }
  const pf = (p) => (p == null ? '—' : p.toFixed(2));
  const isNum = (s) => /\d/.test(s);

  /* ---------- classification + policy (mirrors the runner's rules) ---------- */
  function classify(t, cfg = S.draft, ignoreDemo = false) {
    if (!ignoreDemo && S.demo === 'error' && t.pendingOnError) return { cls: 'pending' };
    if (t.named && cfg.skipNamedContacts) return { cls: 'important', skipped: true };
    if (t.p >= cfg.threshold) return { cls: 'spam' };
    if (t.p >= 0.5) return { cls: 'unsure' };
    if (t.otp) return { cls: 'otp' };
    if (t.notification) return { cls: 'notice' };
    return { cls: 'important' };
  }

  function actionFor(t, v, cfg = S.draft, mode = S.mode) {
    const o = t.override;
    if (o) {
      const label = { keep: 'kept it', archive: 'archived it', block: 'blocked & reported', trash: 'trashed it' }[o.action];
      if (o.held) return { key: o.action, text: `You: would ${o.action === 'block' ? 'block & report' : 'trash'} (dry run)`, done: false };
      return { key: o.action, text: `You ${label} · ${when(o.at)}`, done: true, tone: 'you' };
    }
    switch (v.cls) {
      case 'pending': return { key: 'none', text: 'Waiting for the classifier', plain: true };
      case 'spam': {
        const trash = cfg.spamAction === 'trash';
        if (mode === 'dry') return { key: trash ? 'trash' : 'block', text: trash ? 'Would trash' : 'Would block & report', done: false };
        return { key: trash ? 'trash' : 'block', text: `${trash ? 'Trashed' : 'Blocked & reported'} · ${when(t.at)}`, done: true, tone: 'spam' };
      }
      case 'otp':
      case 'notice': {
        if (!cfg.archiveOldNotices) return { key: 'label', text: 'Labelled · stays in inbox', done: true };
        const hours = v.cls === 'otp' ? 6 : 24;
        const at = new Date(new Date(t.at).getTime() + hours * 3600000);
        if (at <= NOW) return { key: 'archive', text: `Labelled · archived ${when(at.toISOString())}`, done: true, archive: hours };
        return { key: 'archive', text: `Labelled · archives ${when(at.toISOString())}`, done: false, sched: true, archive: hours };
      }
      case 'unsure': return { key: 'hold', text: 'Held for review', done: true, tone: 'unsure' };
      default:
        return v.skipped ? { key: 'skip', text: 'Skipped · named contact', plain: true } : { key: 'leave', text: 'Leave alone', plain: true };
    }
  }

  const actIcon = (a) => ({ block: 'block', trash: 'trash', archive: a.done ? 'archive' : 'clock', hold: 'hold', keep: 'check', label: 'check' }[a.key]);
  function actHTML(a) {
    const cls = a.plain ? 'plain' : a.done ? `done${a.tone ? ' t-' + a.tone : ''}` : '';
    const i = actIcon(a);
    return `<span class="act ${cls}">${i ? ic(i) : ''}<span>${esc(a.text)}</span></span>`;
  }
  const chip = (cls) => `<span class="chip c-${cls}"><i></i>${CLS[cls]}</span>`;

  function meterHTML(p, cls, thr, big) {
    const fill = p == null || cls === 'pending' ? 0 : Math.max(0, Math.min(1, p)) * 100;
    const band = Math.max(0, thr - 0.5) * 100;
    const labs = big ? `<span class="meter-lab below l0" style="left:0">0</span><span class="meter-lab below" style="left:50%">0.5</span><span class="meter-lab below l1" style="left:100%">1</span>
      <span class="meter-lab above${thr > 0.9 ? ' l1' : ''}" style="left:${thr * 100}%">cut ${thr.toFixed(2)}</span>` : '';
    return `<div class="meter${big ? ' big' : ''}" role="img" aria-label="p(spam) ${pf(p)}, cut line ${thr.toFixed(2)}">
      <div class="meter-track"><div class="meter-band" style="width:${band}%"></div><div class="meter-fill f-${cls}" style="width:${fill}%"></div></div>
      <div class="meter-mid"></div><div class="meter-cut" style="left:${thr * 100}%"></div>${labs}</div>`;
  }

  /* ---------- data views ---------- */
  function buildLog() {
    S.log = [
      { id: 'sys-sweep', at: D.lastSweep.slice(0, 16), system: true, mode: 'dry', text: 'Sweep · dry run · 20 threads checked · 1 new' },
      ...S.threads.map((t) => {
        const v = classify(t, S.saved, true);
        const a = actionFor(t, v, S.saved, 'dry');
        return {
          id: 'e-' + t.id, at: t.at, threadId: t.id, sender: t.sender, cls: v.cls, p: v.skipped ? null : t.p, mode: 'dry',
          action: a.key, actionText: a.text, done: a.done, tone: a.tone, plain: a.plain,
          reason: v.skipped ? 'Named contact: not sent to the model.' : t.reason, preview: t.snippet,
        };
      }),
      ...D.history.map((h, i) => Object.assign({ id: 'h' + i }, h)),
    ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }
  function pushLog(e) { S.log.unshift(Object.assign({ id: 'n' + Date.now() + Math.random() }, e)); }

  const feedThreads = () => (S.demo === 'empty' || S.demo === 'loading' ? [] : S.threads);
  function feedFiltered() {
    return feedThreads().filter((t) => {
      if (S.feedFilter === 'all') return true;
      return classify(t).cls === S.feedFilter;
    });
  }
  function logEntries() {
    let list = S.demo === 'empty' ? S.log.filter((e) => e.system && e.at < '2026-10-12') : S.log;
    if (S.logCls !== 'all') list = list.filter((e) => (S.logCls === 'system' ? e.system : e.cls === S.logCls));
    if (S.logMode !== 'all') list = list.filter((e) => e.mode === S.logMode);
    return list;
  }
  const offline = () => S.demo === 'offline';

  /* ---------- toasts / last action ---------- */
  function toast(msg, tone) {
    const el = document.createElement('div');
    el.className = 'toast' + (tone === 'warn' ? ' warn' : '');
    el.innerHTML = `<span class="tag">SIMULATED</span><span class="msg">${msg}</span>`;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4200);
    while ($('#toasts').children.length > 3) $('#toasts').firstElementChild.remove();
  }
  function setLast(text, at) { S.lastAction = { text, at: at || tick() }; renderChrome(); }

  /* ---------- chrome: pill, mode switches, strip, banners, tabs ---------- */
  function renderChrome() {
    document.body.dataset.view = S.view;
    document.body.dataset.mode = S.mode;
    document.body.dataset.state = S.demo;

    const pill = {
      normal: ['', 'Watching'], empty: ['', 'Watching'], loading: ['wait', 'Connecting…'],
      error: ['err', 'Classifier error'], offline: ['off', 'Runner offline'],
    }[S.demo];
    $('#runnerPill').innerHTML = `<span class="dot ${pill[0]}" aria-hidden="true"></span><span class="rp-text">${pill[1]}</span>`;
    $('#runnerPill').setAttribute('aria-label', 'Runner: ' + pill[1]);

    $$('[data-mode-switch]').forEach((g) => {
      g.innerHTML = ['dry', 'live'].map((m) => `<button type="button" data-mode="${m}" aria-pressed="${S.mode === m}" ${offline() ? 'disabled title="Runner offline"' : ''}>${m === 'dry' ? 'Dry run' : 'Live'}</button>`).join('');
    });
    $('#dock').classList.toggle('live', S.mode === 'live');

    const strip = $('#modeStrip');
    strip.className = 'mode-strip' + (S.mode === 'live' ? ' live' : '');
    strip.innerHTML = S.mode === 'dry'
      ? `<span class="mode-name">DRY RUN</span><span class="mode-text">Nothing is blocked, reported or trashed. Dashed actions show what <strong>would</strong> have happened. Codes and notices still archive: archiving keeps history.</span>`
      : `<span class="mode-name">LIVE</span><span class="mode-text">Spam is ${S.saved.spamAction === 'trash' ? 'trashed' : 'blocked and reported'} on your phone as it arrives. Solid actions have run. Trash can't be undone in Google Messages for web.</span>`;

    let banner = '';
    if (S.demo === 'error') {
      banner = `<div class="banner error" role="alert" data-od-id="banner-classifier-error">${ic('alert')}<div class="banner-text"><strong>Classifier request failed · 401 Unauthorized · 09:26</strong>
        <code>POST ${esc(S.saved.endpoint)}</code> · 3 new threads are waiting unclassified. Nothing was acted on.</div>
        <button class="btn btn-sm" data-act="retry">Retry now</button><button class="btn btn-sm btn-ghost" data-goto="settings">Check apiKey</button></div>`;
    } else if (S.demo === 'offline') {
      banner = `<div class="banner offline" role="status" data-od-id="banner-runner-offline">${ic('plug')}<div class="banner-text"><strong>Runner offline · last heartbeat 08:52 (38 min ago)</strong>
        Showing threads cached before it stopped. Sweeps, actions and mode changes are disabled until it reconnects.</div>
        <button class="btn btn-sm" data-goto="runner">Runner status</button></div>`;
    }
    $('#bannerSlot').innerHTML = banner;

    $$('.tab').forEach((t) => {
      const on = t.dataset.view === S.view;
      t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1;
    });
    VIEWS.forEach((v) => { $('#view-' + v).hidden = v !== S.view; });
    const unsure = feedThreads().filter((t) => classify(t).cls === 'unsure').length;
    $('#feedBadge').textContent = unsure || '';
    $('#feedBadge').hidden = !unsure;

    const last = `<b>Last action</b> · ${esc(S.lastAction.text)}`;
    $('#tabLast').innerHTML = last;
    $('#dockLast').textContent = offline() ? 'Runner offline since 08:52 · cached data' : S.lastAction.text;

    requestAnimationFrame(() => document.documentElement.style.setProperty('--topbar-h', $('#topbar').offsetHeight + 'px'));
  }

  /* ---------- feed ---------- */
  function skeletonCards(n) {
    return Array.from({ length: n }, () => `<div class="skel-card" aria-hidden="true"><span class="skel" style="width:38%;height:12px"></span><span class="skel" style="width:92%;height:10px"></span><span class="skel" style="width:70%;height:10px"></span></div>`).join('');
  }
  function earlierHTML() {
    const fs = D.history.find((h) => h.firstScan);
    return `<div class="earlier" data-od-id="feed-past-events"><h2>Earlier</h2>
      <div class="event-row"><span class="chip c-system"><i></i>Past event</span><span class="event-text"><span class="mono">${when(fs.at)}</span> · First scan marked 142 existing threads as seen. They were not classified or touched.</span>
      <button class="linklike" data-goto-log="system">View in log</button></div></div>`;
  }
  function cardHTML(t) {
    const v = classify(t), a = actionFor(t, v);
    const sel = t.id === S.selected;
    return `<li><article class="card${sel ? ' is-selected' : ''}${offline() ? ' is-stale' : ''}${t.isNew ? ' is-new' : ''}" tabindex="${sel ? 0 : -1}" data-thread="${t.id}" data-od-id="thread-card-${t.id}" aria-label="${esc(t.sender)}, ${CLS[v.cls]}">
      <div class="card-main">
        <div class="card-top"><span class="sender${isNum(t.sender) ? ' num' : ''}">${esc(t.sender)}</span><span class="time">${when(t.at)}</span></div>
        <p class="snippet">${esc(t.snippet)}</p>
        ${t.picture || v.skipped ? `<div class="card-tags">${t.picture ? '<span class="utag">picture missing</span>' : ''}${v.skipped ? '<span class="utag" style="color:var(--fg-2);background:var(--sunken)">not sent to model</span>' : ''}</div>` : ''}
      </div>
      <div class="card-side">
        <div class="verdict-row">${chip(v.cls)}${v.skipped ? '<span></span>' : meterHTML(t.p, v.cls, S.draft.threshold)}<span class="pval">${v.skipped || v.cls === 'pending' ? '—' : pf(t.p)}</span></div>
        ${actHTML(a)}
      </div></article></li>`;
  }
  function renderFeed() {
    const el = $('#view-feed');
    const all = feedThreads();
    const counts = { all: all.length };
    all.forEach((t) => { const c = classify(t).cls; counts[c] = (counts[c] || 0) + 1; });
    const filters = [['all', 'All'], ['unsure', 'Unsure'], ['spam', 'Spam'], ['otp', 'Codes'], ['notice', 'Notices'], ['important', 'Important']];
    if (S.demo === 'error') filters.push(['pending', 'Not classified']);
    const unsaved = S.draft.threshold !== S.saved.threshold;
    const sweepDisabled = offline() || S.demo === 'loading' || S.sweeping;
    const head = `<div class="view-head"><div><h1>Live feed</h1><p class="sub">New threads in the top ${S.draft.topN} · last sweep ${when(D.lastSweep)} · model <span class="mono">${esc(S.saved.model)}</span></p></div>
      <button class="btn btn-primary" data-act="sweep" ${sweepDisabled ? 'disabled' : ''} data-od-id="sweep-now">${S.sweeping ? '<span class="spinner"></span>Sweeping…' : 'Sweep now'}</button></div>`;
    const toolbar = `<div class="toolbar"><div class="chips" role="group" aria-label="Filter by classification">${filters.map(([k, l]) => `<button class="fchip" data-feed-filter="${k}" aria-pressed="${S.feedFilter === k}">${l}<span class="n">${counts[k] || 0}</span></button>`).join('')}</div>
      <span class="cut-ind" title="spam_probability at or above the cut is spam; 0.50 up to the cut is held as unsure">Cut line <span class="mono">${S.draft.threshold.toFixed(2)}</span>${unsaved ? '<span class="utag">unsaved preview</span>' : ''}</span></div>`;

    let body;
    if (S.demo === 'loading') body = `<div class="feed" aria-busy="true">${skeletonCards(4)}</div><p class="hint" style="margin-top:10px">Connecting to the runner at <span class="mono">${D.runner.api}</span>…</p>`;
    else if (!all.length) body = `<div class="empty" data-od-id="feed-empty"><h2>No new threads</h2><p>Nothing has arrived in the top ${S.draft.topN} since the last sweep at ${when(D.lastSweep)}. New threads land here as they arrive.</p><button class="btn" data-act="sweep" ${offline() ? 'disabled' : ''}>Sweep again</button></div>`;
    else {
      const list = feedFiltered();
      body = list.length ? `<ul class="feed" role="list" aria-label="Threads">${list.map(cardHTML).join('')}</ul>`
        : `<div class="empty"><h2>Nothing in this filter</h2><p>No ${CLS[S.feedFilter].toLowerCase()} threads at the current cut line.</p><button class="btn" data-feed-filter="all">Show all</button></div>`;
    }
    el.innerHTML = head + (S.demo === 'loading' ? '' : toolbar) + body + (S.demo === 'loading' ? '' : earlierHTML());
    S.threads.forEach((t) => { delete t.isNew; });
  }

  function detailHTML(t) {
    if (!t) return `<div class="rail-empty">Select a thread to see its verdict.<br><kbd>j</kbd> <kbd>k</kbd> move through the feed.</div>`;
    const v = classify(t), a = actionFor(t, v);
    const raw = { spam_probability: t.p, marketing: !!t.marketing, otp: !!t.otp, notification: !!t.notification, transactional: !!t.transactional, extract: t.extract || {}, reason: t.reason };
    const dis = offline() ? 'disabled' : '';
    let actNote = '';
    if (v.cls === 'pending') actNote = 'The classifier request failed. Nothing will happen to this thread until a verdict arrives.';
    else if (a.archive) actNote = `${v.cls === 'otp' ? 'Codes' : 'Notices'} archive ${a.archive} h after arrival. Archiving runs in dry run too: it keeps history.`;
    else if (v.cls === 'spam') actNote = S.mode === 'dry' ? 'Dry run: nothing was sent to your phone.' : `Ran with spamAction <span class="mono">${S.saved.spamAction}</span>.`;
    else if (v.cls === 'unsure') actNote = `p(spam) is between 0.50 and the cut line ${S.draft.threshold.toFixed(2)}, so the thread waits for you.`;
    else if (v.skipped) actNote = 'skipNamedContacts: names without digits or “@” are treated as saved contacts and never sent to the model.';
    return `<div class="detail" data-od-id="thread-detail">
      <div class="detail-head"><div style="min-width:0"><div class="detail-sender${isNum(t.sender) ? ' num' : ''}">${esc(t.sender)}</div><div class="hint mono">${t.id} · ${when(t.at)}${t.picture ? ' · picture' : ''}</div></div>${chip(v.cls)}</div>
      <section><h3>Saved preview</h3><blockquote class="preview">${esc(t.snippet)}</blockquote></section>
      ${v.skipped || v.cls === 'pending' ? '' : `<section><h3>Model verdict</h3>
        <div class="pbig"><span class="num">${pf(t.p)}</span><span class="muted">spam_probability</span></div>
        ${meterHTML(t.p, v.cls, S.draft.threshold, true)}
        <dl class="flags">${['otp', 'notification', 'transactional', 'marketing'].map((k) => `<div><dt>${k}</dt><dd class="${raw[k] ? 't' : ''}">${raw[k]}</dd></div>`).join('')}</dl>
        <p class="reason">${esc(t.reason)}</p>
        <p class="hint mono">model ${esc(S.saved.model)} · LiteLLM · ${(D.runner.latencyMs / 1000).toFixed(1)} s</p></section>`}
      <section><h3>${S.mode === 'dry' && !a.done && !a.plain ? 'Would happen' : 'Action'}</h3>${actHTML(a)}${actNote ? `<p class="hint">${actNote}</p>` : ''}</section>
      <section><h3>Act on this thread</h3>
        <div class="act-grid"><button class="btn" data-thread-act="keep" ${dis}>Keep</button><button class="btn" data-thread-act="archive" ${dis}>Archive</button>
        <button class="btn btn-danger" data-thread-act="block" ${dis}>Block &amp; report</button><button class="btn btn-danger" data-thread-act="trash" ${dis}>Trash</button></div>
        <p class="hint">${offline() ? 'Runner offline: actions are disabled.' : S.mode === 'dry' ? 'Dry run holds block and trash as “would” actions; keep and archive still apply. Simulated.' : 'Live: actions run on your phone. Simulated in this prototype.'}</p></section>
      ${v.skipped ? '' : `<details><summary>Raw model response</summary><pre class="json">${esc(JSON.stringify(raw, null, 2))}</pre></details>`}
    </div>`;
  }

  /* ---------- log ---------- */
  function logRowHTML(e) {
    const sel = e.id === S.logSel;
    const mt = `<span class="mtag${e.mode === 'live' ? ' live' : ''}">${e.mode === 'live' ? 'LIVE' : 'DRY'}</span>`;
    if (e.system) {
      return `<li class="log-row sys${e.firstScan ? ' first' : ''}${sel ? ' is-selected' : ''}" tabindex="${sel ? 0 : -1}" data-log="${e.id}"><span class="lt">${hm(new Date(e.at))}</span><span class="ls">${esc(e.text)}</span><span class="lm">${mt}</span></li>`;
    }
    const a = { key: e.action, text: e.actionText, done: e.done, tone: e.tone, plain: e.plain || e.action === 'leave' };
    return `<li class="log-row${sel ? ' is-selected' : ''}" tabindex="${sel ? 0 : -1}" data-log="${e.id}" data-od-id="log-row-${e.id}">
      <span class="lt">${hm(new Date(e.at))}</span><span class="ls${isNum(e.sender) ? ' num' : ''}">${esc(e.sender)}</span>
      <span class="lv">${chip(e.cls)}</span><span class="lp">${pf(e.p)}</span><span class="la">${actHTML(a)}</span><span class="lm">${mt}</span></li>`;
  }
  function renderLog() {
    const el = $('#view-log');
    const clsF = [['all', 'All'], ['spam', 'Spam'], ['otp', 'Codes'], ['notice', 'Notices'], ['important', 'Important'], ['unsure', 'Unsure'], ['system', 'System']];
    const head = `<div class="view-head"><div><h1>Decision log</h1><p class="sub">Every verdict and action, newest first. Dry-run rows record what would have happened.</p></div>
      <div class="seg" role="group" aria-label="Filter by mode">${[['all', 'All'], ['dry', 'Dry run'], ['live', 'Live']].map(([k, l]) => `<button type="button" data-log-mode="${k}" aria-pressed="${S.logMode === k}">${l}</button>`).join('')}</div></div>
      <div class="toolbar"><div class="chips" role="group" aria-label="Filter by classification">${clsF.map(([k, l]) => `<button class="fchip" data-log-cls="${k}" aria-pressed="${S.logCls === k}">${l}</button>`).join('')}</div></div>`;
    if (S.demo === 'loading') {
      el.innerHTML = head + `<div class="log" aria-busy="true">${Array.from({ length: 6 }, () => '<div class="log-row" aria-hidden="true"><span class="skel" style="height:10px"></span><span class="skel" style="height:10px"></span><span class="skel" style="height:10px"></span><span class="skel" style="height:10px"></span><span class="skel" style="height:10px"></span><span class="skel" style="height:10px"></span></div>').join('')}</div>`;
      return;
    }
    const list = logEntries();
    let rows = '', day = '';
    list.forEach((e) => {
      const d = dayLabel(e.at);
      if (d !== day) { rows += `<li class="log-day">${d}</li>`; day = d; }
      rows += logRowHTML(e);
    });
    el.innerHTML = head + `<ol class="log" aria-label="Decisions">
      <li class="log-head" aria-hidden="true"><span>Time</span><span>Thread</span><span>Verdict</span><span style="text-align:right">p</span><span>Action</span><span style="text-align:right">Mode</span></li>
      ${rows || `<li class="log-empty">${S.demo === 'empty' && S.logCls === 'all' ? 'No decisions yet.' : 'No entries match these filters.'}</li>`}</ol>`;
  }
  function logRail() {
    const list = logEntries().filter((e) => !e.system);
    const keys = ['spam', 'otp', 'notice', 'important', 'unsure'];
    const rows = keys.map((k) => `<tr><td>${chip(k)}</td><td>${list.filter((e) => e.cls === k && e.mode === 'dry').length}</td><td>${list.filter((e) => e.cls === k && e.mode === 'live').length}</td></tr>`).join('');
    const e = S.log.find((x) => x.id === S.logSel);
    let sel = '<div class="rail-sec"><p class="hint">Select a row for its reason and preview. <kbd>j</kbd> <kbd>k</kbd> move.</p></div>';
    if (e && e.system) sel = `<div class="rail-sec"><h2>System event <span class="hint mono">${when(e.at)}</span></h2><p>${esc(e.text)}</p>${e.firstScan ? '<p class="hint">On its first run the watcher records every thread already in the list as seen, so old history is never classified or acted on.</p>' : ''}</div>`;
    else if (e) {
      const undoable = e.mode === 'live' && e.done && (e.action === 'block' || e.action === 'archive') && !e.undone;
      sel = `<div class="rail-sec" data-od-id="log-entry-detail"><h2><span class="${isNum(e.sender) ? 'mono' : ''}">${esc(e.sender)}</span><span class="hint mono">${when(e.at)}</span></h2>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${chip(e.cls)}<span class="mono">${pf(e.p)}</span><span class="mtag${e.mode === 'live' ? ' live' : ''}">${e.mode === 'live' ? 'LIVE' : 'DRY'}</span></div>
        <blockquote class="preview">${esc(e.preview)}</blockquote><p class="reason">${esc(e.reason)}</p>
        ${actHTML({ key: e.action, text: e.actionText, done: e.done, tone: e.tone, plain: e.plain || e.action === 'leave' })}
        ${undoable ? `<button class="btn" data-undo="${e.id}" ${offline() ? 'disabled' : ''}>Undo ${e.action}</button><p class="hint">Undo reverses the ${e.action} and remembers the thread as kept. It runs even in dry run.</p>` : ''}
        ${e.undone ? '<p class="hint">Undone · thread remembered as kept.</p>' : ''}
        ${e.mode === 'live' && e.action === 'trash' ? '<p class="hint">Trash has no undo in Google Messages for web.</p>' : ''}</div>`;
    }
    return sel + `<div class="rail-sec"><h2>Counts in this view</h2><table class="counts"><thead><tr><th>Class</th><th>Dry</th><th>Live</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  /* ---------- settings ---------- */
  function fieldHTML(label, key, ctl, help) {
    return `<div class="field" data-od-id="setting-${key}"><div class="field-label"><strong>${label}</strong><span class="key">${key}</span></div><div class="field-ctl">${ctl}${help ? `<p class="hint">${help}</p>` : ''}</div></div>`;
  }
  const sw = (key, on) => `<button type="button" class="switch" role="switch" aria-checked="${on}" data-switch="${key}" aria-label="${key}"></button>`;
  function renderSettings() {
    const el = $('#view-settings');
    const c = S.draft;
    if (S.demo === 'loading') { el.innerHTML = `<div class="view-head"><div><h1>Settings</h1><p class="sub">Reading ${D.runner.configPath}…</p></div></div>${skeletonCards(3)}`; return; }
    el.innerHTML = `<div class="view-head"><div><h1>Settings</h1><p class="sub"><span class="mono">${D.runner.configPath}</span> · standalone runner · applies after restart</p></div></div>
    <form class="settings" id="settingsForm" novalidate>
      <fieldset class="group"><legend>Classifier</legend>
        ${fieldHTML('Endpoint', 'endpoint', `<input class="input mono" type="url" data-key="endpoint" value="${esc(c.endpoint)}" inputmode="url" autocomplete="off" spellcheck="false">`, 'Any OpenAI-compatible chat completions URL. Here: the LiteLLM proxy.')}
        ${fieldHTML('Model', 'model', `<input class="input mono" type="text" data-key="model" value="${esc(c.model)}" autocomplete="off" spellcheck="false">`, 'The LiteLLM model alias.')}
        ${fieldHTML('API key', 'apiKey', S.replacingKey
          ? `<div class="key-row"><input class="input mono" type="password" data-key="apiKey" placeholder="Paste new key" autocomplete="off"><button type="button" class="btn" data-act="key-cancel">Cancel</button></div>`
          : `<div class="key-row"><input class="input mono" type="text" readonly value="••••••••••••${esc(c.apiKeyLast4)}" aria-label="API key, masked"><button type="button" class="btn" data-act="key-replace">Replace</button></div>`,
          'Never shown in full. <span class="mono">MESSAGES_CONTROL_API_KEY</span> overrides it.')}
      </fieldset>
      <fieldset class="group"><legend>Policy</legend>
        ${fieldHTML('Spam threshold', 'threshold', `<div class="range-row"><input type="range" min="0.5" max="0.99" step="0.01" value="${c.threshold}" data-key="threshold" aria-label="threshold"><output id="thrOut">${c.threshold.toFixed(2)}</output></div>`,
          'spam_probability at or above the cut is spam. From 0.50 up to the cut, threads are held as unsure. Drag to preview: the feed\'s cut line moves now, before you save.')}
        ${fieldHTML('Spam action', 'spamAction', `<div class="seg" role="group" aria-label="spamAction">${[['block', 'Block & report'], ['trash', 'Trash']].map(([k, l]) => `<button type="button" data-spam="${k}" aria-pressed="${c.spamAction === k}">${l}</button>`).join('')}</div>`,
          'Trash has no undo in Google Messages for web. Block &amp; report can be undone from the log.')}
        ${fieldHTML('Skip named contacts', 'skipNamedContacts', `<div class="switch-row"><span>Never send threads with a saved name to the model</span>${sw('skipNamedContacts', c.skipNamedContacts)}</div>`, 'A name without digits or “@” counts as a saved contact. The address book is not read.')}
        ${fieldHTML('Open picture threads', 'openPictureThreads', `<div class="switch-row"><span>Open picture threads so the model can see them</span>${sw('openPictureThreads', c.openPictureThreads)}</div>`, '<span class="warn-note">Opening marks the thread read and can send an RCS read receipt.</span>')}
        ${fieldHTML('Archive old notices', 'archiveOldNotices', `<div class="switch-row"><span>Archive codes after 6 h and notices after 24 h</span>${sw('archiveOldNotices', c.archiveOldNotices)}</div>`, 'Archiving keeps history, so it runs in dry run too.')}
        ${fieldHTML('Threads to watch', 'topN', `<input class="input mono" type="number" min="1" max="100" data-key="topN" value="${c.topN}" inputmode="numeric" style="max-width:140px">`, 'Only threads this close to the top of the list count as newly arrived.')}
      </fieldset>
      <fieldset class="group"><legend>System prompt</legend>
        <div class="field" style="grid-template-columns:minmax(0,1fr)" data-od-id="setting-prompt"><div class="field-ctl">
          <textarea class="input" data-key="prompt" rows="16" spellcheck="false" aria-label="prompt">${esc(c.prompt)}</textarea>
          <div class="prompt-tools"><span class="hint mono" id="promptCount">${c.prompt.length.toLocaleString()} chars${c.prompt === D.config.prompt ? ' · default' : ' · edited'}</span><button type="button" class="btn btn-sm" data-act="prompt-reset">Reset to default</button></div>
          <p class="hint">The reply must stay JSON with spam_probability, marketing, otp, notification, transactional, extract and reason.</p></div></div>
      </fieldset>
      <div class="save-bar" data-od-id="settings-save-bar"><span class="save-state" id="saveState"></span>
        <button type="button" class="btn" data-act="revert">Revert</button><button type="button" class="btn btn-primary" data-act="save" ${offline() ? 'disabled title="Runner offline"' : ''}>Save config</button></div>
    </form>`;
    updateSaveState();
  }
  function changedKeys() {
    return ['apiKey', 'endpoint', 'model', 'threshold', 'spamAction', 'skipNamedContacts', 'openPictureThreads', 'archiveOldNotices', 'topN', 'prompt']
      .filter((k) => (k === 'apiKey' ? !!S.draft.newKey : S.draft[k] !== S.saved[k]));
  }
  function updateSaveState() {
    const el = $('#saveState'); if (!el) return;
    const ch = changedKeys();
    el.className = 'save-state' + (ch.length ? ' dirty' : '');
    el.textContent = offline() ? 'Runner offline: changes can\'t be written.' : ch.length ? `Unsaved: ${ch.join(', ')}` : 'Saved · matches config.json';
  }
  function settingsRail() {
    const thr = S.draft.threshold;
    const border = S.threads.filter((t) => !t.named && t.p >= 0.5).sort((a, b) => b.p - a.p);
    const flips = border.filter((t) => classify(t, S.draft, true).cls !== classify(t, S.saved, true).cls).length;
    const items = border.map((t) => {
      const now = classify(t, S.draft, true).cls, was = classify(t, S.saved, true).cls;
      return `<li class="cut-item"><span class="s${isNum(t.sender) ? ' mono' : ''}">${esc(t.sender)} <span class="hint mono">${pf(t.p)}</span></span><span>${chip(now)}${now !== was ? ` <span class="hint">was ${CLS[was].toLowerCase()}</span>` : ''}</span>${meterHTML(t.p, now, thr)}</li>`;
    }).join('');
    const preview = { apiKey: `••••${S.draft.newKey ? 'new' : S.draft.apiKeyLast4}`, endpoint: S.draft.endpoint, model: S.draft.model, threshold: thr, spamAction: S.draft.spamAction, skipNamedContacts: S.draft.skipNamedContacts, openPictureThreads: S.draft.openPictureThreads, archiveOldNotices: S.draft.archiveOldNotices, topN: S.draft.topN, prompt: `<${S.draft.prompt.length} chars>` };
    const ch = changedKeys();
    const json = JSON.stringify(preview, null, 2).split('\n').map((l) => {
      const k = (l.match(/^\s+"(\w+)"/) || [])[1];
      return k && ch.includes(k) ? `<span class="chg">${esc(l)}</span>` : esc(l);
    }).join('\n');
    return `<div class="rail-sec" data-od-id="cut-line-preview"><h2>Cut-line preview <span class="hint mono">${thr.toFixed(2)} · ${flips} change${flips === 1 ? '' : 's'}</span></h2>
      <p class="hint">Threads in the feed with p(spam) ≥ 0.50. Hatched = unsure band.</p><ul class="cut-list">${items}</ul></div>
      <div class="rail-sec"><h2>config.json <span class="hint">preview · highlighted = unsaved</span></h2><pre class="json">${json}</pre><p class="hint">Written with owner-only permissions (0600). Other keys in the file are preserved.</p></div>`;
  }

  /* ---------- runner ---------- */
  function fakeClassify(text) {
    const s = text.toLowerCase();
    const link = /https?:|\.(com|net|top|co|info|help|xyz)\b|bit\.ly/.test(s);
    const otp = /\b\d{4,8}\b/.test(s) && /(code|password|verification|otp|passcode)/.test(s) && !link;
    const notification = /(ready for pickup|out for delivery|delivered|arriving|approaching|table is ready|session ended)/.test(s);
    const transactional = /(appointment|reminder|receipt|order #|payment due|reservation|confirm)/.test(s) && !link;
    let p = 0.08;
    [/unpaid|late fee|overdue|suspend/, /claim|prize|winner|free spins|gift card/, /crypto|btc|wallet/, /is this \w+\?/, /earn \$|per day|\/day/, /chip in|donate|deadline/, /verify (your )?account/].forEach((r) => { if (r.test(s)) p += 0.24; });
    if (link) p += 0.3;
    if (otp || notification || transactional) p = Math.min(p, 0.05);
    p = Math.round(Math.min(p, 0.98) * 100) / 100;
    const reason = p >= 0.8 ? 'Pressure to act with a link or offer from an unknown sender.' : p >= 0.5 ? 'Some scam signals, but not conclusive.' : otp ? 'One-time code with no link.' : notification ? 'Short-lived status notice.' : transactional ? 'Something to keep or act on later.' : 'Reads as an ordinary personal message.';
    return { spam_probability: p, marketing: false, otp, notification, transactional, extract: transactional ? { summary: text.slice(0, 40) } : {}, reason };
  }
  function renderRunner() {
    const el = $('#view-runner');
    const r = D.runner;
    const head = `<div class="view-head"><div><h1>Runner status</h1><p class="sub">Headless Chrome with its own phone pairing · systemd user unit <span class="mono">messages-control</span></p></div></div>`;
    if (S.demo === 'loading') { el.innerHTML = head + `<div class="rgrid">${skeletonCards(4)}</div>`; return; }
    const off = offline();
    const pairing = off
      ? `<span class="state"><span class="dot off"></span>Unknown while offline</span>`
      : `<span class="state"><span class="dot"></span>Paired</span>`;
    const session = off ? `<span class="state"><span class="dot off"></span>Unreachable</span>`
      : S.demo === 'error' ? `<span class="state"><span class="dot"></span>Healthy · classifier failing</span>` : `<span class="state"><span class="dot"></span>Healthy</span>`;
    const dryCounts = {};
    feedThreads().forEach((t) => { const c = classify(t, S.saved, true).cls; dryCounts[c] = (dryCounts[c] || 0) + 1; });
    const dryLabel = { spam: S.saved.spamAction === 'trash' ? 'would trash' : 'would block', otp: 'labelled', notice: 'labelled', important: 'left alone', unsure: 'held' };
    const rows = ['spam', 'otp', 'notice', 'important', 'unsure'].map((k) => {
      const lv = D.lastLive.rows[k];
      return `<tr><td>${chip(k)}</td><td>${S.demo === 'error' && k !== 'important' ? '—' : dryCounts[k] || 0} <span class="hint">${dryLabel[k]}</span></td><td>${lv[0]} <span class="hint">${lv[1]}</span></td></tr>`;
    }).join('');
    const ts = S.testState;
    let out = '';
    if (ts && ts.loading) out = `<div class="parsed"><span class="spinner"></span>Waiting for <span class="mono">${esc(S.saved.model)}</span>…</div>`;
    else if (ts && ts.error) out = `<div class="banner error" style="margin:0">${ic('alert')}<div class="banner-text"><strong>401 Unauthorized</strong>The endpoint rejected the API key. No verdict.</div></div>`;
    else if (ts && ts.res) {
      const fakeT = Object.assign({ p: ts.res.spam_probability }, ts.res);
      const v = classify(fakeT, S.draft, true), a = actionFor(fakeT, v, S.draft, S.mode);
      out = `<div class="test-out"><pre class="json">${esc(JSON.stringify(ts.res, null, 2))}</pre>
        <div class="parsed"><span class="hint">Parsed →</span>${chip(v.cls)}<span class="mono">${pf(ts.res.spam_probability)}</span><span class="hint">at cut ${S.draft.threshold.toFixed(2)} →</span>${actHTML(a)}</div>
        <p class="hint">Simulated response from a local mock. No request was sent to LiteLLM.</p></div>`;
    }
    el.innerHTML = head + `<div class="rgrid">
      <div class="pcard" data-od-id="runner-pairing"><h2>Phone pairing ${pairing}</h2>
        <dl class="kv"><dt>Paired</dt><dd>${off ? 'unknown' : when(r.pairedAt)}</dd><dt>Profile dir</dt><dd>${r.profileDir}</dd><dt>State</dt><dd>${r.stateFile}</dd></dl>
        <div><button class="btn btn-sm" data-act="repair">Re-pair…</button></div></div>
      <div class="pcard" data-od-id="runner-session"><h2>Browser session ${session}</h2>
        <dl class="kv"><dt>Page</dt><dd>${r.page}</dd><dt>Mode</dt><dd>${r.mode} · ${S.mode === 'dry' ? 'dry run' : 'live'}</dd>
        <dt>Heartbeat</dt><dd>${off ? '08:52 · 38 min ago' : hm(new Date(r.heartbeat)) + ' · 20 s ago'}</dd><dt>Page reload</dt><dd>${when(r.lastReload)} · every ${r.reloadMinutes} min</dd><dt>Local API</dt><dd>${r.api}</dd></dl>
        ${off ? `<p class="hint">Check the service on the runner host: <span class="mono">systemctl --user status messages-control</span></p>` : ''}</div>
      <div class="pcard wide" data-od-id="runner-last-sweep"><h2>Last sweep <span class="hint mono">dry ${when(D.lastSweep)} · --live ${when(D.lastLive.at)}</span></h2>
        <table class="counts"><thead><tr><th>Class</th><th>Dry run · ${feedThreads().length} new</th><th>--live · ${D.lastLive.checked} threads</th></tr></thead><tbody>${rows}</tbody></table>
        ${S.demo === 'error' ? '<p class="hint" style="color:var(--c-spam)">3 threads unclassified in the latest sweep: classifier returned 401.</p>' : ''}</div>
      <div class="pcard wide" data-od-id="test-classifier"><h2>Test classifier <span class="hint">sends sample text, shows the parsed verdict</span></h2>
        <div class="samples" role="group" aria-label="Samples">${D.samples.map((s, i) => `<button class="fchip" data-sample="${i}">${s.label}</button>`).join('')}</div>
        <textarea class="input" id="testText" rows="3" style="min-height:96px;font-family:var(--font-body)" aria-label="Sample message text">${esc(S.testText)}</textarea>
        <div><button class="btn btn-primary" data-act="test" ${off || (ts && ts.loading) ? 'disabled' : ''}>Send to classifier</button></div>${out}</div>
    </div>`;
  }
  function runnerRail() {
    return `<div class="rail-sec"><h2>Runner events</h2><ol class="timeline">${D.runnerEvents.map((e) => `<li class="${e.first ? 'first' : ''}"><span class="tt">${when(e.at)}</span><span>${esc(e.text)}</span></li>`).join('')}</ol></div>
      <div class="rail-sec"><h2>Where things live</h2><dl class="kv"><dt>Config</dt><dd>${D.runner.configPath}</dd><dt>Extension</dt><dd>chrome.storage.local (separate settings)</dd></dl></div>`;
  }

  /* ---------- extension side panel ---------- */
  function renderPanel() {
    const el = $('#view-panel');
    const list = feedThreads();
    let rows;
    if (S.demo === 'loading') rows = Array.from({ length: 6 }, () => '<li class="ext-row" aria-hidden="true"><span class="skel" style="height:10px;width:70%"></span><span class="skel" style="height:10px;width:40px"></span></li>').join('');
    else if (!list.length) rows = '<li class="log-empty">No new threads on this page.</li>';
    else rows = list.map((t) => {
      const v = classify(t), a = actionFor(t, v);
      const open = S.panelOpen === t.id, sel = S.panelSel === t.id;
      const would = S.mode === 'dry' && !a.done && !a.plain && !a.sched;
      return `<li><div class="ext-row${sel ? ' is-selected' : ''}" role="button" tabindex="${sel ? 0 : -1}" aria-expanded="${open}" data-prow="${t.id}" data-od-id="ext-row-${t.id}">
        <span class="s${isNum(t.sender) ? ' num' : ''}">${esc(t.sender)}</span><span class="v">${chip(v.cls)}<span class="pval">${v.skipped || v.cls === 'pending' ? '—' : pf(t.p)}</span></span>
        <span class="a${would ? ' would' : ''}">${esc(would ? a.text.replace(/^Would /, '') : a.text)}</span></div>
        ${open ? `<div class="ext-more"><span class="reason">${esc(v.skipped ? 'Named contact: not sent to the model.' : t.reason)}</span><div class="btns"><button class="btn btn-sm" data-pact="keep" data-tid="${t.id}">Keep</button><button class="btn btn-sm btn-danger" data-pact="block" data-tid="${t.id}">Block &amp; report</button></div></div>` : ''}</li>`;
    }).join('');
    const note = S.demo === 'offline' ? '<div class="ext-note">The extension runs in your Chrome profile, so the headless runner being offline doesn\'t affect it.</div>'
      : S.demo === 'error' ? '<div class="ext-note err">Classifier returned 401. Check the API key in extension settings.</div>' : '';
    el.innerHTML = `<div class="view-head"><div><h1>Extension side panel</h1><p class="sub">The same page code loaded as a Chrome side panel · 360 px wide · its settings live in the Chrome profile</p></div></div>
    <div class="ext-stage" data-od-id="ext-stage">
      <div class="ext-page" aria-hidden="true"><div class="ext-url"><span class="pillurl">messages.google.com/web/conversations</span></div>
        <div class="ext-ph-body"><div class="ext-ph-list">${Array.from({ length: 9 }, (_, i) => `<div class="ext-ph-line"><i></i><span style="width:${60 + ((i * 37) % 35)}%"></span></div>`).join('')}</div>
        <div class="ext-ph-note">Google Messages for web<br>not reproduced in this prototype</div></div></div>
      <aside class="ext-panel" aria-label="Messages Control side panel" data-od-id="ext-panel">
        <div class="ext-chrome"><span class="t"><span class="brand-mark" aria-hidden="true"><span></span><span></span><span></span></span>Messages Control</span>
          <button class="icon-btn" data-act="panel-close" aria-label="Close side panel">${ic('x')}</button></div>
        <div class="ext-head"><div class="row"><span class="mtag${S.mode === 'live' ? ' live' : ''}">${S.mode === 'live' ? 'LIVE' : 'DRY RUN'}</span><span class="hint">${list.length} threads · cut ${S.draft.threshold.toFixed(2)}</span></div></div>
        <div class="ext-actions"><button class="btn btn-primary" data-act="sweep" ${S.demo === 'loading' || S.sweeping ? 'disabled' : ''} data-od-id="ext-sweep">${S.sweeping ? '<span class="spinner"></span>Sweeping' : 'Sweep'}</button>
          <button class="btn" data-act="process-all" ${S.processing != null || S.demo === 'loading' ? 'disabled' : ''} data-od-id="ext-process-all">Process all</button>
          ${S.processing != null ? `<div class="progress" role="progressbar" aria-valuenow="${S.processing}" aria-valuemin="0" aria-valuemax="100"><span style="width:${S.processing}%"></span></div>` : ''}</div>
        ${note}<ul class="ext-list" aria-label="Thread verdicts">${rows}</ul>
        <div class="ext-foot"><span>Settings: this Chrome profile</span><button class="linklike" data-act="ext-settings">Settings</button></div>
      </aside></div>`;
  }

  /* ---------- rail / render ---------- */
  function renderRail() {
    const rail = $('#rail');
    if (S.view === 'feed') rail.innerHTML = S.demo === 'loading' ? '<div class="rail-empty">Loading…</div>' : detailHTML(feedThreads().find((t) => t.id === S.selected));
    else if (S.view === 'log') rail.innerHTML = logRail();
    else if (S.view === 'settings') rail.innerHTML = settingsRail();
    else if (S.view === 'runner') rail.innerHTML = runnerRail();
    else rail.innerHTML = '';
    if (!$('#sheet').hidden) renderSheet();
  }
  function renderView() {
    ({ feed: renderFeed, log: renderLog, settings: renderSettings, runner: renderRunner, panel: renderPanel })[S.view]();
  }
  function render() { renderChrome(); renderView(); renderRail(); }

  function setView(v, focusTab) {
    if (!VIEWS.includes(v)) return;
    S.view = v; store.set('view', v); closeSheet();
    render(); window.scrollTo(0, 0);
    if (focusTab) $('#tab-' + v).focus();
  }

  /* ---------- overlays ---------- */
  const narrow = () => window.matchMedia('(max-width: 1023px)').matches;
  function renderSheet() {
    const t = S.threads.find((x) => x.id === S.selected);
    $('#sheetTitle').textContent = t ? t.sender : 'Thread';
    $('#sheetBody').innerHTML = detailHTML(t);
  }
  function openSheet() { renderSheet(); $('#sheet').hidden = false; document.body.style.overflow = 'hidden'; $('[data-close-sheet]').focus(); }
  function closeSheet() {
    if ($('#sheet').hidden) return;
    $('#sheet').hidden = true; document.body.style.overflow = '';
    const c = $(`[data-thread="${S.selected}"]`); if (c) c.focus({ preventScroll: true });
  }
  let modalReturn = null;
  function openModal({ title, body, confirm, tone, onConfirm, cancel = 'Cancel' }) {
    modalReturn = document.activeElement;
    $('#modalCard').innerHTML = `<h2 id="modalTitle">${title}</h2>${body}<div class="modal-actions">${cancel ? `<button class="btn" data-modal="cancel">${cancel}</button>` : ''}${confirm ? `<button class="btn ${tone === 'live' ? 'btn-live' : tone === 'danger' ? 'btn-danger' : 'btn-primary'}" data-modal="ok">${confirm}</button>` : ''}</div>`;
    $('#modal').hidden = false;
    $('#modal')._ok = onConfirm;
    ($('[data-modal="cancel"]', $('#modal')) || $('[data-modal="ok"]', $('#modal'))).focus();
  }
  function closeModal() { $('#modal').hidden = true; if (modalReturn) modalReturn.focus({ preventScroll: true }); }
  function toggleDemo(open) {
    const p = $('#demoPanel');
    const show = open ?? p.hidden;
    if (show) {
      p.innerHTML = `<h2>Prototype demo controls <button class="icon-btn" data-demo-close aria-label="Close demo controls">${ic('x')}</button></h2>
        <p class="hint">Not part of the product. Switches the mocked runner state.</p>
        <div class="opts" role="radiogroup" aria-label="Demo state">${STATES.map(([k, l, d]) => `<label class="demo-opt"><input type="radio" name="demo" value="${k}" ${S.demo === k ? 'checked' : ''}><span>${l}<small>${d}</small></span></label>`).join('')}</div>
        <button class="btn btn-sm" data-act="reset">Reset mock data</button>`;
    }
    p.hidden = !show;
    $('#demoBtn').setAttribute('aria-expanded', show);
    if (show) $('input:checked', p).focus();
  }

  /* ---------- actions ---------- */
  function requestMode(m) {
    if (m === S.mode) return;
    if (offline()) { toast('Runner offline: mode can\'t change until it reconnects.', 'warn'); return; }
    if (m === 'live') {
      openModal({
        title: 'Switch to live mode?',
        body: `<p>Spam will be <strong>${S.saved.spamAction === 'trash' ? 'trashed' : 'blocked and reported'}</strong> on your phone as it arrives. Trash can't be undone in Google Messages for web; blocks can be undone from the log.</p><p class="hint">Codes and notices already archive in dry run. This sets <span class="mono">dryRun: false</span>.</p>`,
        confirm: 'Switch to live', tone: 'live', onConfirm: () => setMode('live'),
      });
    } else setMode('dry');
  }
  function setMode(m) {
    S.mode = m;
    const at = tick();
    pushLog({ at, system: true, mode: m, text: m === 'live' ? 'Switched to live' : 'Switched to dry run' });
    setLast(m === 'live' ? 'Switched to live' : 'Switched to dry run', at);
    toast(m === 'live' ? 'Live mode on. Feed now shows executed actions.' : 'Dry run on. Feed shows what would happen.');
    render();
  }
  function sweep() {
    if (offline()) { toast('Runner offline: sweep not sent.', 'warn'); return; }
    if (S.sweeping) return;
    S.sweeping = true; renderView();
    setTimeout(() => {
      S.sweeping = false;
      if (S.demo === 'error') { toast('Sweep ran; classifier still returns 401. 3 threads waiting.', 'warn'); setLast('Sweep · classifier 401 · 3 waiting'); render(); return; }
      const t = S.demo === 'empty' ? null : S.reserve.shift();
      if (t) {
        t.at = tick(); t.isNew = true; S.threads.unshift(t);
        const v = classify(t), a = actionFor(t, v);
        pushLog({ at: t.at, threadId: t.id, sender: t.sender, cls: v.cls, p: t.p, mode: S.mode, action: a.key, actionText: a.text, done: a.done, tone: a.tone, reason: t.reason, preview: t.snippet });
        setLast(`Sweep · 1 new · ${a.text.split(' · ')[0]} ${t.sender}`, t.at);
        toast(`Sweep checked ${S.draft.topN} threads: 1 new, ${CLS[v.cls].toLowerCase()} (${pf(t.p)}).`);
      } else {
        setLast(`Sweep · ${S.draft.topN} threads · nothing new`);
        toast(`Sweep checked ${S.draft.topN} threads: nothing new.`);
      }
      render();
    }, 900);
  }
  function threadAct(id, action, fromPanel) {
    const t = S.threads.find((x) => x.id === id); if (!t) return;
    if (offline() && !fromPanel) { toast('Runner offline: action not sent.', 'warn'); return; }
    const run = () => {
      const held = S.mode === 'dry' && (action === 'block' || action === 'trash');
      const at = tick();
      t.override = { action, at, held };
      const v = classify(t);
      const a = actionFor(t, v);
      pushLog({ at, threadId: t.id, sender: t.sender, cls: v.cls, p: t.p, mode: S.mode, manual: true, action, actionText: a.text, done: a.done, tone: a.done ? 'you' : undefined, reason: t.reason, preview: t.snippet });
      setLast(`${a.text.replace(/ · \d\d:\d\d$/, '')} · ${t.sender}`, at);
      toast(held ? `Dry run: ${action === 'block' ? 'block & report' : 'trash'} held for ${esc(t.sender)}. Nothing sent to your phone.` : `${esc(t.sender)}: ${action === 'keep' ? 'kept; rules won\'t act on it again' : action === 'archive' ? 'archived' : action === 'block' ? 'blocked & reported' : 'trashed'}.`);
      render();
    };
    if (action === 'trash' && S.mode === 'live') {
      openModal({ title: 'Trash this thread?', body: `<p><span class="mono">${esc(t.sender)}</span> will be deleted. Trash has no undo in Google Messages for web.</p>`, confirm: 'Trash thread', tone: 'danger', onConfirm: run });
    } else run();
  }
  function moveSel(dir) {
    if (S.view === 'feed') {
      const ids = feedFiltered().map((t) => t.id); if (!ids.length) return;
      const i = ids.indexOf(S.selected);
      S.selected = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + dir))];
      $$('.card').forEach((c) => { const on = c.dataset.thread === S.selected; c.classList.toggle('is-selected', on); c.tabIndex = on ? 0 : -1; });
      renderRail(); focusVisible($(`[data-thread="${S.selected}"]`));
    } else if (S.view === 'log') {
      const ids = logEntries().map((e) => e.id); if (!ids.length) return;
      const i = ids.indexOf(S.logSel);
      S.logSel = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + dir))];
      renderLog(); renderRail(); focusVisible($(`[data-log="${S.logSel}"]`));
    } else if (S.view === 'panel') {
      const ids = feedThreads().map((t) => t.id); if (!ids.length) return;
      const i = ids.indexOf(S.panelSel);
      S.panelSel = ids[Math.max(0, Math.min(ids.length - 1, i < 0 ? 0 : i + dir))];
      renderPanel(); focusVisible($(`[data-prow="${S.panelSel}"]`));
    }
  }
  function focusVisible(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    const r = el.getBoundingClientRect();
    const top = $('#topbar').offsetHeight + 8;
    const bottom = window.innerHeight - ($('#dock').offsetHeight || 0) - 8;
    if (r.top < top) window.scrollBy(0, r.top - top);
    else if (r.bottom > bottom) window.scrollBy(0, r.bottom - bottom);
  }
  function selectThread(id, open) {
    S.selected = id;
    if (narrow()) { if (open) { renderFeed(); openSheet(); } }
    else { $$('.card').forEach((c) => { const on = c.dataset.thread === id; c.classList.toggle('is-selected', on); c.tabIndex = on ? 0 : -1; }); renderRail(); }
  }
  function reset() {
    Object.assign(S, { demo: 'normal', mode: 'dry', saved: clone(D.config), draft: clone(D.config), threads: clone(D.threads), reserve: clone(D.reserve), selected: D.threads[0].id, logSel: null, panelSel: null, panelOpen: null, feedFilter: 'all', logCls: 'all', logMode: 'all', testState: null, processing: null, replacingKey: false, clock: new Date(NOW), lastAction: { text: 'Sweep 09:28 · dry run · 1 new thread', at: D.lastSweep } });
    buildLog(); toggleDemo(false); render(); toast('Mock data reset.');
  }

  /* ---------- events ---------- */
  document.addEventListener('click', (e) => {
    const t = e.target;
    const q = (sel) => t.closest(sel);
    let el;
    if ((el = q('[data-mode]')) && el.closest('[data-mode-switch]')) return requestMode(el.dataset.mode);
    if ((el = q('.tab'))) return setView(el.dataset.view);
    if (q('#demoBtn')) return toggleDemo();
    if (q('[data-demo-close]')) return toggleDemo(false);
    if ((el = q('[data-modal]'))) { const ok = $('#modal')._ok; closeModal(); if (el.dataset.modal === 'ok' && ok) ok(); return; }
    if (t === $('#modal')) return closeModal();
    if (q('[data-close-sheet]') || t === $('#sheet')) return closeSheet();
    if ((el = q('[data-goto]'))) return setView(el.dataset.goto);
    if ((el = q('[data-goto-log]'))) { S.logCls = el.dataset.gotoLog; S.logMode = 'all'; S.logSel = (S.log.find((x) => x.firstScan) || {}).id; return setView('log'); }
    if ((el = q('[data-feed-filter]'))) { S.feedFilter = el.dataset.feedFilter; return renderFeed(); }
    if ((el = q('[data-log-cls]'))) { S.logCls = el.dataset.logCls; renderLog(); return renderRail(); }
    if ((el = q('[data-log-mode]'))) { S.logMode = el.dataset.logMode; renderLog(); return renderRail(); }
    if ((el = q('[data-thread-act]'))) return threadAct(S.selected, el.dataset.threadAct);
    if ((el = q('[data-pact]'))) return threadAct(el.dataset.tid, el.dataset.pact, true);
    if ((el = q('[data-thread]'))) return selectThread(el.dataset.thread, true);
    if ((el = q('[data-log]'))) { S.logSel = el.dataset.log; renderLog(); renderRail(); return; }
    if ((el = q('[data-prow]'))) { S.panelSel = el.dataset.prow; S.panelOpen = S.panelOpen === el.dataset.prow ? null : el.dataset.prow; return renderPanel(); }
    if ((el = q('[data-undo]'))) {
      const en = S.log.find((x) => x.id === el.dataset.undo);
      en.undone = true; const at = tick();
      pushLog({ at, sender: en.sender, cls: en.cls, p: en.p, mode: S.mode, manual: true, action: 'keep', actionText: `Undid ${en.action} · kept`, done: true, tone: 'you', reason: en.reason, preview: en.preview });
      setLast(`Undid ${en.action} · ${en.sender}`, at); toast(`Undid ${en.action} for ${esc(en.sender)}; thread remembered as kept.`);
      renderLog(); return renderRail();
    }
    if ((el = q('[data-sample]'))) { S.testText = D.samples[+el.dataset.sample].text; S.testState = null; return renderRunner(); }
    if ((el = q('[data-switch]'))) {
      const k = el.dataset.switch; S.draft[k] = !S.draft[k]; el.setAttribute('aria-checked', S.draft[k]);
      updateSaveState(); return renderRail();
    }
    if ((el = q('[data-spam]'))) {
      S.draft.spamAction = el.dataset.spam;
      $$('[data-spam]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.spam === S.draft.spamAction));
      updateSaveState(); return renderRail();
    }
    const act = (el = q('[data-act]')) && el.dataset.act;
    switch (act) {
      case 'sweep': return sweep();
      case 'retry':
        el.disabled = true; el.innerHTML = '<span class="spinner"></span>Retrying';
        return setTimeout(() => { toast('Retry sent: still 401 Unauthorized. Check apiKey in Settings.', 'warn'); renderChrome(); }, 800);
      case 'key-replace': S.replacingKey = true; renderSettings(); return $('[data-key="apiKey"]').focus();
      case 'key-cancel': S.replacingKey = false; delete S.draft.newKey; renderSettings(); return renderRail();
      case 'prompt-reset': S.draft.prompt = D.config.prompt; $('[data-key="prompt"]').value = S.draft.prompt; updatePromptCount(); updateSaveState(); return renderRail();
      case 'revert': S.draft = clone(S.saved); S.replacingKey = false; renderSettings(); renderRail(); renderChrome(); return toast('Reverted to the saved config.');
      case 'save': {
        const ch = changedKeys();
        if (!ch.length) return toast('Nothing to save; config.json already matches.');
        if (S.draft.newKey) { S.draft.apiKeyLast4 = S.draft.newKey.slice(-4).padStart(4, '•'); delete S.draft.newKey; }
        S.saved = clone(S.draft); S.replacingKey = false;
        setLast(`Saved config · ${ch.join(', ')}`);
        toast(`config.json written (0600): ${ch.join(', ')}. Restart the watcher to apply.`);
        renderSettings(); return renderRail();
      }
      case 'test': {
        const text = $('#testText').value.trim();
        if (!text) return toast('Add some text to classify.', 'warn');
        S.testText = text; S.testState = { loading: true }; renderRunner();
        return setTimeout(() => { S.testState = S.demo === 'error' ? { error: true } : { res: fakeClassify(text) }; renderRunner(); toast('Test verdict from a local mock; nothing sent to LiteLLM.'); }, 700);
      }
      case 'repair':
        return openModal({ title: 'Re-pair the runner?', body: `<p>This stops the watcher, opens <span class="mono">pair --headed</span> with a QR code, and needs approval on your phone. The watcher restarts afterwards.</p>`, confirm: 'Start pairing', onConfirm: () => toast('Pairing flow would start; watcher would stop first.') });
      case 'process-all':
        return openModal({
          title: 'Process all threads?', confirm: 'Process all',
          body: '<p>Classifies every thread in history, not just new arrivals, and sends their text to the model provider. In full mode, old codes and notices also archive.</p>',
          onConfirm: () => {
            S.processing = 0; renderPanel();
            const iv = setInterval(() => {
              S.processing = Math.min(100, S.processing + 20); renderPanel();
              if (S.processing >= 100) { clearInterval(iv); S.processing = null; setLast('Process all · 142 threads classified'); toast('Process all finished: 142 threads classified (mock).'); render(); }
            }, 300);
          },
        });
      case 'ext-settings': return toast('Would open the extension options page. Its settings are stored in this Chrome profile, separate from the runner\'s config.json.');
      case 'panel-close': return toast('Would close the Chrome side panel.');
      case 'reset': return reset();
    }
  });

  function updatePromptCount() {
    const el = $('#promptCount'); if (el) el.textContent = `${S.draft.prompt.length.toLocaleString()} chars${S.draft.prompt === D.config.prompt ? ' · default' : ' · edited'}`;
  }
  document.addEventListener('input', (e) => {
    const k = e.target.dataset && e.target.dataset.key;
    if (e.target.name === 'demo') { S.demo = e.target.value; S.testState = null; render(); toast(`Demo state: ${STATES.find((s) => s[0] === S.demo)[1]}.`); return; }
    if (!k) return;
    if (k === 'threshold') { S.draft.threshold = +e.target.value; $('#thrOut').textContent = S.draft.threshold.toFixed(2); renderChrome(); }
    else if (k === 'topN') S.draft.topN = Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 1));
    else if (k === 'apiKey') { if (e.target.value) S.draft.newKey = e.target.value; else delete S.draft.newKey; }
    else { S.draft[k] = e.target.value; if (k === 'prompt') updatePromptCount(); }
    updateSaveState(); renderRail();
  });
  document.addEventListener('submit', (e) => e.preventDefault());

  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (!$('#modal').hidden) return closeModal();
      if (!$('#sheet').hidden) return closeSheet();
      if (!$('#demoPanel').hidden) { toggleDemo(false); return $('#demoBtn').focus(); }
      return;
    }
    if (!$('#modal').hidden) return;
    const tgt = e.target;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName) || tgt.isContentEditable) return;
    if (tgt.classList && tgt.classList.contains('tab') && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      const i = VIEWS.indexOf(S.view); e.preventDefault();
      return setView(VIEWS[(i + (e.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length], true);
    }
    if (e.key === 'j' || e.key === 'k') { e.preventDefault(); return moveSel(e.key === 'j' ? 1 : -1); }
    if ((e.key === 'Enter' || e.key === ' ' || e.key === 'o') && tgt.dataset) {
      if (tgt.dataset.thread) { e.preventDefault(); return selectThread(tgt.dataset.thread, true); }
      if (tgt.dataset.prow) { e.preventDefault(); return tgt.click(); }
      if (tgt.dataset.log) { e.preventDefault(); return tgt.click(); }
    }
    if (e.key === 'o' && S.view === 'feed' && narrow()) return openSheet();
    if (/^[1-5]$/.test(e.key)) return setView(VIEWS[+e.key - 1]);
    if (e.key === '?') {
      return openModal({
        title: 'Keyboard shortcuts', cancel: 'Close',
        body: `<dl class="shortcuts"><dt><kbd>j</kbd> <kbd>k</kbd></dt><dd>Next / previous thread or log row</dd><dt><kbd>Enter</kbd> <kbd>o</kbd></dt><dd>Open the selected thread</dd><dt><kbd>1</kbd>–<kbd>5</kbd></dt><dd>Feed, Log, Settings, Runner, Side panel</dd><dt><kbd>Esc</kbd></dt><dd>Close sheet, dialog or demo controls</dd><dt><kbd>?</kbd></dt><dd>This list</dd></dl><p class="hint">Mode changes are never bound to a key.</p>`,
      });
    }
  });
  document.addEventListener('click', (e) => {
    const p = $('#demoPanel');
    if (!p.hidden && !p.contains(e.target) && !e.target.closest('#demoBtn')) toggleDemo(false);
  }, true);
  window.addEventListener('resize', () => {
    document.documentElement.style.setProperty('--topbar-h', $('#topbar').offsetHeight + 'px');
    if (!narrow()) closeSheet();
  });

  buildLog();
  render();
})();
