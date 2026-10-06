// Driver for the messages.google.com web UI. Pure DOM: no chrome.* APIs, so it
// can be reused from an Electron preload or any other injected context.
//
// Google Messages has no public selectors; these are best guesses with
// fallbacks. diagnose() reports what matched so they can be fixed quickly.
(() => {
  const CONVERSATION_LINK = 'a[href*="/web/conversations/"]';
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
        textOf(item, ['[data-e2e-conversation-name]', '.name', 'h2', 'h3']) ||
        (a.innerText.split('\n')[0] ?? '').trim();
      const snippet = textOf(item, ['mws-conversation-snippet', '[data-e2e-conversation-snippet]', '.snippet-text']);
      threads.push({
        id,
        name,
        snippet,
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
    const inHeader = buttons.find((b) => b.closest('mws-conversation-header, mws-header, header'));
    return inHeader ?? buttons.find((b) => /conversation|options/i.test(label(b))) ?? null;
  }

  async function confirmDelete(id) {
    const item = await waitFor(() => findMenuItem(/^delete$/i), 3000);
    if (!item) return false;
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
    await waitFor(() => location.pathname.includes(id), 5000);
    const headerBtn = await waitFor(headerMenuButton, 5000);
    if (!headerBtn) throw new Error('Conversation menu button not found');
    realClick(headerBtn);
    if (await confirmDelete(id)) return 'header-menu';
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
      sample: threads.slice(0, 5).map(({ id, name, snippet, unread }) => ({ id, name, snippet, unread })),
      firstItemButtons: first ? [...first.element.querySelectorAll('button')].map(label) : [],
      firstItemMenuButtonFound: first ? !!listMenuButton(first) : false,
      headerMenuButton: headerMenuButton() ? label(headerMenuButton()) : null,
    };
  }

  globalThis.MessagesDom = { listThreads, deleteThread, diagnose, waitFor, sleep };
})();
