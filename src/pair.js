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

// The Google session usually outlives the Messages pairing: after an unpair
// the welcome page offers "Continue as <name>", and Messages then asks the
// person to match an emoji in the phone's app. No window is needed: the emoji
// is saved as a picture (pairing-emoji.png in the state dir) and handed to
// onApproval, and this waits for the phone. Returns true once the list shows.
export async function resumePairing(page, { stateDir, timeout = 10 * 60000, onApproval = () => {}, out = console.log } = {}) {
  const signIn = page.getByRole('button', { name: /^(sign in|continue as .+)$/i }).first();
  // The welcome page shows its button once it has looked up the session.
  if (!(await signIn.waitFor({ timeout: 15000 }).then(() => true, () => false))) return false;
  out("Signing in again with the browser's Google session…");
  await signIn.click().catch(() => {});
  const end = Date.now() + timeout;
  let announced = false;
  while (Date.now() < end) {
    if ((await pairingState(page)) === 'paired') return true;
    // Google's account chooser, if it appears: one entry per account.
    const account = page.locator('[data-identifier]').first();
    if (await account.isVisible().catch(() => false)) await account.click().catch(() => {});
    if (!announced && /\/web\/pair/.test(page.url())) {
      const file = path.join(stateDir, 'pairing-emoji.png');
      // The emoji is an inline SVG picture that replaces a spinner.
      const emoji = page.locator('img[src^="data:image/svg"]').last();
      const shown = await emoji.waitFor({ timeout: 20000 }).then(() => true, () => false);
      if (shown) await emoji.screenshot({ path: file }).catch(() => page.screenshot({ path: file }));
      else await page.screenshot({ path: file });
      announced = true;
      // The page also says it in words (for screen readers): the code and
      // where to tap it on the phone.
      const words = await page
        .evaluate(() => document.body.innerText.replace(/\s+/g, ' ').match(/Your verification code is[^.]*\.[^.]*\./)?.[0] ?? '')
        .catch(() => '');
      const message = `Approve on the phone. ${words || 'Open Google Messages and tap the emoji shown in ' + file}`.trim();
      out(message);
      await onApproval(file, message);
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

// Headed: a person is at the window, so they sign in with the Google account
// the phone uses (or scan the QR themselves); this just waits for the list.
export async function waitForPairing(page, { out = console.log } = {}) {
  out('In the browser window: Sign in with the Google account the phone uses, and approve on the phone if it asks.');
  out(`(Or scan the QR at ${AUTH_URL} from Messages on the phone, if it still has a QR scanner.)`);
  while ((await pairingState(page)) !== 'paired') await page.waitForTimeout(2000);
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
