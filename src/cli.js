import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parseArgs } from 'node:util';
import { CONFIG_FILE, STATE_DIR, loadSettings, readConfig, writeConfig } from './config.js';
import { Store } from './store.js';
import { Db } from './db.js';
import { notify as sendNotification } from './notify.js';
import { digestText, parseSince } from './digest.js';
import { startApi } from './api.js';
import { randomBytes } from 'node:crypto';
import { Backend } from './backend.js';
import { launchBrowser } from './browser.js';
import { versionText } from './version.js';
import { LIST, MESSAGES_URL, pair, pairingState, resumePairing, waitForPairing, waitForState } from './pair.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The extension's page-side code, unchanged, behind a chrome.* shim.
const PAGE_SCRIPTS = ['src/page-shim.js', 'messages-dom.js', 'policy.js', 'content.js'].map((f) =>
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
  version          print the package version and the git commit
  status           pairing, last scan, actions in the last 24 h, service state
  init             write the config file (endpoint, model, key, mode)
  test-classifier  send sample texts to the LLM and print the verdicts
  install-service  write a systemd user unit; --enable starts it now
  uninstall-service
  digest           summary of the last day (--since 7d; --send sends it)
  review           threads the rules hold for a person (spam-ish, under the
                   threshold, in full mode)
  act ID ACTION    block, trash, archive or keep one thread (ID may be a
                   prefix; block/trash/archive need --live)
  send ID TEXT     send a text in one thread (--live); the path the opt-in
                   STOP reply to marketing uses
  undo EVENT       undo a block or an archive by its event number (from
                   log); a trashed thread has no undo in Messages for web
  policy show      the rules in force (defaults, mode and config applied)
  policy test      replay the cached verdicts through the rules: what each
                   rule would do, without touching anything

Options
  --digest HH:MM   with install-service: also a daily digest timer
  --since 24h      for digest (h, d or m)
  --send           for digest: send it through the notify channels
  --headed         show the browser window
  --live           act on spam and marketing; the default is a dry run
  --mode MODE      spam (default: new threads only) or full (labels the
                   history, archives old codes and notices)
  --state-dir DIR  browser profile and state (default ${STATE_DIR})
  --endpoint URL, --model NAME, --api-key KEY   for init (else it asks)

Config: ${CONFIG_FILE} (keys as in settings.js; the API key lives there,
owner-only) or MESSAGES_CONTROL_API_KEY in the environment.
While running, http://127.0.0.1:7373/ serves /healthz and /metrics
(Prometheus) openly and the dashboard + /api/* behind api.token.
"notify" in the config: { "telegram": { "token", "chatId" }, "command": "...",
"events": [...] } — actions, pairing approvals, failures and digests go there.
Exit codes: ${EXIT_UNPAIRED} = not paired (run pair --headed), ${EXIT_LLM} = LLM endpoint failing.
To unpair, delete the profile directory under the state dir.`;

const COMMANDS = new Set([
  'run', 'pair', 'scan', 'sweep', 'act-on-spam', 'check-pictures', 'diagnose', 'log', 'clear-log',
  'status', 'init', 'test-classifier', 'install-service', 'uninstall-service', 'policy', 'digest', 'review', 'act', 'undo', 'send', 'version',
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
    since: { type: 'string' },
    send: { type: 'boolean', default: false },
    digest: { type: 'string' },
    endpoint: { type: 'string' },
    model: { type: 'string' },
    'api-key': { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
const command = positionals[0] ?? 'run';
// Set once a shutdown is under way: closing the browser makes in-flight
// page calls reject, and those rejections must not override the exit code.
let exiting = false;
const stateDir = flags['state-dir'];
const PID_FILE = path.join(stateDir, 'run.pid');

const stamp = (t = Date.now()) => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
function formatEntry(entry) {
  const parts = [entry.label, entry.name, entry.outcome, entry.reason].filter(Boolean);
  return `${stamp(entry.time)} ${parts.join(' · ')}`;
}

// Notifications never block or fail the thing they report on.
function notify(settings, event, message, opts) {
  sendNotification(settings, event, message, opts).catch((err) => console.warn('notify failed:', err.message));
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
  // The key is typed without echo, so it doesn't end up on screen or in a
  // terminal scrollback.
  let muted = false;
  rl._writeToOutput = (s) => {
    if (!muted) process.stdout.write(s);
  };
  const ask = async (label, key, fallback) => {
    const flag = flags[key === 'apiKey' ? 'api-key' : key];
    if (flag) return flag;
    const def = current[key] ?? fallback;
    const secret = key === 'apiKey';
    process.stdout.write(`${label} [${secret && def ? 'kept' : def}]: `);
    muted = secret;
    const answer = (await rl.question('')).trim();
    muted = false;
    if (secret) process.stdout.write('\n');
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
    { name: '28777', text: 'Your Amazon order #114-2938471 of $42.10 has shipped and will arrive Thursday, Oct 16. Track: 1Z999AA10123456784' },
  ];
  for (const thread of samples) {
    const v = await backend.classify(thread);
    const kind = v.spam ? 'spam' : v.marketing ? 'marketing' : v.transactional ? 'transactional' : 'ok';
    console.log(`${kind} (${Math.round(v.score * 100)}%) · ${v.reason}${v.extract ? ` · ${JSON.stringify(v.extract)}` : ''}`);
  }
}

// policy.js is a plain script (it also runs in the page): load it the way
// the page does and take the global it sets.
function loadPolicy() {
  vm.runInThisContext(fs.readFileSync(path.join(root, 'policy.js'), 'utf8'), { filename: 'policy.js' });
  return globalThis.MessagesPolicy;
}

function policyCommand(settings, store, sub) {
  const policy = loadPolicy();
  const inForce = policy.rules(settings);
  if (sub === 'show') {
    console.log(`mode ${settings.mode}, ${settings.dryRun ? 'dry run' : 'live'}, threshold ${settings.threshold}, spamAction ${settings.spamAction}`);
    for (const r of inForce) console.log(`  ${r.name}: ${JSON.stringify(r.match)} → ${r.action}${r.hours ? ` ${r.hours}h` : ''}`);
    console.log(settings.policies?.length ? '(from "policies" in the config)' : '(defaults; set "policies" in the config to replace them)');
    return;
  }
  if (sub !== 'test') throw new Error(`policy ${sub}? (show or test)`);
  // Replay: every cached verdict, as if its thread had just arrived (isNew)
  // and as it stands (existing), against the live rules, dry run off.
  const { verdicts = {} } = store.get('verdicts');
  const live = { ...settings, dryRun: false };
  const tally = new Map();
  const bump = (k) => tally.set(k, (tally.get(k) ?? 0) + 1);
  for (const v of Object.values(verdicts)) {
    const thread = { msgTime: v.msgTime, recent: false };
    const asNew = policy.decide(v, { isNew: true, settings: live, thread });
    const asOld = policy.decide(v, { isNew: false, settings: live, thread });
    bump(`${v.label.padEnd(9)} new → ${asNew.rule ?? '-'}: ${asNew.outcome.replace(/…$/, '')}`);
    if (asOld.archive || asOld.outcome !== asNew.outcome) bump(`${v.label.padEnd(9)} old → ${asOld.rule ?? '-'}: ${asOld.outcome}`);
  }
  console.log(`${Object.keys(verdicts).length} cached verdicts through ${inForce.length} rules (mode ${settings.mode}):`);
  for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
}

// What the rules hold for a person: cached verdicts whose decision is
// "hold", with the name the events table last saw for the thread.
function review(settings, store, db) {
  const policy = loadPolicy();
  const { verdicts = {} } = store.get('verdicts');
  const names = new Map(db.db.prepare('select thread_id, name from events where name is not null group by thread_id').all().map((r) => [r.thread_id, r.name]));
  const held = Object.entries(verdicts)
    .map(([id, v]) => [id, v, policy.decide(v, { isNew: true, settings: { ...settings, dryRun: false }, thread: { msgTime: v.msgTime, recent: false } })])
    .filter(([, , d]) => d.hold);
  if (!held.length) return console.log(`Nothing held for review (mode ${settings.mode}; the spam-review rule is on in full mode).`);
  for (const [id, v, d] of held.sort((a, b) => (b[1].time ?? 0) - (a[1].time ?? 0))) {
    console.log(`${id}  ${(names.get(id) ?? '?').padEnd(18)} ${v.label} ${Math.round((v.score ?? 0) * 100)}%  ${d.rule}: ${(v.reason ?? '').slice(0, 80)}`);
  }
  console.log(`\n${held.length} held. Decide one: messages-control act <id> block|trash|archive|keep [--live]`);
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
  const units = ['messages-control'];
  if (flags.digest) {
    if (!/^\d{1,2}:\d{2}$/.test(flags.digest)) throw new Error('--digest wants HH:MM');
    const dir = path.dirname(file);
    fs.writeFileSync(path.join(dir, 'messages-control-digest.service'), `[Unit]
Description=Messages Control daily digest

[Service]
Type=oneshot
ExecStart=${process.execPath} ${path.join(root, 'bin', 'messages-control.js')} digest --send${stateDir !== STATE_DIR ? ` --state-dir ${stateDir}` : ''}
`);
    fs.writeFileSync(path.join(dir, 'messages-control-digest.timer'), `[Unit]
Description=Messages Control daily digest at ${flags.digest}

[Timer]
OnCalendar=*-*-* ${flags.digest.padStart(5, '0')}:00
Persistent=true

[Install]
WantedBy=timers.target
`);
    console.log(`Wrote ${path.join(dir, 'messages-control-digest.timer')} (daily at ${flags.digest})`);
    units.push('messages-control-digest.timer');
  }
  if (flags.enable) {
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'enable', '--now', ...units], { stdio: 'inherit' });
    console.log('Started. Logs: journalctl --user -fu messages-control');
  } else {
    console.log(`Start it: systemctl --user daemon-reload && systemctl --user enable --now ${units.join(' ')}`);
  }
  console.log('To keep it running while logged out: loginctl enable-linger (WSL: sudo loginctl enable-linger $USER)');
}

function uninstallService() {
  const file = serviceUnitPath();
  for (const unit of ['messages-control', 'messages-control-digest.timer']) {
    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', unit], { stdio: 'ignore' });
    } catch {}
  }
  for (const f of [file, ...['messages-control-digest.service', 'messages-control-digest.timer'].map((n) => path.join(path.dirname(file), n))]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  console.log(`Removed ${file} (and the digest timer, if any)`);
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

function printLog(db, limit) {
  const rows = db.events({ limit }).map((r) => ({ ...r }));
  for (const entry of rows) console.log(`#${String(entry.id).padEnd(5)} ${formatEntry(entry)}${entry.rule ? ` [${entry.rule}]` : ''}`);
  if (!rows.length) console.log('(log is empty)');
}

async function status(settings, store, db) {
  const { lastScan, baselined = false } = store.get(['lastScan', 'baselined']);
  const c = db.counts(Date.now() - 86400000);
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
  if (settings.api?.port > 0) console.log(`api:       http://${settings.api.bind}:${settings.api.port}/ (healthz, metrics, dashboard; token ${settings.api.token ? 'in the config' : 'is generated on the first run'})`);
  console.log(`baseline:  ${baselined ? 'done (existing threads marked as not new)' : 'not yet (the first run does it)'}`);
  console.log(`last scan: ${lastScan ? `${stamp(lastScan.time)} — ${lastScan.summary}` : 'never'}`);
  console.log(
    `last 24 h: ${c.blocked} blocked, ${c.deleted} deleted, ${c.archived} archived, ` +
      `${c.dryRun} would-be actions (dry run), ${c.errors} errors, ${c.total} log entries`,
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
  if (flags.help || !COMMANDS.has(command) || (command === 'act' && !(positionals[1] && /^(block|trash|archive|keep)$/.test(positionals[2] ?? ''))) || (command === 'undo' && !/^#?\d+$/.test(positionals[1] ?? '')) || (command === 'send' && !(positionals[1] && positionals[2]))) {
    console.log(USAGE);
    process.exit(flags.help ? 0 : 2);
  }
  if (command === 'version') return console.log(versionText(root));
  if (command === 'init') return init();
  if (command === 'install-service') return installService();
  if (command === 'uninstall-service') return uninstallService();

  const settings = loadSettingsFromFlags();
  if (command === 'test-classifier') return testClassifier(settings);

  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const store = new Store(path.join(stateDir, 'state.json'));
  const db = new Db(path.join(stateDir, 'state.db'));
  // First run with a database: carry over the page's recent log.
  if (db.counts(0).total === 0) for (const e of [...(store.get('log').log ?? [])].reverse()) db.recordEvent(e);
  if (command === 'log') return printLog(db, Number(flags.limit) || 50);
  if (command === 'clear-log') {
    // Clears the page's recent log and the last scan; the events table is
    // the audit trail and stays.
    store.set({ log: [] });
    store.remove('lastScan');
    store.flush();
    return console.log('Recent log cleared (the events table in state.db is kept).');
  }
  if (command === 'status') return status(settings, store, db);
  if (command === 'digest') {
    const text = digestText(db, { since: Date.now() - parseSince(flags.since) });
    console.log(text);
    if (flags.send) {
      const sent = await sendNotification(settings, 'digest', text);
      console.log(sent.length ? `sent via ${sent.length} channel(s)` : 'no notify channel configured');
    }
    return;
  }
  if (command === 'policy') return policyCommand(settings, store, positionals[1] ?? 'show');
  if (command === 'review') return review(settings, store, db);

  const running = runningPid();
  if (running) {
    // One browser per profile: a second one corrupts the profile.
    console.error(`The watcher is already running (pid ${running}); stop it first.`);
    process.exit(EXIT_ERROR);
  }

  const { context, page } = await launchBrowser({ profileDir: path.join(stateDir, 'profile'), headed: flags.headed });
  let apiServer = null;
  const shutdown = async (code = 0) => {
    if (exiting) return;
    exiting = true;
    apiServer?.close();
    store.flush();
    db.close();
    if (command === 'run') fs.rmSync(PID_FILE, { force: true });
    await context.close().catch(() => {});
    process.exit(code);
  };
  const fatal = (event, message, code) => {
    if (exiting) return; // our own shutdown closes the browser too
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
      try {
        db.recordEvent(entry);
      } catch (err) {
        console.warn('event not recorded:', err.message);
      }
      console.log(formatEntry(entry));
      if (ACTED.test(entry.outcome ?? '')) notify(settings, 'action', formatEntry(entry));
    },
    onFatal: (message) => fatal('llm-failing', message, EXIT_LLM),
  });
  // Typing into the compose box: the page only sends on trusted input
  // events, so this happens here with a real keyboard and mouse.
  async function typeAndSend(text) {
    try {
      const box = page.getByRole('textbox', { name: /message/i }).first();
      await box.click({ timeout: 5000 });
      await page.keyboard.type(text);
      const send = page.locator('[data-e2e-send-text-button]:visible').first();
      await send.click({ timeout: 5000 });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message.split('\n')[0] };
    }
  }
  await page.exposeFunction('__mcSend', (msg) => (msg.type === 'sendText' ? typeAndSend(String(msg.text ?? '')) : backend.handle(msg)));
  await page.exposeFunction('__mcStorage', (op, arg) => {
    const res = store[op](arg) ?? {};
    // Keep the queryable copy of the verdicts current.
    if (op === 'set' && arg?.verdicts) {
      try {
        db.syncVerdicts(arg.verdicts);
      } catch (err) {
        console.warn('verdicts not mirrored:', err.message);
      }
    }
    return res;
  });

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
    // Headless: sign in again with the Google session and ask the phone to
    // approve (the emoji). The watcher keeps asking, with a fresh emoji each
    // round and the notifications spaced out, so a tap at any time heals it;
    // one-off commands try once and exit 2.
    const onApproval = (file, message) => notify(settings, 'pairing-approval', message, { photo: file });
    for (let round = 0; ; round++) {
      const resumed = await resumePairing(page, { stateDir, timeout: (command === 'pair' ? 30 : 10) * 60000, onApproval });
      if (resumed) {
        console.log('Paired again.');
        return;
      }
      if (command !== 'run' || flags.headed) break;
      const delay = Math.min(60, 5 * 2 ** round);
      console.log(`No approval yet; asking again in ${delay} min.`);
      await page.waitForTimeout(delay * 60000);
      await page.goto(MESSAGES_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      if ((await waitForState(page).catch(() => null)) === 'paired') return;
    }
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
  let undoMsg = null;
  if (command === 'undo') {
    const event = db.db.prepare('select * from events where id = ?').get(Number(String(positionals[1]).replace('#', '')));
    if (!event) throw new Error(`no event #${positionals[1]} (see \`log\`)`);
    const kind = /^blocked/.test(event.outcome ?? '') ? 'blocked' : /^archived/.test(event.outcome ?? '') ? 'archived' : null;
    if (!kind) throw new Error(`event #${event.id} was "${event.outcome}": only blocks and archives can be undone (Messages for web has no trash view)`);
    if (!event.name) throw new Error(`event #${event.id} has no sender name to look up`);
    undoMsg = { type: 'undo', kind, name: event.name, threadId: event.thread_id };
  }
  const oneOff = {
    diagnose: { type: 'diagnose' },
    undo: undoMsg,
    act: { type: 'act', id: positionals[1], action: positionals[2], live: flags.live },
    send: { type: 'send', id: positionals[1], text: positionals.slice(2).join(' '), live: flags.live },
    scan: { type: 'scanNow', includeSeen: flags['include-seen'] },
    sweep: { type: 'scanNow', processAll: true },
    'act-on-spam': { type: 'scanNow', trashSpam: true },
    'check-pictures': { type: 'scanNow', checkPictures: true },
  };
  if (oneOff[command]) {
    if (!(await waitForRows())) console.warn('No conversation rows appeared; the inbox may be empty.');
    const res = await deliver(oneOff[command]);
    if (command === 'diagnose') console.log(JSON.stringify(res?.report ?? res, null, 2));
    else if (command === 'act' || command === 'undo' || command === 'send') {
      if (!res?.ok) {
        console.error(res?.error ?? 'no answer from the page');
        return shutdown(EXIT_ERROR);
      }
      console.log(formatEntry(res.row));
    } else console.log(res?.summary ?? res);
    return shutdown();
  }

  // run: content.js does the watching. After a reload the page starts over
  // without it, and the phone can unpair us; both are mended here.
  fs.writeFileSync(PID_FILE, String(process.pid));
  // The local API: healthz and metrics for monitoring, the dashboard at /.
  const apiConf = { ...settings.api };
  if (apiConf.port > 0) {
    if (!apiConf.token) {
      apiConf.token = randomBytes(24).toString('base64url');
      const config = readConfig();
      writeConfig({ ...config, api: { ...(config.api ?? {}), token: apiConf.token } });
      console.log(`API token written to ${CONFIG_FILE} (api.token).`);
    }
    const health = async () => {
      const alive = await Promise.race([page.evaluate(() => 1).then(() => true), new Promise((r) => setTimeout(() => r(false), 10000))]).catch(() => false);
      const paired = alive ? (await pairingState(page).catch(() => null)) === 'paired' : false;
      return { ok: alive && paired, alive, paired, pid: process.pid, uptimeSeconds: Math.floor(process.uptime()) };
    };
    try {
      apiServer = await startApi({ settings, bind: apiConf.bind, port: apiConf.port, token: apiConf.token, db, store, backend, health, deliver, policy: loadPolicy() });
    } catch (err) {
      console.warn(`API not started (${err.message}); healthz and the dashboard are off.`);
    }
  }
  console.log(`Watching Messages (mode ${settings.mode}, ${settings.dryRun ? 'dry run' : 'LIVE'}; spam → ${settings.spamAction}, marketing → trash).`);
  let mending = false;
  async function mend() {
    if (mending || exiting) return;
    mending = true;
    try {
      await Promise.race([
        page.evaluate(() => 1),
        new Promise((_, reject) => setTimeout(() => reject(new Error('page not answering: browser hung or closed')), 20000)),
      ]);
      const state = await pairingState(page);
      if (state === 'unpaired') {
        await ensurePaired();
        await inject();
      } else if (state === 'paired' && !(await injected())) {
        await inject();
      }
    } catch (err) {
      // A dead browser or crashed page answers nothing useful again: exit so
      // the service manager restarts a fresh one.
      if (/closed|crashed|Target page, context or browser/i.test(err.message)) {
        await fatal('browser-closed', `The browser is gone (${err.message.split('\n')[0]}).`, EXIT_ERROR);
        return;
      }
      console.warn('recovery failed:', err.message);
    } finally {
      mending = false;
    }
  }
  page.on('load', mend);
  // A pairing revoked elsewhere (the phone, another device) doesn't move a
  // page that is already open: only a reload shows it. Reload now and then,
  // between scans; content.js is re-injected on load.
  const reloadEvery = Math.max(1, Number(settings.reloadMinutes) || 20) * 60000;
  setInterval(async () => {
    if (exiting || mending) return;
    const scanning = await page.evaluate(() => !!globalThis.MessagesControlScanning).catch(() => true);
    if (scanning) return;
    await page.reload({ waitUntil: 'domcontentloaded' }).catch((err) => console.warn('reload failed:', err.message));
  }, reloadEvery);
  // Test hook: pretend the phone unpaired us after N seconds, to exercise the
  // recovery path (mend → ensurePaired → exit 2) without touching the pairing.
  const fakeUnpair = Number(process.env.MESSAGES_CONTROL_TEST_UNPAIR_AFTER);
  if (fakeUnpair > 0) setTimeout(() => fatal('unpaired', 'Not paired with the phone (test hook). Run: messages-control pair --headed', EXIT_UNPAIRED), fakeUnpair * 1000);
  page.on('crash', () => fatal('crash', 'The browser page crashed.', EXIT_ERROR));
  context.on('close', () => fatal('browser-closed', 'The browser closed.', EXIT_ERROR));
  setInterval(mend, 30000);
  await new Promise(() => {});
}

main().catch((err) => {
  if (exiting) return;
  console.error(err.stack ?? String(err));
  process.exit(EXIT_ERROR);
});
