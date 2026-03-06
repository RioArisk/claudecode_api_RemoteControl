// ============================================================
//  Hub — server list management & connect screen
// ============================================================
import {
  STORAGE_KEY, LAST_KEY, SERVERS_MAX,
  HUB_PROBE_INTERVAL_MS, HUB_PROBE_TIMEOUT_MS, HUB_PROBE_FAST_RETRY_MS,
  HUB_PROBE_FAILS_TO_OFFLINE,
} from './constants.js';
import { $, esc, timeAgo, parseServerAddress, generateServerId } from './utils.js';
import {
  S, serverAddr, serverWsUrl, serverCacheAddr, serverToken,
  setServerAddr, setServerWsUrl, setServerCacheAddr, setServerToken,
} from './state.js';
import { showToast } from './toast.js';
import { showConfirm } from './confirm.js';
import { isAuthReadyMessage, connect, clearForegroundProbe } from './websocket.js';
import { clearConversationUi, updateHeaderInfo, flushSessionCacheSave } from './renderer.js';

let hubStatus = new Map();
let hubProbeTimer = null;
let hubEditingServerId = null;
let hubRetryTimers = new Map();
let hubConnectingServerId = null;

function normalizeServerEntry(raw) {
  const base = (raw && typeof raw === 'object') ? raw : { addr: raw };
  const parsed = parseServerAddress(String(base.addr || ''));
  return {
    id: typeof base.id === 'string' && base.id ? base.id : generateServerId(),
    addr: parsed.ok ? parsed.displayAddr : String(base.addr || '').trim(),
    wsUrl: parsed.ok ? parsed.wsUrl : String(base.wsUrl || ''),
    cacheAddr: parsed.ok ? parsed.cacheAddr : String(base.cacheAddr || ''),
    alias: typeof base.alias === 'string' ? base.alias.trim() : '',
    token: typeof base.token === 'string' ? base.token : '',
    addedAt: Number.isFinite(base.addedAt) ? base.addedAt : Date.now(),
    lastConnectedAt: Number.isFinite(base.lastConnectedAt) ? base.lastConnectedAt : 0,
  };
}

function getServerDedupKey(server) {
  if (server.wsUrl) return `ws:${server.wsUrl}`;
  const parsed = parseServerAddress(server.addr || '');
  if (parsed.ok) return `ws:${parsed.wsUrl}`;
  return `addr:${String(server.addr || '').trim().toLowerCase()}`;
}

function getServerDisplayName(server) {
  return (server.alias || server.addr || '').trim();
}

function normalizeServerList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const normalized = [];
  list.forEach(item => {
    const entry = normalizeServerEntry(item);
    const key = getServerDedupKey(entry);
    if (seen.has(key)) return;
    seen.add(key);
    normalized.push(entry);
  });
  return normalized.slice(0, SERVERS_MAX);
}

export function getSavedServers() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return normalizeServerList(raw);
  } catch { return []; }
}

function saveServerList(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeServerList(list)));
}

function findDuplicateServer(list, wsUrl, excludeId = null) {
  return list.find(server => server.id !== excludeId && getServerDedupKey(server) === `ws:${wsUrl}`);
}

function addServer(addr, alias, token) {
  const parsed = parseServerAddress(addr);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  let list = getSavedServers();
  if (findDuplicateServer(list, parsed.wsUrl)) {
    return { ok: false, error: 'Server already exists' };
  }
  const entry = {
    id: generateServerId(),
    addr: parsed.displayAddr,
    wsUrl: parsed.wsUrl,
    cacheAddr: parsed.cacheAddr,
    alias: (alias || '').trim(),
    token: (token || '').trim(),
    addedAt: Date.now(),
    lastConnectedAt: 0,
  };
  list.unshift(entry);
  saveServerList(list);
  return { ok: true, entry };
}

export function saveServer(addr) {
  let list = getSavedServers();
  const idx = list.findIndex(s => s.addr === addr || s.wsUrl === serverWsUrl);
  if (idx >= 0) {
    list[idx].lastConnectedAt = Date.now();
  }
  saveServerList(list);
  localStorage.setItem(LAST_KEY, addr);
}

function removeServer(id) {
  let list = getSavedServers();
  const idx = list.findIndex(s => s.id === id);
  if (idx < 0) return null;
  const removed = list[idx];
  list.splice(idx, 1);
  saveServerList(list);
  const last = localStorage.getItem(LAST_KEY) || '';
  if (removed && (last === removed.addr || last === removed.wsUrl || last === removed.cacheAddr)) {
    localStorage.removeItem(LAST_KEY);
  }
  return removed;
}

function migrateServerList() {
  const rawText = localStorage.getItem(STORAGE_KEY);
  if (!rawText) return;
  try {
    const raw = JSON.parse(rawText);
    const normalized = normalizeServerList(raw);
    if (JSON.stringify(raw) !== JSON.stringify(normalized)) saveServerList(normalized);
  } catch {
    saveServerList([]);
  }
}

// ---- Hub probe ----
function createHubProbeInfo() {
  return {
    status: 'probing',
    latencyMs: null,
    lastProbeAt: 0,
    lastSuccessAt: 0,
    consecutiveFailures: 0,
    probeToken: 0,
  };
}

function getHubProbeInfo(serverId) {
  if (!hubStatus.has(serverId)) hubStatus.set(serverId, createHubProbeInfo());
  return hubStatus.get(serverId);
}

function resetHubProbeInfo(serverId) {
  const previous = getHubProbeInfo(serverId);
  const next = createHubProbeInfo();
  next.probeToken = previous.probeToken;
  hubStatus.set(serverId, next);
  return next;
}

function syncHubProbeState(servers) {
  const ids = new Set(servers.map(server => server.id));
  Array.from(hubStatus.keys()).forEach(id => {
    if (ids.has(id)) return;
    hubStatus.delete(id);
    if (hubRetryTimers.has(id)) {
      clearTimeout(hubRetryTimers.get(id));
      hubRetryTimers.delete(id);
    }
  });
}

function hubPingTone(latencyMs) {
  if (!Number.isFinite(latencyMs)) return 'offline';
  if (latencyMs <= 120) return 'excellent';
  if (latencyMs <= 300) return 'good';
  if (latencyMs <= 800) return 'warn';
  return 'bad';
}

function renderHubPing(info) {
  const classes = ['hub-card-ping'];
  let label = '--';

  if (info.status === 'probing') {
    classes.push('probing');
    label = '...';
  } else if (info.status === 'offline') {
    classes.push('offline');
  } else if (Number.isFinite(info.latencyMs)) {
    classes.push(hubPingTone(info.latencyMs));
    label = `${Math.round(info.latencyMs)}ms`;
    if (info.status === 'unstable') {
      classes.push('stale');
      label = `~${label}`;
    }
  }

  return `<span class="${classes.join(' ')}">${label}</span>`;
}

export function renderHubCards() {
  const servers = getSavedServers();
  syncHubProbeState(servers);
  const empty = $('hub-empty');
  const secOnline = $('hub-section-online');
  const secOffline = $('hub-section-offline');
  const listOnline = $('hub-list-online');
  const listOffline = $('hub-list-offline');

  if (servers.length === 0) {
    empty.style.display = '';
    secOnline.style.display = 'none';
    secOffline.style.display = 'none';
    return;
  }
  empty.style.display = 'none';

  const onlineCards = [];
  const offlineCards = [];

  servers.forEach(s => {
    const probe = getHubProbeInfo(s.id);
    const status = probe.status || 'probing';
    const displayName = getServerDisplayName(s);
    const showAddr = s.alias ? s.addr : '';
    const isConnecting = hubConnectingServerId === s.id;
    const card = `<div class="hub-card" data-server-id="${esc(s.id)}">
      <div class="hub-card-status ${status}"></div>
      <div class="hub-card-info">
        <div class="hub-card-name">${esc(displayName)}</div>
        ${showAddr ? `<div class="hub-card-addr">${esc(showAddr)}</div>` : ''}
      </div>
      <div class="hub-card-side">
        ${isConnecting ? '<span class="hub-card-ping probing">...</span>' : renderHubPing(probe)}
        <span class="hub-card-time">${esc(timeAgo(s.lastConnectedAt))}</span>
      </div>
      <button class="hub-card-edit" data-edit-id="${esc(s.id)}" title="Edit">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>
      </button>
    </div>`;

    if (status === 'online' || status === 'unstable') onlineCards.push(card);
    else offlineCards.push(card);
  });

  secOnline.style.display = onlineCards.length ? '' : 'none';
  secOffline.style.display = offlineCards.length ? '' : 'none';
  listOnline.innerHTML = onlineCards.join('');
  listOffline.innerHTML = offlineCards.join('');

  document.querySelectorAll('.hub-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('.hub-card-edit')) {
        e.stopPropagation();
        openEditServerDialog(e.target.closest('.hub-card-edit').dataset.editId);
        return;
      }
      connectToServer(card.dataset.serverId);
    });
  });
}

export function showHubConnectOverlay(server) {
  hubConnectingServerId = server && server.id ? server.id : null;
  const sub = $('hub-connect-sub');
  sub.textContent = server ? `Connecting to ${getServerDisplayName(server)}` : 'Preparing server session';
  $('hub-connect-overlay').classList.add('visible');
}

export function hideHubConnectOverlay() {
  hubConnectingServerId = null;
  $('hub-connect-overlay').classList.remove('visible');
}

function clearHubRetry(serverId) {
  if (!hubRetryTimers.has(serverId)) return;
  clearTimeout(hubRetryTimers.get(serverId));
  hubRetryTimers.delete(serverId);
}

function scheduleHubRetry(serverId) {
  if (hubRetryTimers.has(serverId)) return;
  const timer = setTimeout(() => {
    hubRetryTimers.delete(serverId);
    if ($('connect-screen').classList.contains('hidden')) return;
    const server = getSavedServers().find(item => item.id === serverId);
    if (!server) return;
    runHubProbes([server]);
  }, HUB_PROBE_FAST_RETRY_MS);
  hubRetryTimers.set(serverId, timer);
}

function probeServer(server) {
  return new Promise(resolve => {
    if (!server.wsUrl) { resolve({ ok: false, latencyMs: null }); return; }
    let done = false;
    const startedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const finish = (ok) => {
      if (done) return;
      done = true;
      const endedAt = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      resolve({
        ok,
        latencyMs: ok ? Math.max(1, Math.round(endedAt - startedAt)) : null,
      });
    };
    try {
      const ws = new WebSocket(server.wsUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch {} finish(false); }, HUB_PROBE_TIMEOUT_MS);
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({
            type: 'hello',
            clientInstanceId: `hub_probe_${Date.now().toString(36)}`,
            token: server.token || '',
            page: '/hub-probe',
            userAgent: navigator.userAgent || '',
          }));
        } catch {
          clearTimeout(timer);
          finish(false);
        }
      };
      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (!isAuthReadyMessage(msg)) return;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        finish(true);
      };
      ws.onerror = () => { clearTimeout(timer); finish(false); };
      ws.onclose = () => { clearTimeout(timer); if (!done) finish(false); };
    } catch { finish(false); }
  });
}

function applyHubProbeResult(server, result) {
  const info = getHubProbeInfo(server.id);
  info.lastProbeAt = Date.now();

  if (result.ok) {
    clearHubRetry(server.id);
    info.status = 'online';
    info.latencyMs = result.latencyMs;
    info.lastSuccessAt = info.lastProbeAt;
    info.consecutiveFailures = 0;
    return;
  }

  info.consecutiveFailures += 1;
  if (info.lastSuccessAt && info.consecutiveFailures < HUB_PROBE_FAILS_TO_OFFLINE) {
    info.status = 'unstable';
    scheduleHubRetry(server.id);
    return;
  }

  clearHubRetry(server.id);
  info.status = 'offline';
  info.latencyMs = null;
}

async function runHubProbes(servers, { markUnknown = false } = {}) {
  if (!servers.length) return;
  const results = await Promise.all(servers.map(server => {
    const info = getHubProbeInfo(server.id);
    const token = ++info.probeToken;
    if (markUnknown && !info.lastProbeAt) info.status = 'probing';
    return probeServer(server).then(result => ({ server, result, token }));
  }));
  results.forEach(({ server, result, token }) => {
    const current = hubStatus.get(server.id);
    if (!current || current.probeToken !== token) return;
    applyHubProbeResult(server, result);
  });
  renderHubCards();
}

async function probeAllServers() {
  const servers = getSavedServers();
  syncHubProbeState(servers);
  if (servers.length === 0) {
    renderHubCards();
    return;
  }
  renderHubCards();
  await runHubProbes(servers, { markUnknown: true });
}

export function startHubProbes() {
  stopHubProbes();
  probeAllServers();
  hubProbeTimer = setInterval(() => probeAllServers(), HUB_PROBE_INTERVAL_MS);
}

export function stopHubProbes() {
  if (hubProbeTimer) { clearInterval(hubProbeTimer); hubProbeTimer = null; }
  Array.from(hubRetryTimers.values()).forEach(timer => clearTimeout(timer));
  hubRetryTimers.clear();
}

export function connectToServer(serverId) {
  if (hubConnectingServerId) return;
  const servers = getSavedServers();
  const s = servers.find(x => x.id === serverId);
  if (!s) { showToast('Server not found'); return; }
  if (!s.wsUrl) {
    const parsed = parseServerAddress(s.addr);
    if (!parsed.ok) { showToast('Invalid server address'); return; }
    s.wsUrl = parsed.wsUrl;
    s.cacheAddr = parsed.cacheAddr;
    saveServerList(servers);
  }
  setServerAddr(s.addr);
  setServerWsUrl(s.wsUrl);
  setServerCacheAddr(s.cacheAddr);
  setServerToken(s.token || '');
  showHubConnectOverlay(s);
  renderHubCards();
  connect();
}

// ---- Hub add/edit dialog ----
function openAddServerDialog() {
  hubEditingServerId = null;
  $('hub-dialog-title').textContent = 'Add Server';
  $('hub-dialog-addr').value = '';
  $('hub-dialog-alias').value = '';
  $('hub-dialog-token').value = '';
  $('hub-dialog-token').type = 'password';
  $('hub-dialog-error').textContent = '';
  $('hub-dialog-delete').style.display = 'none';
  $('hub-add-overlay').classList.add('visible');
  $('hub-dialog-addr').focus();
}

export function openEditServerDialog(id) {
  const servers = getSavedServers();
  const s = servers.find(x => x.id === id);
  if (!s) return;
  hubEditingServerId = id;
  $('hub-dialog-title').textContent = 'Edit Server';
  $('hub-dialog-addr').value = s.addr;
  $('hub-dialog-alias').value = s.alias || '';
  $('hub-dialog-token').value = s.token || '';
  $('hub-dialog-token').type = 'password';
  $('hub-dialog-error').textContent = '';
  $('hub-dialog-delete').style.display = '';
  $('hub-add-overlay').classList.add('visible');
  $('hub-dialog-addr').focus();
}

function closeServerDialog() {
  $('hub-add-overlay').classList.remove('visible');
  hubEditingServerId = null;
}

function saveServerDialog() {
  const addr = $('hub-dialog-addr').value.trim();
  const alias = $('hub-dialog-alias').value.trim();
  const token = $('hub-dialog-token').value.trim();
  if (!addr) { $('hub-dialog-error').textContent = 'Please enter a server address'; return; }
  const parsed = parseServerAddress(addr);
  if (!parsed.ok) { $('hub-dialog-error').textContent = parsed.error; return; }

  if (hubEditingServerId) {
    let list = getSavedServers();
    const s = list.find(x => x.id === hubEditingServerId);
    if (s) {
      const duplicate = findDuplicateServer(list, parsed.wsUrl, hubEditingServerId);
      if (duplicate) {
        $('hub-dialog-error').textContent = 'Server already exists';
        return;
      }
      s.addr = parsed.displayAddr;
      s.wsUrl = parsed.wsUrl;
      s.cacheAddr = parsed.cacheAddr;
      s.alias = alias;
      s.token = token;
      saveServerList(list);
      resetHubProbeInfo(s.id);
      clearHubRetry(s.id);
      runHubProbes([s], { markUnknown: true });
    }
  } else {
    const result = addServer(addr, alias, token);
    if (!result.ok) { $('hub-dialog-error').textContent = result.error || 'Invalid address'; return; }
    hubStatus.set(result.entry.id, createHubProbeInfo());
    runHubProbes([result.entry], { markUnknown: true });
  }
  closeServerDialog();
  renderHubCards();
}

async function deleteServerFromDialog() {
  if (!hubEditingServerId) return;
  const id = hubEditingServerId;
  const servers = getSavedServers();
  const target = servers.find(x => x.id === id) || null;
  const deletingCurrent = !!target && (
    (!!serverWsUrl && target.wsUrl === serverWsUrl) ||
    (!!serverAddr && target.addr === serverAddr) ||
    (!!serverCacheAddr && target.cacheAddr === serverCacheAddr)
  );
  const deletingConnecting = hubConnectingServerId === id;
  closeServerDialog();
  const ok = await showConfirm('Delete this server?');
  if (!ok) { renderHubCards(); return; }
  const removed = removeServer(id);
  hubStatus.delete(id);
  clearHubRetry(id);
  if (deletingConnecting) {
    hubConnectingServerId = null;
    hideHubConnectOverlay();
  }
  if (deletingCurrent || deletingConnecting || (removed && removed.wsUrl === serverWsUrl)) {
    if (S.reconnectTimer) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; }
    const hadWs = !!S.ws;
    S.intentionalDisconnect = hadWs;
    S.skipNextCloseHandling = hadWs;
    if (S.ws) {
      try { S.ws.close(); } catch {}
    } else {
      S.intentionalDisconnect = false;
      S.skipNextCloseHandling = false;
    }
    setServerAddr('');
    setServerWsUrl('');
    setServerCacheAddr('');
    setServerToken('');
    localStorage.removeItem(LAST_KEY);
    resetAppState();
    showConnectScreen();
  }
  renderHubCards();
}

export function resetAppState() {
  clearForegroundProbe('reset_app_state');
  S.ws = null;
  S.authenticated = false;
  S.sessionId = '';
  S.resumeRequestedFor = '';
  S.lastMessageAt = 0;
  S.sessionSyncToken = 0;
  S.turnStateVersion = 0;
  S.pendingTurnState = null;
  S.pendingPlanContent = '';
  S.cwd = '';
  S.model = '';
  S.pendingPerms = [];
  S.replaying = true;
  S.intentionalDisconnect = false;
  clearConversationUi();
  $('input').value = '';
  updateHeaderInfo();
  $('perm-overlay').classList.remove('visible');
}

export function showConnectScreen() {
  hideHubConnectOverlay();
  $('connect-screen').classList.remove('hidden');
  $('app').classList.add('hidden');
  hubStatus.clear();
  renderHubCards();
  startHubProbes();
}

export function showApp() {
  hideHubConnectOverlay();
  stopHubProbes();
  $('connect-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  saveServer(serverAddr);
}

export function initHub() {
  migrateServerList();
  renderHubCards();
  startHubProbes();

  $('hub-add-btn').addEventListener('click', openAddServerDialog);
  $('hub-dialog-cancel').addEventListener('click', closeServerDialog);
  $('hub-dialog-save').addEventListener('click', saveServerDialog);
  $('hub-dialog-delete').addEventListener('click', deleteServerFromDialog);
  $('hub-add-overlay').addEventListener('click', (e) => {
    if (e.target === $('hub-add-overlay')) closeServerDialog();
  });
  $('hub-dialog-addr').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveServerDialog();
  });
  $('hub-dialog-token-toggle').addEventListener('click', () => {
    const inp = $('hub-dialog-token');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  // Back button
  $('btn-back').addEventListener('click', () => {
    (async () => {
      const hadWs = !!S.ws;
      S.intentionalDisconnect = hadWs;
      S.skipNextCloseHandling = hadWs;
      try {
        await flushSessionCacheSave();
      } catch {}
      if (S.ws) S.ws.close();
      else {
        S.intentionalDisconnect = false;
        S.skipNextCloseHandling = false;
      }
      if (S.reconnectTimer) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; }
      resetAppState();
      showConnectScreen();
    })();
  });
}
