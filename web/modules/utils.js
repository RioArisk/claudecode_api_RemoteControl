// ============================================================
//  Utilities
// ============================================================
export const $ = id => document.getElementById(id);

export function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
export function trunc(s, n) { return (!s || s.length <= n) ? s : s.substring(0, n) + '...'; }
export function stripImageTags(s) { return (s || '').replace(/\[Image:\s*source:\s*[^\]]*\]/g, '').trim(); }

export function formatUrlForDisplay(url, includeScheme) {
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
  const base = `${auth}${url.host}`;
  const path = url.pathname === '/' ? '' : url.pathname;
  const prefix = includeScheme ? `${url.protocol}//` : '';
  return `${prefix}${base}${path}${url.search}${url.hash}`;
}

export function parseServerAddress(input) {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'Please enter a server address' };

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url;
  try {
    url = new URL(hasScheme ? raw : `ws://${raw}`);
  } catch {
    return { ok: false, error: 'Invalid address' };
  }

  const protocol = url.protocol.toLowerCase();
  let wsProtocol;
  if (protocol === 'ws:') wsProtocol = 'ws:';
  else if (protocol === 'wss:') wsProtocol = 'wss:';
  else if (protocol === 'http:') wsProtocol = 'ws:';
  else if (protocol === 'https:') wsProtocol = 'wss:';
  else return { ok: false, error: 'Use ws://, wss://, http://, https://, or host:port' };

  if (!url.hostname) return { ok: false, error: 'Invalid address' };
  if (!hasScheme && !url.port) url.port = '3100';

  const wsUrl = new URL(url.toString());
  wsUrl.protocol = wsProtocol;

  return {
    ok: true,
    displayAddr: formatUrlForDisplay(url, hasScheme),
    wsUrl: wsUrl.toString(),
    cacheAddr: wsUrl.toString(),
  };
}

export function shortenPath(p) {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').replace(/\/$/, '').split('/');
  if (parts.length <= 2) return parts.join('/');
  return parts.slice(-2).join('/');
}

export function formatModel(m) {
  if (!m) return '';
  return m.replace(/^claude-/, '').replace(/-(\d)/g, ' $1').replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

export function formatTokens(n) {
  if (!n) return '';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k tokens';
  return n + ' tokens';
}

export function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m + 'm' + (rem > 0 ? rem + 's' : '');
}

export function timeAgo(ts) {
  if (!ts) return 'Never';
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  const day = Math.floor(hr / 24);
  return day + 'd ago';
}

export function normalizePathForCompare(p) {
  return String(p || '').replace(/[\\/]+$/, '').toLowerCase();
}

export function makeUploadId() {
  return `upl_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function generateServerId() {
  return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}
