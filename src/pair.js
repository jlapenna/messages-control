import fs from 'node:fs';
import path from 'node:path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import QRCode from 'qrcode';

export const MESSAGES_URL = 'https://messages.google.com/web/';
// The welcome page an unpaired profile lands on only offers Google sign-in
// (which wants a CAPTCHA from an automated browser); this one still shows
// the QR code.
const AUTH_URL = 'https://messages.google.com/web/authentication';
export const LIST = 'mws-conversations-list';

// Where the page landed: 'paired' once the conversation list shows,
// 'unpaired' on the welcome or QR screen, null while it's still deciding.
export async function pairingState(page) {
  if (await page.locator(LIST).count()) return 'paired';
  if (/\/web\/(authentication|welcome)/.test(page.url())) return 'unpaired';
  return null;
}

export async function waitForState(page, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const state = await pairingState(page);
    if (state) return state;
    await page.waitForTimeout(500);
  }
  throw new Error(`Messages showed neither the conversation list nor the pairing screen within ${timeout / 1000}s (at ${page.url()})`);
}

// The QR's markup changes; its pixels don't. Decode it from a screenshot and
// hand back the raw payload bytes.
async function readQr(page) {
  const shot = await page.screenshot();
  const png = PNG.sync.read(shot);
  const code = jsQR(new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), png.width, png.height);
  return code ? { bytes: Buffer.from(code.binaryData), shot } : null;
}

// Best effort: switch on "Remember this computer" so the pairing outlives
// the session. Reports what it did.
async function rememberComputer(page) {
  return page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (!/remember this computer/i.test(node.textContent)) continue;
      let el = node.parentElement;
      for (let i = 0; i < 4 && el; i++, el = el.parentElement) {
        const toggle = el.querySelector('[role="switch"], [role="checkbox"], input[type="checkbox"], button');
        if (!toggle) continue;
        const on = toggle.getAttribute('aria-checked') === 'true' || toggle.checked === true;
        if (on) return 'already on';
        toggle.click();
        return 'switched on';
      }
      return 'found the text but no toggle near it';
    }
    return 'no such option on the page';
  });
}

// Shows the pairing QR in the terminal (and saves it as qr.png) until the
// phone scans it. The QR rotates now and then, so it's re-read every few
// seconds and reprinted when it changes.
export async function pair(page, { stateDir, out = console.log }) {
  let last = null;
  let remembered = false;
  for (;;) {
    if ((await pairingState(page)) === 'paired') return;
    if (!page.url().startsWith(AUTH_URL)) {
      await page.goto(AUTH_URL, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
    }
    const qr = await readQr(page).catch(() => null);
    if (qr && !(last && qr.bytes.equals(last))) {
      last = qr.bytes;
      const file = path.join(stateDir, 'qr.png');
      fs.writeFileSync(file, qr.shot);
      out('');
      out('On the phone: Messages → ⋮ → Device pairing → QR code scanner, then scan this:');
      out('');
      out(await QRCode.toString([{ data: qr.bytes, mode: 'byte' }], { type: 'terminal', small: true }));
      out(`(also saved as ${file})`);
      if (!remembered) {
        remembered = true;
        out(`"Remember this computer": ${await rememberComputer(page).catch((e) => e.message)}`);
      }
    } else if (!qr && !last) {
      out(`Waiting for the pairing QR to appear at ${page.url()} …`);
    }
    await page.waitForTimeout(3000);
  }
}
