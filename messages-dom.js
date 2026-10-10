// Driver for the messages.google.com web UI. Pure DOM: no chrome.* APIs, so it
// can be reused from an Electron preload or any other injected context.
//
// Google Messages has no public selectors; these are best guesses with
// fallbacks. diagnose() reports what matched so they can be fixed quickly.
(() => {
  const CONVERSATION_LINK = 'a[href*="/web/conversations/"]';
  const CONVERSATION_ROW = 'mws-conversation-list-item, a[data-e2e-conversation]';
  // List timestamps: "Now", "5 min", "2:14 PM" for today; "Mon", "Sep 3",
  // "9/3/25" for older threads.
  const RECENT_RE = /^(now|just now|\d+\s*mins?(utes?)?( ago)?|\d{1,2}:\d{2}(\s*[ap]\.?m\.?)?)$/i;
  const TIMESTAMP_RE = new RegExp(
    `${RECENT_RE.source}|^(yesterday|mon|tue|wed|thu|fri|sat|sun)$|^[a-z]{3} \\d{1,2}$|^\\d{1,2}/\\d{1,2}(/\\d{2,4})?$`,
    'i',
  );
  // Today's threads show a clock time, "Now" or "5 min"; older ones a day,
  // month or date. Unanchored, because the element can hold the label twice
  // (visible plus screen-reader text).
  const OLDER_RE = /\b(yesterday|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\d{1,2}\/\d{1,2}/i;
  const TODAY_RE = /\bnow\b|\b\d+\s*min|\b\d{1,2}:\d{2}\b/i;
  const isRecent = (ts) => TODAY_RE.test(ts) && !OLDER_RE.test(ts);

  // Calendar days since the thread's last message, from its list timestamp,
  // or null if it can't be read. Messages shows a weekday name for yesterday
  // too ("Monday" on a Tuesday), so weekdays count back from today.
  const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function ageDays(ts, now = new Date()) {
    if (!ts) return null;
    if (isRecent(ts)) return 0;
    if (/\byesterday\b/i.test(ts)) return 1;
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const days = (d) => Math.round((today - d) / 86400000);
    const wd = ts.toLowerCase().match(/\b(sun|mon|tue|wed|thu|fri|sat)/);
    const mon = ts.toLowerCase().match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:, (\d{4}))?/);
    const num = ts.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (mon) {
      let d = new Date(mon[3] ? Number(mon[3]) : now.getFullYear(), MONTHS.indexOf(mon[1]), Number(mon[2]));
      if (d > today) d = new Date(d.getFullYear() - 1, d.getMonth(), d.getDate());
      return days(d);
    }
    if (num) {
      const y = num[3] ? (num[3].length === 2 ? 2000 + Number(num[3]) : Number(num[3])) : now.getFullYear();
      return days(new Date(y, Number(num[1]) - 1, Number(num[2])));
    }
    if (wd) return ((today.getDay() - WEEKDAYS.indexOf(wd[1]) + 7) % 7) || 7;
    return null;
  }

  // Estimated time of the latest message: exact for today ("Now", "34 min",
  // "9:37 AM"), midnight of the day otherwise. Null if unreadable.
  function messageTime(ts, now = new Date()) {
    if (!ts) return null;
    if (isRecent(ts)) {
      if (/\bnow\b/i.test(ts)) return now.getTime();
      const min = ts.match(/\b(\d+)\s*min/i);
      if (min) return now.getTime() - Number(min[1]) * 60000;
      const clock = ts.match(/\b(\d{1,2}):(\d{2})\s*([ap])?/i);
      if (clock) {
        let h = Number(clock[1]) % 12;
        if (clock[3]?.toLowerCase() === 'p') h += 12;
        if (!clock[3] && Number(clock[1]) >= 12) h = Number(clock[1]);
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, Number(clock[2])).getTime();
      }
    }
    const days = ageDays(ts, now);
    if (days == null) return null;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).getTime();
  }

  // "Monday Mon" → "Monday"; "2:14 PM\n2:14 PM" → "2:14 PM".
  function tidyTimestamp(ts) {
    const lines = [...new Set(ts.split(/\n/).map((l) => l.trim()).filter(Boolean))];
    const one = lines.join(' ');
    const words = one.split(/\s+/);
    if (words.length === 2 && words[0].toLowerCase().startsWith(words[1].toLowerCase())) return words[0];
    return one;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout = 5000, interval = 100) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  const visible = (el) => !!el && el.getClientRects().length > 0;
  const label = (el) =>
    `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('mattooltip') ?? ''} ${el.title ?? ''}`.trim();

  function realClick(el) {
    const opts = { bubbles: true, cancelable: true, composed: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
  }

  function hover(el) {
    const opts = { bubbles: true, composed: true, view: window };
    for (const t of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
      el.dispatchEvent(new MouseEvent(t, opts));
    }
  }

  // Thread id from a URL path ("/web/conversations/<id>"). Anchored, because
  // other links embed that path in a query string, e.g. the Google Account
  // button's sign-out link (".../SignOutOptions?continue=...conversations/<id>").
  function threadId(path) {
    const m = path.match(/^\/web\/conversations\/([^/?#]+)/);
    return m && m[1] !== 'new' ? m[1] : null;
  }

  const linkThreadId = (a) => (a.origin === location.origin ? threadId(a.pathname) : null);

  function textOf(root, selectors) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el?.innerText?.trim()) return el.innerText.trim();
    }
    return '';
  }

  const NAME_SELECTORS = ['[data-e2e-conversation-name]', '.name', 'h2', 'h3'];
  const SNIPPET_SELECTORS = ['mws-conversation-snippet', '[data-e2e-conversation-snippet]', '.snippet-text'];

  // Last leaf element that looks like a timestamp, outside the name and
  // snippet. Those are sender-controlled: a spam text reading "Sep 3" must
  // not pass for the thread's timestamp and dodge classification. Without a
  // snippet element they can't be told apart, so there is no fallback.
  function fallbackTimestamp(item) {
    const senderEls = [...NAME_SELECTORS, ...SNIPPET_SELECTORS]
      .map((sel) => item.querySelector(sel))
      .filter(Boolean);
    if (!item.querySelector(SNIPPET_SELECTORS.join(','))) return '';
    const leaves = [...item.querySelectorAll('*')].filter(
      (el) => !el.children.length && !senderEls.some((s) => s.contains(el)),
    );
    return leaves.map((el) => el.textContent.trim()).findLast((t) => TIMESTAMP_RE.test(t)) ?? '';
  }

  // Threads in list order (most recent first).
  function listThreads() {
    const seen = new Set();
    const threads = [];
    for (const a of document.querySelectorAll(CONVERSATION_LINK)) {
      const id = linkThreadId(a);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const item = a.closest('mws-conversation-list-item') ?? a;
      const name =
        textOf(item, NAME_SELECTORS) ||
        (a.innerText.split('\n')[0] ?? '').trim();
      const snippet = textOf(item, SNIPPET_SELECTORS);
      const timestamp = tidyTimestamp(
        textOf(item, ['mws-relative-timestamp', '[data-e2e-conversation-timestamp]', '.timestamp']) ||
        fallbackTimestamp(item));
      threads.push({
        id,
        name,
        snippet,
        timestamp,
        recent: isRecent(timestamp),
        ageDays: ageDays(timestamp),
        msgTime: messageTime(timestamp),
        // No snippet element means no text (e.g. a reaction or picture), not the
        // row's whole text, which would include the name and timestamp.
        text: snippet,
        unread:
          item.matches('.unread, [data-e2e-is-unread="true"]') ||
          !!item.querySelector('.unread, [data-e2e-is-unread="true"]'),
        element: item,
        link: a,
      });
    }
    return threads;
  }

  const findThread = (id) => listThreads().find((t) => t.id === id) ?? null;

  // The list renders lazily: scrolling to the end loads one more page (about
  // 25 threads, a second or two later), after which the real page shows a
  // "Load more conversations" button. Scroll and click it until the list
  // stops growing, put the scroll position back. Returns { threads, complete }.
  const findLoadMore = () =>
    [...document.querySelectorAll('button.load-more, button')].find(
      (b) => visible(b) && (b.classList.contains('load-more') || /^load more conversations$/i.test(b.innerText.trim())),
    );

  // A page usually arrives in about 2 s but has taken 13 s on the real page,
  // so wait generously, and stop only when no "Load more" button is left (or
  // a page never arrives).
  async function loadAllThreads({ maxRounds = 200, pageWaitMs = 20000 } = {}) {
    const first = document.querySelector(CONVERSATION_ROW);
    let scroller = first?.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    // complete: the list stopped growing with no "Load more" left to press.
    if (!scroller) return { threads: listThreads(), complete: !findLoadMore() };
    const top = scroller.scrollTop;
    try {
      let count = listThreads().length;
      let misses = 0;
      for (let i = 0; i < maxRounds && misses < 3; i++) {
        scroller.scrollTop = scroller.scrollHeight;
        const more = findLoadMore();
        if (more) realClick(more);
        const grew = await waitFor(() => listThreads().length > count, more ? pageWaitMs : 3000, 200);
        if (!grew && !findLoadMore()) break;
        if (!grew) {
          misses++; // the button is still there but nothing arrived: press again
          continue;
        }
        misses = 0;
        count = listThreads().length;
      }
      return { threads: listThreads(), complete: !findLoadMore() };
    } finally {
      scroller.scrollTop = top;
    }
  }


  function findMenuItem(re) {
    const items = document.querySelectorAll('[role="menuitem"], .mat-mdc-menu-item, .mat-menu-item');
    return [...items].find((el) => visible(el) && re.test(el.innerText.trim())) ?? null;
  }

  function findDialogButton(re) {
    const dialogs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], mat-dialog-container, mws-dialog');
    for (const d of dialogs) {
      const btn = [...d.querySelectorAll('button')].find((b) => visible(b) && re.test(b.innerText.trim()));
      if (btn) return btn;
    }
    return null;
  }

  const MENU_BUTTON_RE = /options|more|menu|details/i;

  // The per-thread "⋮" button in the conversation list (appears on hover).
  function listMenuButton(thread) {
    const buttons = [...thread.element.querySelectorAll('button')];
    return (
      buttons.find((b) => b.matches('[data-e2e-conversation-list-item-menu]')) ??
      buttons.find((b) => MENU_BUTTON_RE.test(label(b))) ??
      null
    );
  }



  const isOpen = (id) => threadId(location.pathname) === id;

  // The real menu says "Move to trash" (data-e2e-conversation-delete); older
  // or other builds may say "Delete".
  const DELETE_RE = /^(delete|move to trash)$/i;
  const findDeleteItem = () =>
    [...document.querySelectorAll('[data-e2e-conversation-delete]')].find(visible) ?? findMenuItem(DELETE_RE);





  // Closes open menus and our own unfinished dialogs the way a person would:
  // Cancel in a dialog, a click on the overlay backdrop, Escape on the focused
  // element. A synthetic Escape on document alone doesn't close Material menus.
  function closeMenus() {
    for (const c of document.querySelectorAll('mat-dialog-container [data-e2e-action-button-cancel]')) realClick(c);
    for (const b of document.querySelectorAll('.cdk-overlay-backdrop')) realClick(b);
    const esc = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true };
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', esc));
    document.dispatchEvent(new KeyboardEvent('keydown', esc));
  }

  const anyMenuOrDialog = () =>
    [...document.querySelectorAll('[role="menu"], .mat-mdc-menu-panel, mat-dialog-container')].some(visible);

  // Gets the page back to no open menu or dialog; true if it got there.
  async function clearOverlays() {
    for (let i = 0; i < 3 && anyMenuOrDialog(); i++) {
      closeMenus();
      if (await waitFor(() => !anyMenuOrDialog(), 1500)) return true;
    }
    return !anyMenuOrDialog();
  }

  // Deletes a thread: via the list item's menu, else by opening it and using
  // the conversation header menu. Returns the method used.
  // Moves a thread to trash through its list-item menu (verified on the real
  // page). There is deliberately no fallback that opens the thread: opening
  // marks it read and can send a read receipt to the sender.
  // Runs one item of a thread's list-item menu ("Move to trash", "Archive")
  // and waits for the thread to leave the list.
  async function menuAction(id, { attr, text, verb, confirmDialog = null }) {
    const findAnyItem = () =>
      [...document.querySelectorAll(`[${attr}]`)].find(visible) ?? findMenuItem(text);
    // Never act while another menu or dialog is open: its item could be
    // clicked instead of the target's. Close leftovers first.
    if (!(await clearOverlays())) throw new Error(`Another menu or dialog is open and won't close; not ${verb}`);
    const thread = findThread(id);
    if (!thread) throw new Error(`Thread ${id} not in list`);
    hover(thread.element);
    const listBtn = await waitFor(() => (findThread(id) ? listMenuButton(findThread(id)) : null), 1500);
    if (!listBtn) throw new Error('Thread menu button not found');
    realClick(listBtn);
    // The real page links the open menu to its button (aria-controls).
    await waitFor(() => listBtn.getAttribute('aria-expanded') === 'true', 1500);
    const panelId = listBtn.getAttribute('aria-controls');
    const panel = panelId ? document.getElementById(panelId) : null;
    const inPanel = () =>
      panel &&
      ([...panel.querySelectorAll(`[${attr}]`)].find(visible) ??
        [...panel.querySelectorAll('[role="menuitem"], button')].find((el) => visible(el) && text.test(el.innerText.trim())));
    const item = await waitFor(() => (panel ? inPanel() : findAnyItem()), 3000);
    if (!item) {
      closeMenus();
      throw new Error(`"${verb}" menu item not found`);
    }
    realClick(item);
    if (confirmDialog) {
      try {
        await confirmDialog();
      } catch (err) {
        await clearOverlays(); // e.g. a dialog that showed up after we gave up
        throw err;
      }
    } else {
      // Some builds confirm in a dialog; these actions may not. Either the
      // thread leaves the list, or a confirm button shows up first.
      const next = await waitFor(() => (!findThread(id) ? 'gone' : findDialogButton(text)), 5000);
      if (next && next !== 'gone') realClick(next);
    }
    if (!(await waitFor(() => !findThread(id), 15000))) {
      await clearOverlays();
      throw new Error(`Thread still listed after ${verb}`);
    }
    return 'list-menu';
  }

  // Moves a thread to trash through its list-item menu (verified on the real
  // page). There is deliberately no fallback that opens the thread: opening
  // marks it read and can send a read receipt to the sender.
  const deleteThread = (id) => menuAction(id, { attr: 'data-e2e-conversation-delete', text: DELETE_RE, verb: 'moving to trash' });

  // Blocks the sender and reports the thread as spam. The real page asks in a
  // dialog ("You won't receive calls or texts from <number>. This conversation
  // will be moved to 'Spam & blocked.'") with a "Report spam" checkbox (on by
  // default) and Cancel / OK.
  const blockThread = (id) =>
    menuAction(id, {
      attr: 'data-e2e-conversation-menu-block',
      text: /^block (&|and) report spam$/i,
      verb: 'blocking',
      confirmDialog: async () => {
        const dialog = await waitFor(
          () => document.querySelector('[data-e2e-block-and-report-spam-dialog]')?.closest('mat-dialog-container, [role="dialog"]'),
          15000, // has taken over 5 s on the real page
        );
        if (!dialog) throw new Error('Block & report dialog not found');
        const report = dialog.querySelector('input[type="checkbox"]');
        if (report && !report.checked) realClick(report);
        const ok =
          dialog.querySelector('[data-e2e-action-button-confirm]') ??
          [...dialog.querySelectorAll('button')].find((b) => /^(ok|block)$/i.test(b.innerText.trim()));
        if (!ok) throw new Error('Block & report OK button not found');
        realClick(ok);
      },
    });

  // Archives a thread (keeps its history; Messages brings it back when a new
  // message arrives).
  const archiveThread = (id) =>
    menuAction(id, { attr: 'data-e2e-conversation-menu-archive', text: /^archive$/i, verb: 'archiving' });




  // Adds (or updates) a small badge next to the thread's name in the list.
  // The label is drawn by CSS from a data attribute, so it never becomes part
  // of the thread's text that listThreads() reads back.
  const BADGE_CLASS = 'msf-badge';
  function ensureBadgeStyle() {
    if (document.getElementById('msf-badge-style')) return;
    const style = document.createElement('style');
    style.id = 'msf-badge-style';
    style.textContent = `.${BADGE_CLASS}{display:inline-block;margin-left:6px;padding:0 6px;border-radius:8px;
      font-size:11px;line-height:16px;font-weight:600;color:#fff;vertical-align:middle}
      .${BADGE_CLASS}::after{content:attr(data-label)}`;
    document.head.append(style);
  }

  function markThread(id, text, title, color = '#b3261e') {
    const thread = findThread(id);
    if (!thread) return false;
    ensureBadgeStyle();
    let badge = thread.element.querySelector(`.${BADGE_CLASS}`);
    if (badge?.dataset.label === text && badge.title === title) return true;
    if (!badge) {
      badge = document.createElement('span');
      badge.className = BADGE_CLASS;
      const anchor = thread.element.querySelector(NAME_SELECTORS.join(',')) ?? thread.link;
      anchor.append(badge);
    }
    badge.dataset.label = text;
    badge.title = title;
    badge.style.background = color;
    return true;
  }

  // Snippets the list shows for picture/media messages.
  const isMediaSnippet = (text) =>
    !text.trim() || (text.length < 40 && /\b(photo|picture|image|video|gif|sticker|attachment|mms)s?\b/i.test(text));

  const MESSAGES_SELECTOR = 'mws-messages-list, mws-message-list, [data-e2e-message-list]';

  // Downscaled JPEG data URL of an image, or null if the canvas is tainted.
  async function imageDataUrl(img, max = 768) {
    if (!img.complete) await new Promise((r) => img.addEventListener('load', r, { once: true }));
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    try {
      return canvas.toDataURL('image/jpeg', 0.8);
    } catch {
      return null;
    }
  }

  // Opens a thread, reads its latest message texts and pictures, then goes
  // back to whatever conversation was open before. Pictures come back as
  // data URLs where the page allows it, otherwise as plain URLs.
  async function readThread(id, { maxImages = 2, maxTexts = 10 } = {}) {
    const previous = location.pathname;
    const thread = findThread(id);
    if (!thread) throw new Error(`Thread ${id} not in list`);
    // Another conversation's messages can still be showing after the URL
    // changes; the list only counts once it differs from what was there.
    const stale = document.querySelector(MESSAGES_SELECTOR);
    const staleText = stale?.innerText ?? null;
    try {
      realClick(thread.link);
      if (!(await waitFor(() => isOpen(id), 5000))) throw new Error(`Could not open thread ${id}`);
      const list = await waitFor(() => {
        const l = document.querySelector(MESSAGES_SELECTOR);
        return l && (l !== stale || l.innerText !== staleText) ? l : null;
      }, 8000);
      if (!list) throw new Error('Message list not found');
      // Messages render after the list, and pictures after that (a spinner
      // sits in the image part while it loads); a cold open takes seconds.
      await waitFor(() => list.querySelector('mws-message-wrapper, mws-text-message-part'), 8000);
      await waitFor(
        () =>
          !list.querySelector('mws-image-message-part mws-spinner') &&
          [...list.querySelectorAll('[data-e2e-message-image] img')].every((i) => i.complete && i.naturalWidth > 0),
        8000,
      );
      await sleep(500);
      // Real page (2026-10): each message is an mws-message-wrapper; its text
      // is mws-text-message-part (nested [data-e2e-text-message-content]
      // repeats it, so read only the part), pictures are [data-e2e-message-image] img with same-origin blob:
      // URLs. Banners like "Texting with ..." are tombstone wrappers.
      // Repeated sends are signal, so only the fallback (whose combined
      // selector matches nested copies of one message) is deduplicated.
      const wrappers = [...list.querySelectorAll('mws-message-wrapper')];
      const textOfAll = (els) => els.map((el) => el.innerText.trim()).filter(Boolean);
      const texts = (
        wrappers.length
          ? textOfAll(wrappers.flatMap((w) => [...w.querySelectorAll('mws-text-message-part')]))
          : [...new Set(textOfAll([...list.querySelectorAll('mws-text-message-part, [data-e2e-text-message-content]')]))]
      ).slice(-maxTexts);
      const messageImgs = [...list.querySelectorAll('[data-e2e-message-image] img')];
      const imgs = (messageImgs.length ? messageImgs : [...list.querySelectorAll('img')])
        .filter((img) => !img.closest('mws-avatar, [class*="avatar"]') && Math.max(img.naturalWidth, img.width) >= 100)
        .slice(-maxImages);
      const images = [];
      for (const img of imgs) images.push((await imageDataUrl(img)) ?? img.currentSrc ?? img.src);
      return { texts, images };
    } finally {
      if (location.pathname !== previous) {
        const back = threadId(previous) && findThread(threadId(previous));
        if (back) realClick(back.link);
        else history.back();
        // Don't return mid-navigation: the next open would click into it.
        await waitFor(() => location.pathname === previous, 5000);
      }
    }
  }

  // Read-only report of what the selectors match, for fixing them.
  function diagnose() {
    const threads = listThreads();
    const first = threads[0];
    if (first) hover(first.element);
    return {
      url: location.href,
      listElement: !!document.querySelector('mws-conversations-list'),
      threadCount: threads.length,
      sample: threads.slice(0, 5).map(({ id, name, snippet, timestamp, recent, unread }) => ({ id, name, snippet, timestamp, recent, unread })),
      firstItemButtons: first ? [...first.element.querySelectorAll('button')].map(label) : [],
      firstItemMenuButtonFound: first ? !!listMenuButton(first) : false,
    };
  }

  globalThis.MessagesDom = { ageDays, messageTime, loadAllThreads, listThreads, readThread, isMediaSnippet, deleteThread, archiveThread, blockThread, markThread, diagnose, waitFor, sleep };
})();
