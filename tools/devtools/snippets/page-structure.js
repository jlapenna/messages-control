(() => {
  const trim = (el, max = 3000) => {
    if (!el) return null;
    const c = el.cloneNode(true);
    c.querySelectorAll('svg, style, script').forEach((n) => n.replaceWith('[' + n.tagName.toLowerCase() + ']'));
    const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode()); ) if (n.nodeValue.trim().length > 30) n.nodeValue = n.nodeValue.trim().slice(0, 30) + '…';
    c.querySelectorAll('img').forEach((i) => i.setAttribute('src', (i.getAttribute('src') || '').slice(0, 50)));
    return c.outerHTML.replace(/\s+/g, ' ').replace(/ _ngcontent-[\w-]+=""/g, '').replace(/ _nghost-[\w-]+=""/g, '').slice(0, max);
  };
  const links = [...document.querySelectorAll('a[href]')].filter((a) => a.origin === location.origin && a.pathname.startsWith('/web/conversations/'));
  const link = links.find((a) => !a.pathname.endsWith('/new'));
  const item = link?.closest('mws-conversation-list-item');
  const chain = []; for (let e = link; e && chain.length < 6; e = e.parentElement) chain.push(e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.split(' ').slice(0, 3).join('.') : ''));
  return JSON.stringify({
    url: location.href,
    linkCount: links.length,
    hrefs: links.slice(0, 4).map((a) => a.getAttribute('href')),
    ancestors: chain,
    listItemTag: item ? 'mws-conversation-list-item' : link?.parentElement?.tagName,
    firstItem: trim(item ?? link?.parentElement, 5000),
    msfBadges: document.querySelectorAll('.msf-badge').length,
  }, null, 1);
})()
