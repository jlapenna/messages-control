// Standalone runner only: reports each new message in the conversation list
// as an event, and answers the API's thread queries and sends. Every thread
// counts, saved contacts included, unlike the classify → act flow in
// content.js.
//
// A new message shows up as a change of a thread's preview at the top of the
// list. The previews last seen are kept in storage, so a message that arrived
// while the watcher was down is reported when it comes back. Two identical
// texts in a row leave the preview unchanged and count once.
(() => {
  const { listThreads, loadAllThreads, readMessages, sendText, sendToNumber, waitFor } = globalThis.MessagesDom;
  // Only this far down the list: new messages arrive at the top, and the
  // full-list sweep must not turn the history into events.
  const TOP = 50;
  const LIMIT = 5000;
  const KEY = 'messageSnapshot';
  let checking = null;
  let again = false;

  // The list previews a conversation's banner, not a message, while it has
  // none to show (real page, 2026-10): one just opened with "Start chat", or
  // an incoming MMS still downloading, perhaps in a known conversation too.
  // The message that replaces it is recorded. A text reading exactly like
  // the thread's own banner is skipped too: the list cannot tell them apart.
  const isBanner = (t) => t.snippet === `Texting with ${t.name} (SMS/MMS)`;

  // "You: see you then" is a message the phone sent.
  const parse = (snippet) => {
    const m = /^You:\s*([\s\S]*)$/.exec(snippet);
    return m ? { direction: 'out', text: m[1] } : { direction: 'in', text: snippet };
  };

  async function check() {
    if (checking) {
      again = true;
      return checking;
    }
    checking = (async () => {
      do {
        again = false;
        // Every rendered thread is remembered, so one that moves up into the
        // top without a new message (another above it was archived) is not
        // mistaken for news; only changes in the top are reported.
        const threads = listThreads().filter((t) => t.snippet);
        if (!threads.length) return;
        const top = new Set(threads.slice(0, TOP).map((t) => t.id));
        const { [KEY]: snapshot } = await chrome.storage.local.get(KEY);
        const known = snapshot ?? {};
        const next = { ...known };
        const fresh = [];
        for (const t of threads) {
          next[t.id] = t.snippet;
          // The first look at an inbox is history. Afterwards a thread that is
          // new to the snapshot only counts when its message is from today:
          // older ones are history scrolled into view.
          if (!snapshot || !top.has(t.id) || known[t.id] === t.snippet || (known[t.id] === undefined && !t.recent) || isBanner(t)) continue;
          fresh.push(t);
        }
        // Bounded like content.js's seen list; the oldest entries go first.
        const ids = Object.keys(next);
        if (ids.length > LIMIT) for (const id of ids.slice(0, ids.length - LIMIT)) delete next[id];
        await chrome.storage.local.set({ [KEY]: next });
        // Oldest change first, so event ids follow arrival order.
        for (const t of fresh.reverse()) {
          const { direction, text } = parse(t.snippet);
          await chrome.runtime
            .sendMessage({ type: 'message', event: { threadId: t.id, name: t.name, direction, text, unread: t.unread, listTime: t.timestamp, msgTime: t.msgTime } })
            .catch((err) => console.warn('[messages-control] message event not recorded', err));
        }
      } while (again);
    })().finally(() => {
      checking = null;
    });
    return checking;
  }

  let timer = null;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(check, 500);
  };
  // Only the list matters; timestamps ticking ("34 min" → "35 min") and our
  // own badges change nothing that check() reads, so they are cheap no-ops.
  let watched = null;
  const observer = new MutationObserver(schedule);
  function attach() {
    const list = document.querySelector('mws-conversations-list') ?? document.body;
    if (list === watched && list.isConnected) return;
    observer.disconnect();
    observer.observe(list, { childList: true, subtree: true, characterData: true });
    if (watched) schedule();
    watched = list;
  }
  attach();
  setInterval(attach, 5000);
  setInterval(check, 30000); // backstop
  schedule();

  // Threads in list order, without the page elements.
  const threadRows = ({ q = '', limit = 50 } = {}) => {
    const needle = String(q).toLowerCase();
    return listThreads()
      .filter((t) => !needle || t.name.toLowerCase().includes(needle) || t.snippet.toLowerCase().includes(needle))
      .slice(0, limit)
      .map(({ id, name, snippet, timestamp, msgTime, unread }) => ({ id, name, snippet, timestamp, msgTime, unread }));
  };

  // Reading and sending open a thread; anything else clicking through the
  // list at the same moment would land in the wrong one. So these run one at
  // a time, in arrival order (two sends at once must not type into each
  // other's conversation), and content.js holds off while one runs.
  let queue = Promise.resolve();
  function exclusive(fn) {
    const run = queue.then(async () => {
      // Claim the page first: a scan that starts now waits for this one
      // instead (content.js), and one already running is waited for here.
      globalThis.MessagesControlReading = true;
      try {
        const idle = await waitFor(() => !globalThis.MessagesControlScanning, 60000, 250);
        if (!idle) return { ok: false, error: 'a scan is running; try again shortly' };
        return await fn();
      } catch (err) {
        return { ok: false, error: err.message };
      } finally {
        globalThis.MessagesControlReading = false;
      }
    });
    queue = run;
    return run;
  }

  // A thread by id or unique id prefix, loading the rest of the list if it
  // is not in the part already shown; else an error answer.
  async function lookup(id) {
    const find = () => {
      const hits = listThreads().filter((t) => t.id === id || t.id.startsWith(id));
      if (hits.length > 1 && !hits.some((t) => t.id === id)) return { error: `${id} matches ${hits.length} threads; give more of the id` };
      const thread = hits.find((x) => x.id === id) ?? hits[0];
      return thread ? { thread } : null;
    };
    let found = find();
    if (!found) {
      await loadAllThreads();
      found = find();
    }
    return found ?? { error: `thread ${id} is not in the loaded conversation list` };
  }

  const read = (msg) =>
    exclusive(async () => {
      const { thread, error } = await lookup(msg.id);
      if (error) return { ok: false, error };
      return { ok: true, thread: await readMessages(thread.id, { limit: msg.limit }) };
    });

  // One text to a listed thread (msg.thread) or a phone number (msg.to).
  // Logged like the other actions; the watcher records it as an outgoing
  // message once the list shows it.
  const send = (msg) =>
    exclusive(async () => {
      let sent;
      if (msg.thread) {
        const { thread, error } = await lookup(msg.thread);
        if (error) return { ok: false, error };
        await sendText(thread.id, msg.text);
        sent = { id: thread.id, name: thread.name, started: false };
      } else {
        sent = await sendToNumber(msg.to, msg.text);
      }
      const row = { time: Date.now(), threadId: sent.id, name: sent.name, label: 'sent', outcome: `sent "${msg.text.slice(0, 40)}"`, rule: 'send' };
      await chrome.runtime.sendMessage({ type: 'log', entry: row }).catch((err) => console.warn('[messages-control] send not logged', err));
      return { ok: true, sent: { ...sent, text: msg.text }, row };
    });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'threads') {
      sendResponse({ ok: true, threads: threadRows(msg) });
    } else if (msg.type === 'readMessages') {
      read(msg).then(sendResponse);
      return true;
    } else if (msg.type === 'sendMessage') {
      send(msg).then(sendResponse);
      return true;
    }
  });
})();
