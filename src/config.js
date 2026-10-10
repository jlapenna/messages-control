import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS } from '../settings.js';

const home = os.homedir();
export const CONFIG_FILE =
  process.env.MESSAGES_CONTROL_CONFIG ??
  path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'messages-control', 'config.json');
// Holds the browser profile (the pairing lives in it) and state.json.
export const STATE_DIR =
  process.env.MESSAGES_CONTROL_STATE ??
  path.join(process.env.XDG_STATE_HOME ?? path.join(home, '.local', 'state'), 'messages-control');

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`${CONFIG_FILE}: ${err.message}`);
    return {};
  }
}

export function writeConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

// Spam mode touches nothing but new threads: no labels on the history, no
// archiving of old codes and notices.
const MODES = {
  spam: { labelExisting: false, archiveOldNotices: false },
  full: {},
};

// The extension's defaults, then the config file, then the API key from the
// environment, then command-line overrides, then what the mode forces.
export function loadSettings(overrides = {}) {
  const env = process.env.MESSAGES_CONTROL_API_KEY ? { apiKey: process.env.MESSAGES_CONTROL_API_KEY } : {};
  const s = { ...DEFAULTS, ...readConfig(), ...env, ...overrides };
  if (!MODES[s.mode]) throw new Error(`unknown mode "${s.mode}" (spam or full)`);
  return { ...s, ...MODES[s.mode] };
}
