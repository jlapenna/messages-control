// Hands the dashboard the API token so the page needs no typing. Runs before
// the page's own scripts, and the page reads localStorage at start, so the
// token has to be there synchronously.
const { ipcRenderer } = require('electron');
try {
  const token = ipcRenderer.sendSync('token');
  if (token) localStorage.setItem('mc.token', token);
} catch {}
