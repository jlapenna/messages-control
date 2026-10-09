import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CONFIG_FILE, STATE_DIR, loadSettings } from './config.js';
import { Store } from './store.js';
import { Backend } from './backend.js';
import { launchBrowser } from './browser.js';
import { LIST, MESSAGES_URL, pair, pairingState, waitForPairing, waitForState } from './pair.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The extension's page-side code, unchanged, behind a chrome.* shim.
const PAGE_SCRIPTS = ['src/page-shim.js', 'messages-dom.js', 'content.js'].map((f) =>
  fs.readFileSync(path.join(root, f), 'utf8'),
);

const USAGE = `usage: messages-control [command] [--headed] [--live] [--state-dir DIR]

  run              watch Messages and sort new threads as they arrive (default)
  pair             pair this browser profile with the phone, then exit
  sweep            "Process all messages": label every thread, archive old codes
                   and notices, act on spam (unless dry run), then exit
  diagnose         print what the page driver can see
  test-classifier  send a sample text to the LLM and print the verdict

  --headed         show the browser window; pairing is then done in it (Google sign-in)
  --live           act on spam; the default is a dry run that only logs it
  --state-dir DIR  browser profile and state (default ${STATE_DIR})

Settings come from ${CONFIG_FILE} (keys as in settings.js: apiKey, endpoint,
model, threshold, spamAction, ...); LITELLM_API_KEY in the environment sets apiKey.
To unpair, delete the profile directory under the state dir.`;

const COMMANDS = new Set(['run', 'pair', 'sweep', 'diagnose', 'test-classifier']);

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    headed: { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
    'state-dir': { type: 'string', default: STATE_DIR },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
const command = positionals[0] ?? 'run';

function printLog(entry) {
  const t = new Date().toISOString().slice(11, 19);
  const parts = [entry.label, entry.name, entry.outcome, entry.reason].filter(Boolean);
  console.log(`${t} ${parts.join(' · ')}`);
}

async function testClassifier(settings) {
  const backend = new Backend({ store: null, settings });
  const thread = {
    name: '+1 (555) 010-0199',
    text: 'USPS: your package is held at the depot, confirm your address at http://usps-redeliver.example to receive it.',
  };
  console.log(JSON.stringify(await backend.classify(thread), null, 2));
}

async function main() {
  if (flags.help || !COMMANDS.has(command)) {
    console.log(USAGE);
    process.exit(flags.help ? 0 : 2);
  }
  const settings = loadSettings(flags.live ? { dryRun: false } : {});
  if (command === 'test-classifier') return testClassifier(settings);

  const stateDir = flags['state-dir'];
  fs.mkdirSync(stateDir, { recursive: true });
  const store = new Store(path.join(stateDir, 'state.json'));
  const { context, page } = await launchBrowser({ profileDir: path.join(stateDir, 'profile'), headed: flags.headed });
  const backend = new Backend({ store, settings, context, page, onLog: printLog });
  const shutdown = async (code = 0) => {
    store.flush();
    await context.close().catch(() => {});
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());

  await page.exposeFunction('__mcSend', (msg) => backend.handle(msg));
  await page.exposeFunction('__mcStorage', (op, arg) => store[op](arg) ?? {});

  const deliver = (msg) => page.evaluate((m) => globalThis.__mcDeliver(m), msg);
  const injected = () => page.evaluate(() => !!globalThis.__mcInjected).catch(() => false);
  async function inject() {
    await page.waitForSelector(LIST, { timeout: 60000 });
    // The list element comes before its rows; an empty inbox never gets any.
    // ("Start chat" links to /conversations/new and is there from the start.)
    await page
      .locator('a[href*="/web/conversations/"]:not([href*="/conversations/new"])')
      .first()
      .waitFor({ timeout: 15000 })
      .catch(() => {});
    for (const src of PAGE_SCRIPTS) await page.evaluate(src);
    await dismissPrompts();
  }
  // Messages asks about notifications and the like after pairing; those
  // dialogs sit over the list.
  async function dismissPrompts() {
    const btn = page.getByRole('button', { name: /^(no thanks|not now|skip|got it|dismiss)$/i }).first();
    if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
  }
  async function ensurePaired() {
    if ((await waitForState(page)) === 'paired') return;
    console.log('This browser profile is not paired with the phone.');
    if (flags.headed) await waitForPairing(page);
    else await pair(page, { stateDir });
    console.log('Paired.');
  }

  // Messages sometimes replaces the first navigation on the spot (ERR_ABORTED);
  // waitForState sees where it ended up.
  await page.goto(MESSAGES_URL, { waitUntil: 'domcontentloaded' }).catch((err) => {
    if (!/ERR_ABORTED/.test(err.message)) throw err;
  });
  await ensurePaired();
  if (command === 'pair') return shutdown();

  await inject();
  if (command === 'diagnose') {
    const res = await deliver({ type: 'diagnose' });
    console.log(JSON.stringify(res?.report ?? res, null, 2));
    return shutdown();
  }
  if (command === 'sweep') {
    const res = await deliver({ type: 'scanNow', processAll: true });
    console.log(res?.summary ?? res);
    return shutdown();
  }

  // run: content.js does the watching. After a reload the page starts over
  // without it, and the phone can unpair us; both are mended here.
  console.log(`Watching Messages (${settings.dryRun ? 'dry run' : 'live'}; spam action: ${settings.spamAction}).`);
  let mending = false;
  async function mend() {
    if (mending) return;
    mending = true;
    try {
      const state = await pairingState(page);
      if (state === 'unpaired') {
        await ensurePaired();
        await inject();
      } else if (state === 'paired' && !(await injected())) {
        await inject();
      }
    } catch (err) {
      console.warn('recovery failed:', err.message);
    } finally {
      mending = false;
    }
  }
  page.on('load', mend);
  setInterval(mend, 30000);
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exit(1);
});
