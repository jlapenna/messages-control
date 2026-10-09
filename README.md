# Messages Control

Chrome extension that watches messages.google.com/web. Each new thread is sent
to `llm.jlapenna.net` (LiteLLM, model `default`) for classification, and the
ones judged spam are deleted.

## Install

1. `./sync.sh` copies the extension to `C:\Users\jlape\Downloads\messages-control`.
2. chrome://extensions → Developer mode → Load unpacked → pick that folder.
3. Extension → Settings → paste a LiteLLM key (`secrets-get LITELLM_API_KEY`) → Save → Test classifier.
4. Open messages.google.com/web. The first scan marks existing threads as seen;
   only threads that arrive after that are classified.

Picture messages are opened so the model can see the picture: new threads
immediately (your view returns to where it was), existing ones only while the
Messages tab is in the background. Opening marks a thread read, which sends an
RCS read receipt if those are on; Settings can turn picture opening off.

Automated notice-only texts (order ready, delivered, driver arriving, work
finished) get a grey "Notice" label; event invites such as Partiful don't.
One-time codes are archived after 6 hours and notices after a day (by the
earliest the latest message could have arrived); archiving keeps the
conversation and isn't blocked by dry run, which only forbids trashing.
"Process all messages" in the side panel loads the whole list, labels every
thread, archives old notices and codes, and trashes spam unless dry run is on.

It starts in **dry run**: spam is badged in the thread list and logged as `spam` in the side panel, not
deleted. Untick dry run once the log looks right.

## Layout

- `messages-dom.js`: Google Messages DOM driver (list, delete, diagnose). No
  `chrome.*` APIs, so it can move into an Electron preload as-is.
- `content.js`: new-thread detection and the classify → delete policy.
- `background.js`: LLM call and the activity log.
- `panel.*`, `options.*`, `settings.js`: UI and settings.

## When Google changes the UI

Selectors in `messages-dom.js` are guesses with fallbacks. Side panel → Diagnose page
shows what matched: the thread count, sample names and snippets, and whether the
per-thread menu button was found.

## Testing on the real page

`.claude/skills/devtools-loop` describes the loop an agent uses against the
real Messages page in your own Chrome: `tools/devtools/msf` talks to Chrome
over DevTools once remote debugging is allowed at
`chrome://inspect/#remote-debugging`. Unpacked installs reload themselves a
few seconds after `./sync.sh` (`dev-reload.js`), Messages tabs included.
