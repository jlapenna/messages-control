import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// Events a notification can be about. "action" is every block/trash/archive;
// the rest are the things a person has to deal with.
export const EVENTS = ['action', 'pairing-approval', 'unpaired', 'llm-failing', 'crash', 'browser-closed', 'digest'];

// Config:
//   "notify": {
//     "events": ["pairing-approval", "unpaired", "llm-failing", "digest"],   (default: all)
//     "telegram": { "token": "...", "chatId": "..." },
//     "command": "telegram-send \"$MC_MESSAGE\""                             (MC_EVENT, MC_MESSAGE, MC_PHOTO)
//   }
// "notifyCommand" at the top level still works and means notify.command.
export function channels(settings) {
  const n = settings.notify ?? {};
  const out = [];
  if (n.telegram?.token && n.telegram?.chatId) out.push({ kind: 'telegram', ...n.telegram });
  const command = n.command ?? settings.notifyCommand;
  if (command) out.push({ kind: 'command', command });
  return out;
}

export function wanted(settings, event) {
  const list = settings.notify?.events;
  return !Array.isArray(list) || list.includes(event);
}

// Fire and forget: a notification never fails the thing it reports on.
export async function notify(settings, event, message, { photo = null, fetchImpl = fetch, commandTimeoutMs = 65000 } = {}) {
  if (!wanted(settings, event)) return [];
  const results = [];
  for (const ch of channels(settings)) {
    try {
      if (ch.kind === 'telegram') results.push(await telegram(ch, message, photo, fetchImpl));
      else results.push(await command(ch, event, message, photo, commandTimeoutMs));
    } catch (err) {
      console.warn(`notify (${ch.kind}) failed:`, err.message);
      results.push(false);
    }
  }
  return results;
}

async function telegram({ token, chatId }, message, photo, fetchImpl) {
  const api = (method) => `https://api.telegram.org/bot${token}/${method}`;
  let res;
  if (photo && fs.existsSync(photo)) {
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('caption', message.slice(0, 1024));
    form.set('photo', new Blob([fs.readFileSync(photo)], { type: 'image/png' }), path.basename(photo));
    res = await fetchImpl(api('sendPhoto'), { method: 'POST', body: form, signal: AbortSignal.timeout(20000) });
  } else {
    res = await fetchImpl(api('sendMessage'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: String(chatId), text: message.slice(0, 4096), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(20000),
    });
  }
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return true;
}

function killChildGroup(child, signal) {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {}
}

function command({ command }, event, message, photo, timeoutMs = 65000) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-c', command], {
      env: { ...process.env, MC_EVENT: event, MC_MESSAGE: message, MC_PHOTO: photo ?? '' },
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 512) stderr += chunk.toString('utf8').slice(0, 512 - stderr.length);
    });
    let settled = false;
    let killTimer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      killChildGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => killChildGroup(child, 'SIGKILL'), 2000);
      killTimer.unref();
      finish(reject, new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();
    child.on('error', (err) => {
      clearTimeout(killTimer);
      finish(reject, err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (code === 0) return finish(resolve, true);
      const why = code != null ? `exit ${code}` : `signal ${signal}`;
      const detail = stderr.trim().slice(0, 200);
      finish(reject, new Error(detail ? `${why}: ${detail}` : why));
    });
  });
}
