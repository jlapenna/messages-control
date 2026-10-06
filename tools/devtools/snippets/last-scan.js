(async () => {
  const { lastScan, log = [] } = await chrome.storage.local.get(['lastScan', 'log']);
  const fmt = (r) => [r.label?.toUpperCase(), r.score != null ? Math.round(r.score * 100) + '%' : '', '·', r.outcome, '|', r.name, '·', r.timestamp ?? '', r.media ? '· ' + r.media : '', '|', (r.reason ?? '').slice(0, 70), '|', (r.text ?? '').slice(0, 40)].filter((x) => x !== '').join(' ');
  return [`LAST SCAN ${new Date(lastScan?.time).toLocaleTimeString()}: ${lastScan?.summary}`, ...(lastScan?.threads ?? []).map(fmt), '', 'RECENT LOG:', ...log.slice(0, 8).map(fmt)].join('\n');
})()
