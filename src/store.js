import fs from 'node:fs';
import path from 'node:path';

// chrome.storage.local on a JSON file: one object, written whole and
// atomically, shortly after each change.
export class Store {
  constructor(file) {
    this.file = file;
    this.data = {};
    this.timer = null;
    try {
      this.data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`${file}: ${err.message}`);
    }
  }

  // Accepts what chrome.storage.local.get does: a key, a list of keys, or an
  // object of defaults.
  get(keys) {
    if (keys == null) return structuredClone(this.data);
    const defaults = !Array.isArray(keys) && typeof keys === 'object' ? keys : {};
    const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of names) out[k] = k in this.data ? structuredClone(this.data[k]) : defaults[k];
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
  }

  set(items) {
    Object.assign(this.data, structuredClone(items));
    this.schedule();
  }

  remove(keys) {
    for (const k of [].concat(keys)) delete this.data[k];
    this.schedule();
  }

  schedule() {
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    // The file holds message text and senders: owner-only.
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
