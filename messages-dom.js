// Driver for the messages.google.com web UI. Pure DOM: no chrome.* APIs, so it
// can be reused from an Electron preload or any other injected context.
//
// Google Messages has no public selectors; these are best guesses with
// fallbacks. diagnose() reports what matched so they can be fixed quickly.
(() => {
  const CONVERSATION_LINK = 'a[href*="/web/conversations/"]';
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

  // The "⋮" button in the open conversation's header.
  function headerMenuButton() {
    const list = document.querySelector('mws-conversations-list');
    const buttons = [...document.querySelectorAll('button')].filter(
      (b) => visible(b) && !(list && list.contains(b)) && MENU_BUTTON_RE.test(label(b)),
    );
    return buttons.find((b) => b.closest('mws-conversation-header, mws-header, header')) ?? null;
  }

  const isOpen = (id) => threadId(location.pathname) === id;

  // The real menu says "Move to trash" (data-e2e-conversation-delete); older
  // or other builds may say "Delete".
  const DELETE_RE = /^(delete|move to trash)$/i;
  const findDeleteItem = () =>
    [...document.querySelectorAll('[data-e2e-conversation-delete]')].find(visible) ?? findMenuItem(DELETE_RE);

  async function confirmDelete(id, requireOpen) {
    const item = await waitFor(findDeleteItem, 3000);
    if (!item) return false;
    // Re-check right before the click: never delete whatever conversation
    // happens to be open instead of the target.
    if (requireOpen && !isOpen(id)) throw new Error(`Thread ${id} is no longer the open conversation`);
    realClick(item);
    // Some builds confirm in a dialog; moving to trash may not. Either the
    // thread leaves the list, or a confirm button shows up first.
    const next = await waitFor(() => (!findThread(id) ? 'gone' : findDialogButton(DELETE_RE)), 5000);
    if (next && next !== 'gone') realClick(next);
    if (!(await waitFor(() => !findThread(id), 8000))) {
      throw new Error('Thread still listed after moving it to trash');
    }
    return true;
  }


  function closeMenus() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  // Deletes a thread: via the list item's menu, else by opening it and using
  // the conversation header menu. Returns the method used.
  async function deleteThread(id) {
    let thread = findThread(id);
    if (!thread) throw new Error(`Thread ${id} not in list`);

    hover(thread.element);
    const listBtn = await waitFor(() => listMenuButton(findThread(id) ?? thread), 1500);
    if (listBtn) {
      realClick(listBtn);
      if (await confirmDelete(id)) return 'list-menu';
      closeMenus();
    }

    thread = findThread(id);
    if (!thread) throw new Error(`Thread ${id} vanished`);
    realClick(thread.link);
    if (!(await waitFor(() => isOpen(id), 5000))) {
      throw new Error(`Could not open thread ${id}; not deleting`);
    }
    const headerBtn = await waitFor(headerMenuButton, 5000);
    if (!headerBtn) throw new Error('Conversation menu button not found');
    realClick(headerBtn);
    if (await confirmDelete(id, true)) return 'header-menu';
    closeMenus();
    throw new Error('"Move to trash" menu item not found');
  }

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
    try {
      realClick(thread.link);
      if (!(await waitFor(() => isOpen(id), 5000))) throw new Error(`Could not open thread ${id}`);
      const list = await waitFor(() => document.querySelector(MESSAGES_SELECTOR), 5000);
      if (!list) throw new Error('Message list not found');
      await sleep(1500); // let pictures load
      // Real page (2026-10): each message is an mws-message-wrapper; its text
      // is mws-text-message-part (nested elements repeat it, so read that one
      // only), pictures are [data-e2e-message-image] img with same-origin blob:
      // URLs. Banners like "Texting with ..." are tombstone wrappers.
      const wrappers = [...list.querySelectorAll('mws-message-wrapper')];
      const parts = wrappers.length
        ? wrappers.flatMap((w) => [...w.querySelectorAll('mws-text-message-part')])
        : [...list.querySelectorAll('mws-text-message-part, [data-e2e-text-message-content]')];
      const texts = [...new Set(parts.map((el) => el.innerText.trim()).filter(Boolean))].slice(-maxTexts);
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
      headerMenuButton: headerMenuButton() ? label(headerMenuButton()) : null,
    };
  }

  globalThis.MessagesDom = { listThreads, readThread, isMediaSnippet, deleteThread, markThread, diagnose, waitFor, sleep };
})();
