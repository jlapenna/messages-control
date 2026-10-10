// Messages Control, desktop: runs the watcher as a child process, shows the
// dashboard in a window, pairs in a window, and lives in the tray.
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, nativeImage, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The CLI lives beside this app in development, under resources/app when packaged.
const APP_DIR = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');
const CLI = path.join(APP_DIR, 'bin', 'messages-control.js');
const CONFIG_FILE = process.env.MESSAGES_CONTROL_CONFIG ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'messages-control', 'config.json');
const NODE = process.env.MESSAGES_CONTROL_NODE ?? 'node';

let watcher = null;
let win = null;
let tray = null;
let logTail = [];

function config() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}
const apiPort = () => config().api?.port ?? 7373;
const apiUrl = () => `http://127.0.0.1:${apiPort()}/`;

function run(args, { onExit } = {}) {
  const child = spawn(NODE, [CLI, ...args], { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: ['ignore', 'pipe', 'pipe'] });
  const keep = (chunk) => {
    logTail = [...logTail, ...String(chunk).split('\n').filter(Boolean)].slice(-200);
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  child.on('exit', (code) => onExit?.(code));
  return child;
}

function startWatcher() {
  if (watcher) return;
  watcher = run(['run'], {
    onExit: (code) => {
      watcher = null;
      updateTray();
      if (code === 2) {
        dialog.showMessageBox({ type: 'warning', message: 'Messages Control is not paired with your phone.', detail: 'Choose "Pair with phone" from the tray menu.' });
      } else if (code && code !== 0 && !app.quitting) {
        setTimeout(startWatcher, 30000); // like the systemd unit: restart on failure
      }
    },
  });
  updateTray();
}

function stopWatcher() {
  if (!watcher) return;
  watcher.kill('SIGTERM');
}

function pair() {
  stopWatcher();
  const child = run(['pair', '--headed'], {
    onExit: (code) => {
      if (code === 0) startWatcher();
      else dialog.showMessageBox({ type: 'error', message: 'Pairing did not finish.', detail: logTail.slice(-10).join('\n') });
    },
  });
  void child;
}

async function waitForApi(ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const res = await fetch(`${apiUrl()}healthz`);
      if (res.status === 200 || res.status === 503) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function openDashboard() {
  if (win) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: 'Messages Control',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.on('closed', () => (win = null));
  win.webContents.setWindowOpenHandler(({ url }) => (shell.openExternal(url), { action: 'deny' }));
  if (await waitForApi()) await win.loadURL(apiUrl());
  else await win.loadURL(`data:text/html,<h2 style="font-family:sans-serif">The watcher is not running.</h2><pre>${encodeURIComponent(logTail.slice(-20).join('\n'))}</pre>`);
  // Smoke test: capture the window and quit.
  if (process.env.MESSAGES_CONTROL_DESKTOP_SCREENSHOT) {
    await new Promise((r) => setTimeout(r, 4000));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(process.env.MESSAGES_CONTROL_DESKTOP_SCREENSHOT, image.toPNG());
    app.quit();
  }
}

function updateTray() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: watcher ? 'Watching' : 'Stopped', enabled: false },
      { label: 'Open dashboard', click: openDashboard },
      { label: watcher ? 'Stop' : 'Start', click: () => (watcher ? stopWatcher() : startWatcher()) },
      { label: 'Pair with phone…', click: pair },
      { label: 'Show log', click: () => dialog.showMessageBox({ message: 'Recent log', detail: logTail.slice(-30).join('\n') }) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.setToolTip(`Messages Control: ${watcher ? 'watching' : 'stopped'}`);
}

ipcMain.on('token', (event) => {
  event.returnValue = config().api?.token ?? '';
});

app.whenReady().then(() => {
  // A plain 16px dot; a real icon can replace it.
  const icon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAUklEQVQ4T2NkoBAwUqifYdQABkIGYGFhIcoAVlZW/P5gYWHB6g9GRkaC/mFmZsZvADs7O0F/sLGx4Q8DNjY2/AawsLAQNoCVlZUEfzDQ3wUAAJSICH0E6cAAAAAASUVORK5CYII=');
  tray = new Tray(icon);
  updateTray();
  startWatcher();
  openDashboard();
});
app.on('before-quit', () => {
  app.quitting = true;
  stopWatcher();
});
app.on('window-all-closed', () => {}); // stays in the tray
