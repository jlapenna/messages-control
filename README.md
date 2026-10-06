# Messages Spam Filter

Chrome extension that watches messages.google.com/web. Each new thread is sent
to `llm.jlapenna.net` (LiteLLM, model `default`) for classification, and the
ones judged spam are deleted.

## Install

1. `./sync.sh` copies the extension to `C:\Users\jlape\Downloads\messages-spam-filter`.
2. chrome://extensions → Developer mode → Load unpacked → pick that folder.
3. Extension → Settings → paste a LiteLLM key (`secrets-get LITELLM_API_KEY`) → Save → Test classifier.
4. Open messages.google.com/web. The first scan marks existing threads as seen;
   only threads that arrive after that are classified.

It starts in **dry run**: spam is logged as `would-delete` in the popup, not
deleted. Untick dry run once the log looks right.

## Layout

- `messages-dom.js`: Google Messages DOM driver (list, delete, diagnose). No
  `chrome.*` APIs, so it can move into an Electron preload as-is.
- `content.js`: new-thread detection and the classify → delete policy.
- `background.js`: LLM call and the activity log.
- `popup.*`, `options.*`, `settings.js`: UI and settings.

## When Google changes the UI

Selectors in `messages-dom.js` are guesses with fallbacks. Popup → Diagnose page
shows what matched: the thread count, sample names and snippets, and whether the
per-thread menu button was found.
