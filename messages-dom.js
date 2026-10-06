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

  function threadId(href) {
    const m = href.match(/\/web\/conversations\/([^/?#]+)/);
    return m && m[1] !== 'new' ? m[1] : null;
  }

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
      const id = threadId(a.getAttribute('href') ?? '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const item = a.closest('mws-conversation-list-item') ?? a;
      const name =
        textOf(item, NAME_SELECTORS) ||
        (a.innerText.split('\n')[0] ?? '').trim();
      const snippet = textOf(item, SNIPPET_SELECTORS);
      const timestamp =
        textOf(item, ['mws-relative-timestamp', '[data-e2e-conversation-timestamp]', '.timestamp']) ||
        fallbackTimestamp(item);
      threads.push({
        id,
        name,
        snippet,
        timestamp,
        recent: RECENT_RE.test(timestamp),
        text: snippet || a.innerText.trim(),
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

  async function confirmDelete(id, requireOpen) {
    const item = await waitFor(() => findMenuItem(/^delete$/i), 3000);
    if (!item) return false;
    // Re-check right before the irreversible click: never delete whatever
    // conversation happens to be open instead of the target.
    if (requireOpen && !isOpen(id)) throw new Error(`Thread ${id} is no longer the open conversation`);
    realClick(item);
    const confirm = await waitFor(() => findDialogButton(/^delete$/i), 3000);
    if (!confirm) throw new Error('Delete confirmation dialog not found');
    realClick(confirm);
    if (!(await waitFor(() => !findThread(id), 8000))) {
      throw new Error('Thread still listed after confirming delete');
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
    throw new Error('"Delete" menu item not found');
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

  globalThis.MessagesDom = { listThreads, deleteThread, diagnose, waitFor, sleep };
})();
