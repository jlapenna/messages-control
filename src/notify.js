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
export async function notify(settings, event, message, { photo = null, fetchImpl = fetch } = {}) {
  if (!wanted(settings, event)) return [];
  const results = [];
  for (const ch of channels(settings)) {
    try {
      if (ch.kind === 'telegram') results.push(await telegram(ch, message, photo, fetchImpl));
      else results.push(command(ch, event, message, photo));
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

function command({ command }, event, message, photo) {
  const child = spawn('sh', ['-c', command], {
    env: { ...process.env, MC_EVENT: event, MC_MESSAGE: message, MC_PHOTO: photo ?? '' },
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', (err) => console.warn('notify command failed:', err.message));
  child.unref();
  return true;
}
