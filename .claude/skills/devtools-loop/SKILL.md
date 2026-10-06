---
name: devtools-loop
description: Inspect and test this extension in Joe's own Windows Chrome over DevTools from WSL, on the real messages.google.com page — read the page structure, read the extension's scan results and log, and confirm a code change took effect. Use whenever a selector, the delete path, or any behavior needs checking against the real Messages page instead of the mock, or when asked to "check it in Chrome", "look at the real page", or "test it yourself".
---

# Real-page loop for the Messages spam filter

Joe's normal Chrome (Windows, his everyday profile, Messages already paired)
is the test bed. Nothing else: no headless browser, no second profile, no new
Messages pairing, nothing that involves his phone.

## Safety rules

- **Dry run stays on.** Never turn it off, and never click "Move to trash",
  "Block & report spam", Archive or Mute on a real thread, without Joe
  saying so for that specific action.
- **Read-only by default.** Snippets read the DOM or extension storage. The
  one interaction allowed without asking is opening a thread's ⋮ menu to
  read its items and closing it with Escape
  (`snippets/thread-menu-items.js`).
- **Don't drive Joe's Messages tab.** Never navigate it or click threads in
  it. Only the extension's own reload reloads it.
- **Only touch tabs you opened.** `msf panel` opens the extension's panel in
  a background tab and closes it. Leave every other tab alone.
- Stop the daemon (`msf stop`) at the end of a session.
- **Never** turn on remote debugging, click Allow, or change Chrome settings
  yourself. Those are Joe's clicks.
- Message text comes back in results. Keep it in the conversation; don't
  write it into the repo.

## One-time setup (Joe)

1. Load the extension unpacked (chrome://extensions → Load unpacked) from
   `C:\Users\jlape\Downloads\messages-spam-filter` (`./sync.sh` fills it).
2. Turn on `chrome://inspect/#remote-debugging` → "Allow remote debugging for
   this browser instance". Chrome 154 offers this for the everyday profile
   with no restart. It stays on until he turns it off.

## Each session

```bash
tools/devtools/msf start   # Joe clicks "Allow" in Chrome once
tools/devtools/msf status
```

`msf start` runs `daemon.mjs` under Windows node. The daemon holds a single
DevTools connection, so Joe approves once per session. That connection can
run code in every tab of his browser, so the daemon takes commands only
over the `\\.\pipe\msf-devtools` named pipe, which web pages can't
reach. Every request must carry the token in `%LOCALAPPDATA%\Temp\msf\token.txt`,
and raw DevTools calls are limited to opening and closing tabs. Never give
it a TCP port: the first version listened on `127.0.0.1:9339` without auth,
so any web page on the laptop could have driven his Chrome. Run
`msf stop` when you're done. Chrome asks for
approval on **every new connection**: a fresh connection per command means
one prompt per command, and every unanswered prompt hangs that command.
Tell Joe a prompt is coming before running `msf start`.

## The loop

1. Edit the code, then run `./sync.sh`.
2. Wait about 3 seconds. The extension notices its files changed
   (`dev-reload.js`), reloads itself, then reloads the Messages tab.
   Confirm with
   `msf eval messages.google.com/web/conversations tools/devtools/snippets/page-loaded-at.js`:
   the load time should be after the sync. Verified working on 2026-10-06.
3. Read results:
   - `msf panel tools/devtools/snippets/last-scan.js`: each thread's
     verdict, score, outcome, reason, and the recent log.
   - `msf panel tools/devtools/snippets/extension-state.js`: install type
     and whether the loaded files contain the new code.
   - `msf eval messages.google.com/web/conversations tools/devtools/snippets/page-structure.js`:
     trimmed HTML of a real thread row, for selector work.
4. Commit when it's right.

`msf eval` runs in the page's main world, which can't see the content
script (isolated world) or extension storage. Use `msf panel` for anything
from the extension. Snippets must be a single expression; wrap async work in
`(async () => { ... })()` and return a string or JSON.

## Real page facts (2026-10-06, Chrome 154)

| What | Selector / text |
|---|---|
| Thread row | `mws-conversation-list-item > a.list-item[data-e2e-conversation]` with `data-e2e-is-unread` |
| Thread id | path `/web/conversations/<id>`; ids look like `CgiiiEJNvISUsBICNjM` |
| Name | `span[data-e2e-conversation-name]` |
| Preview | `[data-e2e-conversation-snippet]`, `mws-conversation-snippet`; absent for some reactions and pictures |
| Timestamp | `mws-relative-timestamp > div[aria-label]`, e.g. "34 min", "9:37 AM", "Saturday", "Sep 29" |
| ⋮ menu | `button[data-e2e-conversation-list-item-menu]`, aria-label "Options for <name>" |
| Menu items | Archive, Block & report spam, **Move to trash** (`data-e2e-conversation-delete`), Mute |
| Move to trash | no confirmation dialog; the row is gone in under a second |
| Open conversation | `mws-messages-list` (no `[role=main]`) |
| Message | `mws-message-wrapper[msg-id]`; banners such as "Texting with …" are `mws-tombstone-message-wrapper` |
| Message text | `mws-text-message-part` (nested `[data-e2e-text-message-content]` repeats it) |
| Picture | `[data-e2e-message-image] img`, a same-origin `blob:` URL, so a canvas can read it |

Pitfalls already hit:
- The Google Account button's link contains
  `messages.google.com/web/conversations/<id>` in its query string. Match
  links by same origin plus path, never by `href*=`.
- "Start chat" is `/web/conversations/new`.
- Verified on the real page 2026-10-06: `deleteThread` through the list
  menu (a real spam thread was moved to trash with Joe's okay), and
  `readThread` on a picture thread (full text plus one picture; scored 98%
  spam; view restored). Not yet seen: the header-menu delete fallback.
- To test driver code without reloading anything, prepend `messages-dom.js`
  to a snippet and `msf eval` it in the page. It runs in the main world,
  separate from the content script's copy.

## WSL gotchas

- Windows binaries fail with "Invalid argument" when `WSL_INTEROP` is unset
  (shells started by herdr or tmux). `msf` finds a working
  `/run/WSL/*_interop` socket itself.
- WSL runs in NAT mode, so Chrome's port 9222 on Windows' localhost can't be
  reached from WSL. Everything that talks to Chrome runs under Windows
  `node.exe` (Node 24 has `WebSocket` built in); `msf` copies the scripts to
  `%LOCALAPPDATA%\Temp\msf`.
- The Bash tool sandbox blocks Windows interop; run `msf` with the sandbox
  disabled.
- Don't `pkill -f <pattern>` when the pattern is in your own command line;
  it kills the shell running it. `msf stop` matches by command line on
  Windows.
- Other `node.exe` processes on Windows belong to OpenClaw and Codex. Leave
  them alone.
