# messages-control console — design deliverable

`messages-console.html` is a **design prototype** of the proposed control console for
messages-control: live triage feed, decision log, settings, runner status, and the Chrome
extension side panel. It is not the product. The real surfaces stay in `panel.html` /
`options.html` and the headless runner under `src/`; porting this design into them is separate
work.

Open `messages-console.html` in a browser (works from `file://`). It makes no network requests:
no CDN, no external fonts, styles and scripts are local under `assets/`. All messages, decisions
and sweep results are mock data.

## Files

- `messages-console.html` — entry page
- `assets/console.css` — styles (system font stacks only)
- `assets/console.js` — views, demo states, simulated actions, `j`/`k` thread navigation
- `assets/mock-data.js` — mock threads and the **real** defaults copied from `settings.js`
  (including the full classifier system prompt)

## What is real vs mock

Real (copied from the repo): config keys and defaults from `settings.js` (`spamAction`,
`model`, `threshold: 0.8`, `topN: 20`, …); the classifier system prompt; the archive policy from
`policy.js` (codes archive after 6 h, notices after 24 h, archiving keeps history); dry-run
semantics (nothing blocks/reports/trashes — those show as dashed "would" actions while keep and
archive still apply); the first-sweep "marked existing threads as seen" behavior; the extension
keeps working from Chrome while the headless runner is offline.

Mock: every message, sender, score, timestamp and sweep result. Thread actions, sweeps and
"Save config" are simulated and show a toast. p(spam) values are illustrative.

## Prototype states

The dashed **Demo** button in the header switches reviewing aids that are not part of the
product: normal, empty, loading, error, and runner-offline. In runner-offline, sweeps, actions
and mode changes disable and the feed serves cached threads. Switching dry → live always asks
for confirmation first.

## Layouts to review

- Desktop ≥1024px: two columns — feed on the left; on the right the selected thread's preview,
  model flags and reason, raw JSON verdict, and Keep / Archive / Block & report / Trash actions.
- Phones (360×800, 390×844, 390×640 verified): single column, bottom dock with the dry/live
  toggle and the last action. All touch targets are ≥44px.
- The **Panel** tab replicates the Chrome side panel at 360px next to a plain placeholder for
  Google Messages for web (not reproduced here).
