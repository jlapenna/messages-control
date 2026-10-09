import { chromium } from 'playwright';

// A persistent Chromium profile: the Messages pairing lives in it. Full
// Chromium (not the headless shell), so the page sees an ordinary browser.
export async function launchBrowser({ profileDir, headed }) {
  const opts = {
    channel: 'chromium',
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  };
  let context = await chromium.launchPersistentContext(profileDir, opts);
  // Headless Chromium calls itself HeadlessChrome; present the same name a
  // window would.
  const ua = await (await firstPage(context)).evaluate(() => navigator.userAgent);
  if (ua.includes('HeadlessChrome')) {
    await context.close();
    context = await chromium.launchPersistentContext(profileDir, { ...opts, userAgent: ua.replace('HeadlessChrome', 'Chrome') });
  }
  return { context, page: await firstPage(context) };
}

async function firstPage(context) {
  return context.pages()[0] ?? (await context.newPage());
}
