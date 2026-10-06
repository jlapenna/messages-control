(async () => {
  const THREAD = '(680) 310-7755'; // edit: name or number of the thread whose menu to read
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const a = [...document.querySelectorAll('a[data-e2e-conversation]')].find((x) => x.innerText.includes(THREAD));
  if (!a) return 'thread not found';
  const btn = a.querySelector('button[data-e2e-conversation-list-item-menu]');
  for (const t of ['pointerover', 'mouseover', 'mouseenter']) a.dispatchEvent(new MouseEvent(t, { bubbles: true }));
  btn.click();
  await sleep(600);
  const items = [...document.querySelectorAll('[role="menuitem"]')].map((m) => `${m.tagName.toLowerCase()} "${m.innerText.trim()}" ${[...m.attributes].filter((x) => x.name.startsWith('data-e2e')).map((x) => x.name).join(' ')}`);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.querySelector('.cdk-overlay-backdrop')?.click();
  await sleep(300);
  return JSON.stringify({ button: btn.getAttribute('aria-label'), items, menuStillOpen: document.querySelectorAll('[role="menuitem"]').length }, null, 1);
})()
