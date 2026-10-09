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

// The extension's defaults, then the config file, then LITELLM_API_KEY from
// the environment, then command-line overrides.
export function loadSettings(overrides = {}) {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`${CONFIG_FILE}: ${err.message}`);
  }
  const env = process.env.LITELLM_API_KEY ? { apiKey: process.env.LITELLM_API_KEY } : {};
  return { ...DEFAULTS, ...file, ...env, ...overrides };
}
