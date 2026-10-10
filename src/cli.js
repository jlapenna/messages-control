import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CONFIG_FILE, STATE_DIR, loadSettings, readConfig, writeConfig } from './config.js';
import { Store } from './store.js';
import { Backend } from './backend.js';
import { launchBrowser } from './browser.js';
import { LIST, MESSAGES_URL, pair, pairingState, waitForPairing, waitForState } from './pair.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The extension's page-side code, unchanged, behind a chrome.* shim.
const PAGE_SCRIPTS = ['src/page-shim.js', 'messages-dom.js', 'content.js'].map((f) =>
  fs.readFileSync(path.join(root, f), 'utf8'),
);

// Exit codes a service manager can tell apart.
const EXIT_ERROR = 1;
const EXIT_UNPAIRED = 2; // needs a person: `pair --headed`
const EXIT_LLM = 3; // the endpoint kept failing

const USAGE = `usage: messages-control [command] [options]

Commands (default: run)
  run              watch Messages and act on new threads as they arrive
  pair             pair this browser profile with the phone, then exit
                   (--headed: sign in with the Google account in the window)
  scan             one scan now; --include-seen treats the top threads as new
  sweep            "Process all messages": load the whole list, label every
                   thread, archive old codes and notices (full mode), act on
                   spam and marketing unless dry run
  act-on-spam      "Act on existing spam": block/trash threads already
                   labelled spam (needs --live)
  check-pictures   open every pending picture thread and classify it
  diagnose         print what the page driver can see
  log [--limit N]  print the activity log (newest first)
  clear-log        empty the activity log
  status           pairing, last scan, actions in the last 24 h, service state
  init             write the config file (endpoint, model, key, mode)
  test-classifier  send sample texts to the LLM and print the verdicts
  install-service  write a systemd user unit; --enable starts it now
  uninstall-service

Options
  --headed         show the browser window
  --live           act on spam and marketing; the default is a dry run
  --mode MODE      spam (default: new threads only) or full (labels the
                   history, archives old codes and notices)
  --state-dir DIR  browser profile and state (default ${STATE_DIR})
  --endpoint URL, --model NAME, --api-key KEY   for init (else it asks)

Config: ${CONFIG_FILE} (keys as in settings.js; the API key lives there,
owner-only) or MESSAGES_CONTROL_API_KEY in the environment.
"notifyCommand" in the config runs on every action and failure with
MC_EVENT and MC_MESSAGE in its environment.
Exit codes: ${EXIT_UNPAIRED} = not paired (run pair --headed), ${EXIT_LLM} = LLM endpoint failing.
To unpair, delete the profile directory under the state dir.`;

const COMMANDS = new Set([
  'run', 'pair', 'scan', 'sweep', 'act-on-spam', 'check-pictures', 'diagnose', 'log', 'clear-log',
  'status', 'init', 'test-classifier', 'install-service', 'uninstall-service',
]);

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    headed: { type: 'boolean', default: false },
    live: { type: 'boolean', default: false },
    'include-seen': { type: 'boolean', default: false },
    enable: { type: 'boolean', default: false },
    mode: { type: 'string' },
    'state-dir': { type: 'string', default: STATE_DIR },
    limit: { type: 'string', default: '50' },
    endpoint: { type: 'string' },
    model: { type: 'string' },
    'api-key': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
const command = positionals[0] ?? 'run';
const stateDir = flags['state-dir'];
const PID_FILE = path.join(stateDir, 'run.pid');

const stamp = (t = Date.now()) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
function formatEntry(entry) {
  const parts = [entry.label, entry.name, entry.outcome, entry.reason].filter(Boolean);
  return `${stamp(entry.time)} ${parts.join(' · ')}`;
}

// "notifyCommand" from the config, fire and forget, with the event in the
// environment: a hook for Telegram, mail, anything.
function notify(settings, event, message) {
  if (!settings.notifyCommand) return;
  const child = spawn('sh', ['-c', settings.notifyCommand], {
    env: { ...process.env, MC_EVENT: event, MC_MESSAGE: message },
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', (err) => console.warn('notifyCommand failed:', err.message));
  child.unref();
}

const ACTED = /^(deleted|blocked & reported|archived)/;

function loadSettingsFromFlags() {
  const overrides = {};
  if (flags.live) overrides.dryRun = false;
  if (flags.mode) overrides.mode = flags.mode;
  return loadSettings(overrides);
}

async function init() {
  const current = { ...readConfig() };
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (label, key, fallback) => {
    const flag = flags[key === 'apiKey' ? 'api-key' : key];
    if (flag) return flag;
    const def = current[key] ?? fallback;
    const answer = (await rl.question(`${label} [${key === 'apiKey' && def ? '•••' : def}]: `)).trim();
    return answer || def;
  };
  try {
    current.endpoint = await ask('Chat completions endpoint', 'endpoint', 'https://api.openai.com/v1/chat/completions');
    current.model = await ask('Model', 'model', 'gpt-4o-mini');
    current.apiKey = await ask('API key', 'apiKey', '');
    current.mode = await ask('Mode (spam or full)', 'mode', 'spam');
    current.spamAction = await ask('Spam action (block = block & report, trash)', 'spamAction', 'block');
  } finally {
    rl.close();
  }
  writeConfig(current);
  console.log(`Wrote ${CONFIG_FILE}. Testing the classifier…`);
  await testClassifier(loadSettings());
  console.log('Next: messages-control pair --headed, then messages-control run (dry run until --live).');
}

async function testClassifier(settings) {
  const backend = new Backend({ store: null, settings });
  const samples = [
    { name: '+1 (555) 010-0199', text: 'USPS: your package is held at the depot, confirm your address at http://usps-redeliver.example to receive it.' },
    { name: '22822', text: 'Old Navy: 40% off everything this weekend! Shop now: http://oldnavy.example/sale Reply STOP to opt out' },
  ];
  for (const thread of samples) {
    const v = await backend.classify(thread);
    console.log(`${v.spam ? 'spam' : v.marketing ? 'marketing' : 'ok'} (${Math.round(v.score * 100)}%) · ${v.reason}`);
  }
}

function serviceUnitPath() {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'systemd', 'user', 'messages-control.service');
}

function installService() {
  const args = ['run'];
  if (flags.live) args.push('--live');
  if (flags.mode) args.push('--mode', flags.mode);
  if (stateDir !== STATE_DIR) args.push('--state-dir', stateDir);
  const unit = `[Unit]
Description=Messages Control (spam filter for Google Messages)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${process.execPath} ${path.join(root, 'bin', 'messages-control.js')} ${args.join(' ')}
EnvironmentFile=-${path.dirname(CONFIG_FILE)}/env
Restart=on-failure
RestartSec=30
# Not paired: a person has to run \`messages-control pair --headed\`; don't spin.
RestartPreventExitStatus=${EXIT_UNPAIRED}

[Install]
WantedBy=default.target
`;
  const file = serviceUnitPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, unit);
  console.log(`Wrote ${file}`);
  if (flags.enable) {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'enable', '--now', 'messages-control'], { stdio: 'inherit' });
    console.log('Started. Logs: journalctl --user -fu messages-control');
  } else {
    console.log('Start it: systemctl --user daemon-reload && systemctl --user enable --now messages-control');
  }
  console.log('To keep it running while logged out: loginctl enable-linger');
}

function uninstallService() {
  const file = serviceUnitPath();
  try {
    execFileSync('systemctl', ['--user', 'disable', '--now', 'messages-control'], { stdio: 'ignore' });
  } catch {}
  if (fs.existsSync(file)) fs.unlinkSync(file);
  console.log(`Removed ${file}`);
}

function runningPid() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function printLog(store, limit) {
  const { log = [] } = store.get('log');
  for (const entry of log.slice(0, limit)) console.log(formatEntry(entry));
  if (!log.length) console.log('(log is empty)');
}

async function status(settings, store) {
  const { lastScan, log = [], baselined = false } = store.get(['lastScan', 'log', 'baselined']);
  const day = Date.now() - 86400000;
  const recent = log.filter((e) => e.time >= day);
  const count = (re) => recent.filter((e) => re.test(e.outcome ?? '')).length;
  const pid = runningPid();
  console.log(`config:    ${CONFIG_FILE} (mode ${settings.mode}, ${settings.dryRun ? 'dry run' : 'live'}, spam → ${settings.spamAction}, model ${settings.model})`);
  console.log(`state:     ${stateDir}`);
  console.log(`running:   ${pid ? `yes (pid ${pid})` : 'no'}`);
  let service = 'not installed';
  if (fs.existsSync(serviceUnitPath())) {
    try {
      service = execFileSync('systemctl', ['--user', 'is-active', 'messages-control'], { encoding: 'utf8' }).trim();
    } catch (err) {
      service = String(err.stdout ?? '').trim() || 'unknown';
    }
  }
  console.log(`service:   ${service}`);
  console.log(`baseline:  ${baselined ? 'done (existing threads marked as not new)' : 'not yet (the first run does it)'}`);
  console.log(`last scan: ${lastScan ? `${stamp(lastScan.time)} — ${lastScan.summary}` : 'never'}`);
  console.log(
    `last 24 h: ${count(/^blocked/)} blocked, ${count(/^deleted/)} deleted, ${count(/^archived/)} archived, ` +
      `${count(/not deleted: dry run/)} would-be actions (dry run), ${recent.filter((e) => e.label === 'error').length} errors`,
  );
  if (!fs.existsSync(path.join(stateDir, 'profile'))) {
    console.log('pairing:   no browser profile yet — run: messages-control pair --headed');
    return;
  }
  if (pid) {
    console.log('pairing:   profile in use by the running watcher (it exits with code 2 if unpaired)');
    return;
  }
  const { context, page } = await launchBrowser({ profileDir: path.join(stateDir, 'profile'), headed: false });
  try {
    await page.goto(MESSAGES_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const state = await waitForState(page, 30000).catch(() => 'unknown');
    console.log(`pairing:   ${state === 'paired' ? 'paired' : state === 'unpaired' ? 'NOT paired — run: messages-control pair --headed' : 'could not tell'}`);
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  if (flags.help || !COMMANDS.has(command)) {
    console.log(USAGE);
    process.exit(flags.help ? 0 : 2);
  }
  if (command === 'init') return init();
  if (command === 'install-service') return installService();
  if (command === 'uninstall-service') return uninstallService();

  const settings = loadSettingsFromFlags();
  if (command === 'test-classifier') return testClassifier(settings);

  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const store = new Store(path.join(stateDir, 'state.json'));
  if (command === 'log') return printLog(store, Number(flags.limit) || 50);
  if (command === 'clear-log') {
    store.set({ log: [] });
    store.remove('lastScan');
    store.flush();
    return console.log('Log cleared.');
  }
  if (command === 'status') return status(settings, store);

  const running = runningPid();
  if (running) {
    // One browser per profile: a second one corrupts the profile.
    console.error(`The watcher is already running (pid ${running}); stop it first.`);
    process.exit(EXIT_ERROR);
  }

  const { context, page } = await launchBrowser({ profileDir: path.join(stateDir, 'profile'), headed: flags.headed });
  let exiting = false;
  const shutdown = async (code = 0) => {
    if (exiting) return;
    exiting = true;
    store.flush();
    if (command === 'run') fs.rmSync(PID_FILE, { force: true });
    await context.close().catch(() => {});
    process.exit(code);
  };
  const fatal = (event, message, code) => {
    console.error(message);
    notify(settings, event, message);
    return shutdown(code);
  };
  process.on('SIGINT', () => shutdown());
  process.on('SIGTERM', () => shutdown());

  const backend = new Backend({
    store,
    settings,
    context,
    page,
    onLog: (entry) => {
      console.log(formatEntry(entry));
      if (ACTED.test(entry.outcome ?? '')) notify(settings, 'action', formatEntry(entry));
    },
    onFatal: (message) => fatal('llm-failing', message, EXIT_LLM),
  });
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
      .waitFor({ timeout: 60000 })
      .catch(() => {});
    for (const src of PAGE_SCRIPTS) await page.evaluate(src);
    await dismissPrompts();
  }
  // Rows can still be filling in after a cold start; a one-off command run
  // on an empty list would just report "no conversations".
  async function waitForRows(timeout = 60000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await page.evaluate(() => globalThis.MessagesDom.listThreads().length).catch(() => 0)) return true;
      await page.waitForTimeout(1000);
    }
    return false;
  }
  // Messages asks about notifications and the like after pairing; those
  // dialogs sit over the list.
  async function dismissPrompts() {
    const btn = page.getByRole('button', { name: /^(no thanks|not now|skip|got it|dismiss)$/i }).first();
    if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
  }
  async function ensurePaired() {
    if ((await waitForState(page)) === 'paired') return;
    if (!flags.headed && command !== 'pair') {
      await fatal('unpaired', 'Not paired with the phone. Run: messages-control pair --headed', EXIT_UNPAIRED);
      return;
    }
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
  const oneOff = {
    diagnose: { type: 'diagnose' },
    scan: { type: 'scanNow', includeSeen: flags['include-seen'] },
    sweep: { type: 'scanNow', processAll: true },
    'act-on-spam': { type: 'scanNow', trashSpam: true },
    'check-pictures': { type: 'scanNow', checkPictures: true },
  };
  if (oneOff[command]) {
    if (!(await waitForRows())) console.warn('No conversation rows appeared; the inbox may be empty.');
    const res = await deliver(oneOff[command]);
    if (command === 'diagnose') console.log(JSON.stringify(res?.report ?? res, null, 2));
    else console.log(res?.summary ?? res);
    return shutdown();
  }

  // run: content.js does the watching. After a reload the page starts over
  // without it, and the phone can unpair us; both are mended here.
  fs.writeFileSync(PID_FILE, String(process.pid));
  console.log(`Watching Messages (mode ${settings.mode}, ${settings.dryRun ? 'dry run' : 'LIVE'}; spam → ${settings.spamAction}, marketing → trash).`);
  let mending = false;
  async function mend() {
    if (mending || exiting) return;
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
  page.on('crash', () => fatal('crash', 'The browser page crashed.', EXIT_ERROR));
  context.on('close', () => fatal('browser-closed', 'The browser closed.', EXIT_ERROR));
  setInterval(mend, 30000);
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exit(EXIT_ERROR);
});
