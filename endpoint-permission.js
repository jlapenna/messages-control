// Chrome match patterns grant a host, across its ports, rather than an API
// path. Only the configured host is requested; the broad optional declaration
// lets people choose their own provider or a local gateway.
export function endpointPermission(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Enter a valid HTTP or HTTPS endpoint URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP or HTTPS endpoint without a username or password in the URL.');
  }
  return { origins: [`${url.protocol}//${url.hostname}/*`] };
}
