// ============================================================
//  Claude Remote — Android Client (Tauri 2.0)
//  Connects to a running server.js bridge via WebSocket
// ============================================================

const $ = id => document.getElementById(id);

// ============================================================
//  Connection Screen
// ============================================================
const STORAGE_KEY = 'claude_remote_servers';
const LAST_KEY = 'claude_remote_last';
const SERVERS_MAX = 20;
const HUB_PROBE_INTERVAL_MS = 15000;
const HUB_PROBE_TIMEOUT_MS = 3000;
const HUB_PROBE_FAST_RETRY_MS = 1200;
const HUB_PROBE_FAILS_TO_OFFLINE = 2;
const CHAT_CACHE_DB = 'claude_remote_chat_cache';
const CHAT_CACHE_STORE = 'sessions';
const CHAT_CACHE_MAX_SESSIONS = 8;
const CHAT_CACHE_MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const CHAT_CACHE_MAX_SESSION_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_CHUNK_BYTES = 96 * 1024;
const WS_CLOSE_AUTH_FAILED = 4001;
const WS_CLOSE_AUTH_TIMEOUT = 4002;
const WS_CLOSE_REASON_AUTH_FAILED = 'auth_failed';
const WS_CLOSE_REASON_AUTH_TIMEOUT = 'auth_timeout';
let chatCacheDbPromise = null;

// ---- Hub state ----
let hubStatus = new Map();      // serverId -> { status, latencyMs, ... }
let hubProbeTimer = null;
let hubEditingServerId = null;
let hubRetryTimers = new Map();
let hubConnectingServerId = null;

function generateServerId() {
  return 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

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

function getSavedServers() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return normalizeServerList(raw);
  } catch { return []; }
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

function saveServer(addr) {
  let list = getSavedServers();
  const idx = list.findIndex(s => s.addr === addr || s.wsUrl === serverWsUrl);
  if (idx >= 0) {
    list[idx].lastConnectedAt = Date.now();
  }
  saveServerList(list);
  localStorage.setItem(LAST_KEY, addr);
}

function removeServer(id) {
  let list = getSavedServers().filter(s => s.id !== id);
  saveServerList(list);
}

function updateServerAlias(id, alias) {
  let list = getSavedServers();
  const s = list.find(s => s.id === id);
  if (s) { s.alias = (alias || '').trim(); saveServerList(list); }
}

function openChatCacheDb() {
  if (chatCacheDbPromise) return chatCacheDbPromise;
  chatCacheDbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(CHAT_CACHE_DB, 1);
    req.onerror = () => reject(req.error || new Error('Failed to open chat cache'));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CHAT_CACHE_STORE)) {
        const store = db.createObjectStore(CHAT_CACHE_STORE, { keyPath: 'cacheKey' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
  }).catch(err => {
    console.warn('[chat-cache]', err);
    chatCacheDbPromise = null;
    throw err;
  });
  return chatCacheDbPromise;
}

async function chatCacheRead(cacheKey) {
  const db = await openChatCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHAT_CACHE_STORE, 'readonly');
    const req = tx.objectStore(CHAT_CACHE_STORE).get(cacheKey);
    req.onerror = () => reject(req.error || new Error('Failed to read chat cache'));
    req.onsuccess = () => resolve(req.result || null);
  });
}

async function chatCacheWrite(record) {
  const db = await openChatCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHAT_CACHE_STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to write chat cache'));
    tx.objectStore(CHAT_CACHE_STORE).put(record);
  });
}

async function chatCacheDelete(cacheKey) {
  const db = await openChatCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHAT_CACHE_STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to delete chat cache'));
    tx.objectStore(CHAT_CACHE_STORE).delete(cacheKey);
  });
}

async function chatCacheReadAll() {
  const db = await openChatCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHAT_CACHE_STORE, 'readonly');
    const req = tx.objectStore(CHAT_CACHE_STORE).getAll();
    req.onerror = () => reject(req.error || new Error('Failed to list chat cache'));
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
  });
}

function buildCacheKey(addr, sessionId) {
  return `${addr}::${sessionId}`;
}

function estimateCacheBytes(record) {
  const payload = JSON.stringify({
    sessionId: record.sessionId || '',
    serverAddr: record.serverAddr || '',
    html: record.html || '',
    seenUuids: Array.isArray(record.seenUuids) ? record.seenUuids : [],
    todoTasks: Array.isArray(record.todoTasks) ? record.todoTasks : [],
    todoPanelOpen: !!record.todoPanelOpen,
    cwd: record.cwd || '',
    model: record.model || '',
    lastSeq: record.lastSeq || 0,
    updatedAt: record.updatedAt || 0,
  });
  return payload.length;
}

function buildCacheHtmlSnapshot() {
  const snapshotRoot = $msgs.cloneNode(true);
  snapshotRoot.querySelectorAll('[data-optimistic], .working-indicator').forEach(el => el.remove());
  return snapshotRoot.innerHTML;
}

async function pruneChatCache() {
  let records;
  try {
    records = await chatCacheReadAll();
  } catch {
    return;
  }

  records.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  let totalBytes = 0;
  const removals = [];

  records.forEach((record, idx) => {
    const sizeBytes = Number.isFinite(record.sizeBytes) ? record.sizeBytes : estimateCacheBytes(record);
    totalBytes += sizeBytes;
    const overCount = idx >= CHAT_CACHE_MAX_SESSIONS;
    const overTotal = totalBytes > CHAT_CACHE_MAX_TOTAL_BYTES;
    const overSingle = sizeBytes > CHAT_CACHE_MAX_SESSION_BYTES;
    if (overCount || overTotal || overSingle) removals.push(record.cacheKey);
  });

  await Promise.all(removals.map(cacheKey => chatCacheDelete(cacheKey).catch(() => {})));
}

// ---- Hub rendering & probes ----
function timeAgo(ts) {
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

function renderHubCards() {
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

  // Bind card clicks
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

function showHubConnectOverlay(server) {
  hubConnectingServerId = server && server.id ? server.id : null;
  const sub = $('hub-connect-sub');
  sub.textContent = server ? `Connecting to ${getServerDisplayName(server)}` : 'Preparing server session';
  $('hub-connect-overlay').classList.add('visible');
}

function hideHubConnectOverlay() {
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

function startHubProbes() {
  stopHubProbes();
  probeAllServers();
  hubProbeTimer = setInterval(() => probeAllServers(), HUB_PROBE_INTERVAL_MS);
}

function stopHubProbes() {
  if (hubProbeTimer) { clearInterval(hubProbeTimer); hubProbeTimer = null; }
  Array.from(hubRetryTimers.values()).forEach(timer => clearTimeout(timer));
  hubRetryTimers.clear();
}

function connectToServer(serverId) {
  if (hubConnectingServerId) return;
  const servers = getSavedServers();
  const s = servers.find(x => x.id === serverId);
  if (!s) { showToast('Server not found'); return; }
  if (!s.wsUrl) {
    // Re-parse in case format was invalid at migration time
    const parsed = parseServerAddress(s.addr);
    if (!parsed.ok) { showToast('Invalid server address'); return; }
    s.wsUrl = parsed.wsUrl;
    s.cacheAddr = parsed.cacheAddr;
    saveServerList(servers);
  }
  serverAddr = s.addr;
  serverWsUrl = s.wsUrl;
  serverCacheAddr = s.cacheAddr;
  serverToken = s.token || '';
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

function openEditServerDialog(id) {
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
    // Update existing
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
    // Add new
    const result = addServer(addr, alias, token);
    if (!result.ok) { $('hub-dialog-error').textContent = result.error || 'Invalid address'; return; }
    hubStatus.set(result.entry.id, createHubProbeInfo());
    runHubProbes([result.entry], { markUnknown: true });
  }
  closeServerDialog();
  renderHubCards();
}

function deleteServerFromDialog() {
  if (!hubEditingServerId) return;
  const id = hubEditingServerId;
  // Use the existing confirm overlay
  $('confirm-text').textContent = 'Delete this server?';
  $('confirm-overlay').classList.add('visible');
  const onOk = () => {
    removeServer(id);
    hubStatus.delete(id);
    clearHubRetry(id);
    closeServerDialog();
    renderHubCards();
    cleanup();
  };
  const onCancel = () => { cleanup(); };
  function cleanup() {
    $('confirm-ok').removeEventListener('click', onOk);
    $('confirm-cancel').removeEventListener('click', onCancel);
    $('confirm-overlay').classList.remove('visible');
  }
  $('confirm-ok').addEventListener('click', onOk);
  $('confirm-cancel').addEventListener('click', onCancel);
}

// ---- Migrate on load ----
migrateServerList();

// Restore last address is no longer needed (Hub handles it)
// But we still render the hub cards and start probing
renderHubCards();
startHubProbes();

let serverAddr = '';
let serverWsUrl = '';
let serverCacheAddr = '';
let serverToken = '';
let pendingImage = null; // { file, mediaType, name, previewUrl, uploadId, status, progress, ... }

// Hub button bindings
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

function tryConnect() {
  // Called only for programmatic connections; Hub cards use connectToServer()
  if (!serverWsUrl) return;
  connect();
}

function showConnectScreen() {
  hideHubConnectOverlay();
  $('connect-screen').classList.remove('hidden');
  $('app').classList.add('hidden');
  hubStatus.clear();
  renderHubCards();
  startHubProbes();
}

function showApp() {
  hideHubConnectOverlay();
  stopHubProbes();
  $('connect-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  saveServer(serverAddr);
}

function isAuthReadyMessage(msg) {
  return !!msg && (
    msg.type === 'auth_ok' ||
    msg.type === 'status' ||
    msg.type === 'transcript_ready' ||
    msg.type === 'replay_done' ||
    msg.type === 'turn_state'
  );
}

function finalizeAuthenticatedConnection() {
  if (S.authenticated) return;
  S.authenticated = true;
  setStatus('connected');
  setConnBanner(false);
  if ($('app').classList.contains('hidden')) {
    showApp();
    return;
  }
  hideHubConnectOverlay();
  renderHubCards();
  saveServer(serverAddr);
}

function isCloseEvent(event, code, reason) {
  return !!event && event.code === code && (!reason || event.reason === reason);
}

const CLIENT_INSTANCE_KEY = 'claude_remote_client_instance_id';

function getClientInstanceId() {
  const fallback = `client_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    let id = sessionStorage.getItem(CLIENT_INSTANCE_KEY);
    if (!id) {
      id = fallback;
      sessionStorage.setItem(CLIENT_INSTANCE_KEY, id);
    }
    return id;
  } catch {
    return fallback;
  }
}

const CLIENT_INSTANCE_ID = getClientInstanceId();
let debugLogSeq = 0;
const MAX_PENDING_DEBUG_LOGS = 120;
const pendingDebugLogs = [];

function wsReadyStateName(ws) {
  if (!ws) return 'null';
  switch (ws.readyState) {
    case WebSocket.CONNECTING: return 'CONNECTING';
    case WebSocket.OPEN: return 'OPEN';
    case WebSocket.CLOSING: return 'CLOSING';
    case WebSocket.CLOSED: return 'CLOSED';
    default: return String(ws.readyState);
  }
}

function queueDebugPayload(payload) {
  pendingDebugLogs.push(payload);
  if (pendingDebugLogs.length > MAX_PENDING_DEBUG_LOGS) pendingDebugLogs.shift();
}

function restorePendingDebugLogs(payloads) {
  if (!payloads || !payloads.length) return;
  pendingDebugLogs.unshift(...payloads);
  while (pendingDebugLogs.length > MAX_PENDING_DEBUG_LOGS) pendingDebugLogs.shift();
}

function sendDebugPayload(payload) {
  try {
    if (typeof S !== 'undefined' && S.ws && S.ws.readyState === WebSocket.OPEN) {
      S.ws.send(JSON.stringify({ type: 'debug_log', ...payload }));
      return true;
    }
  } catch {}
  return false;
}

function flushPendingDebugLogs() {
  if (!pendingDebugLogs.length) return;
  if (typeof S === 'undefined' || !S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  const backlog = pendingDebugLogs.splice(0, pendingDebugLogs.length);
  for (let i = 0; i < backlog.length; i += 1) {
    const payload = backlog[i];
    if (!sendDebugPayload(payload)) {
      restorePendingDebugLogs(backlog.slice(i));
      break;
    }
  }
}

function debugLog(event, detail = {}) {
  const payload = {
    clientInstanceId: CLIENT_INSTANCE_ID,
    event,
    detail,
    seq: ++debugLogSeq,
    ts: new Date().toISOString(),
  };
  console.log('[bridge-debug]', payload);
  if (!sendDebugPayload(payload)) queueDebugPayload(payload);
}

// ============================================================
//  App State
// ============================================================
const S = {
  ws: null,
  authenticated: false,
  sessionId: '',
  lastSeq: 0,
  lastMessageAt: 0,
  seenUuids: new Set(),
  messageMap: new Map(),
  toolMap: new Map(),
  currentGroup: null,
  currentGroupCount: 0,
  isAtBottom: true,
  waiting: false,
  workingEl: null,
  cwd: '',
  model: '',
  pendingPerms: [],
  waitStartedAt: 0,
  replaying: true,           // true during history replay, false after replay_done
  turnStateVersion: 0,
  pendingTurnState: null,
  pendingPlanContent: '',
  reconnectTimer: null,
  intentionalDisconnect: false,
  skipNextCloseHandling: false,
  resumeRequestedFor: '',
  cacheSaveTimer: null,
  sessionSyncToken: 0,
  uploadWaiters: new Map(),
  foregroundProbeSeq: 0,
  foregroundProbeId: '',
  foregroundProbeTimer: null,
  lastForegroundRecoverAt: 0,
};

const dirBrowserState = {
  cwd: '',
  parent: null,
  roots: [],
  entries: [],
};

const FOREGROUND_PROBE_TIMEOUT_MS = 2000;
const FOREGROUND_RECOVER_DEBOUNCE_MS = 1200;

function clearForegroundProbe(reason = '') {
  if (S.foregroundProbeTimer) {
    clearTimeout(S.foregroundProbeTimer);
    S.foregroundProbeTimer = null;
  }
  if (S.foregroundProbeId) {
    debugLog('foreground_probe_clear', {
      reason,
      probeId: S.foregroundProbeId,
      wsState: wsReadyStateName(S.ws),
      waiting: S.waiting,
      sessionId: S.sessionId || null,
    });
  }
  S.foregroundProbeId = '';
}

function reconnectFromForeground(reason) {
  debugLog('foreground_reconnect', {
    reason,
    wsState: wsReadyStateName(S.ws),
    waiting: S.waiting,
    sessionId: S.sessionId || null,
    hidden: typeof document !== 'undefined' ? !!document.hidden : null,
  });
  clearForegroundProbe(reason);
  if (S.reconnectTimer) {
    clearTimeout(S.reconnectTimer);
    S.reconnectTimer = null;
  }
  if (S.ws && S.ws.readyState !== WebSocket.CLOSED) {
    try { S.ws.close(); } catch {}
    return;
  }
  if (!$('app').classList.contains('hidden')) connect();
}

function startForegroundProbe(trigger) {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  if (S.foregroundProbeId) return;

  const probeId = `fg_${++S.foregroundProbeSeq}_${Date.now().toString(36)}`;
  S.foregroundProbeId = probeId;
  debugLog('foreground_probe_send', {
    trigger,
    probeId,
    sessionId: S.sessionId || null,
    lastSeq: S.lastSeq,
    waiting: S.waiting,
    wsState: wsReadyStateName(S.ws),
  });

  S.foregroundProbeTimer = setTimeout(() => {
    if (S.foregroundProbeId !== probeId) return;
    debugLog('foreground_probe_timeout', {
      trigger,
      probeId,
      sessionId: S.sessionId || null,
      lastSeq: S.lastSeq,
      waiting: S.waiting,
      wsState: wsReadyStateName(S.ws),
    });
    reconnectFromForeground('foreground_probe_timeout');
  }, FOREGROUND_PROBE_TIMEOUT_MS);

  try {
    S.ws.send(JSON.stringify({
      type: 'foreground_probe',
      probeId,
      sessionId: S.sessionId || null,
      lastSeq: S.lastSeq,
    }));
  } catch {
    reconnectFromForeground('foreground_probe_send_failed');
  }
}

function recoverConnectionOnForeground(trigger) {
  if (typeof document !== 'undefined' && document.hidden) return;
  if ($('app').classList.contains('hidden')) return;

  const now = Date.now();
  if (now - S.lastForegroundRecoverAt < FOREGROUND_RECOVER_DEBOUNCE_MS) return;
  S.lastForegroundRecoverAt = now;

  debugLog('foreground_recover_check', {
    trigger,
    wsState: wsReadyStateName(S.ws),
    waiting: S.waiting,
    sessionId: S.sessionId || null,
    lastSeq: S.lastSeq,
    reconnectScheduled: !!S.reconnectTimer,
    lastMessageAgoMs: S.lastMessageAt ? (now - S.lastMessageAt) : null,
  });

  if (!S.ws || S.ws.readyState === WebSocket.CLOSED) {
    if (S.reconnectTimer) {
      clearTimeout(S.reconnectTimer);
      S.reconnectTimer = null;
    }
    connect();
    return;
  }

  if (S.ws.readyState === WebSocket.CONNECTING || S.ws.readyState === WebSocket.CLOSING) return;
  startForegroundProbe(trigger);
}

const $msgs = $('messages'), $chat = $('chat-area'), $input = $('input');
const INPUT_PLACEHOLDER_DEFAULT = 'Reply...';
const INPUT_PLACEHOLDER_WAITING = 'AI 思考中…';

// Delegated click for thinking-toggle, step-group-header, step-item (works after cache restore)
$msgs.addEventListener('click', (e) => {
  const toggle = e.target.closest('.thinking-toggle');
  if (toggle) { toggle.parentElement.classList.toggle('open'); return; }
  const header = e.target.closest('.step-group-header');
  if (header) { header.parentElement.classList.toggle('open'); return; }
  const item = e.target.closest('.step-item');
  if (item) {
    const toolId = item.dataset.toolId;
    const detail = toolId && document.getElementById(`detail-${toolId}`);
    if (detail) detail.classList.toggle('open');
  }
});

// ============================================================
//  Utilities
// ============================================================
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function trunc(s, n) { return (!s || s.length <= n) ? s : s.substring(0, n) + '...'; }
function stripImageTags(s) { return (s || '').replace(/\[Image:\s*source:\s*[^\]]*\]/g, '').trim(); }

function formatUrlForDisplay(url, includeScheme) {
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
  const base = `${auth}${url.host}`;
  const path = url.pathname === '/' ? '' : url.pathname;
  const prefix = includeScheme ? `${url.protocol}//` : '';
  return `${prefix}${base}${path}${url.search}${url.hash}`;
}

function parseServerAddress(input) {
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

function localizeToastText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  if (/[\u4e00-\u9fff]/.test(raw)) return raw;

  const directMap = new Map([
    ['Server not found', '未找到服务器记录'],
    ['Invalid server address', '服务器地址无效'],
    ['Clearing conversation...', '正在清空当前对话…'],
    ['Fetching token costs...', '正在获取 Token 费用信息…'],
    ['Loading help...', '正在加载帮助信息…'],
    ['Please select an image file', '请选择图片文件'],
    ['Image too large (max 4MB)', '图片过大\n最大支持 4MB'],
    ['Connection unavailable', '连接不可用\n请先确认已连接到服务器'],
    ['Image upload failed', '图片上传失败'],
    ['Image upload failed. Re-select the image and try again.', '图片上传失败\n请重新选择图片后再试'],
    ['Image submit failed', '图片发送失败'],
    ['Failed to change folder', '切换文件夹失败'],
    ['Connection lost', '连接已断开'],
    ['Handshake timed out - check client/server compatibility and try again', '连接握手超时\n请检查客户端与服务端版本是否兼容'],
    ['Linux image paste requires xclip or wl-copy on the server. Install one and try again.', '服务端缺少图片剪贴板工具\n请安装 xclip 或 wl-copy 后重试'],
    ['Upload not ready', '图片尚未上传完成\n请稍后再试'],
    ['Upload session not found', '上传会话不存在\n请重新选择图片'],
    ['Upload owner mismatch', '上传会话无效\n请重新选择图片'],
    ['Missing uploadId', '上传请求无效\n请重新选择图片'],
    ['Missing chunk payload', '图片分片数据缺失\n请重新上传'],
  ]);

  if (directMap.has(raw)) return directMap.get(raw);
  if (raw.startsWith('Now using ')) {
    return `已切换模型\n${raw.slice('Now using '.length)}`;
  }
  if (raw.startsWith('Switching to ')) {
    return `正在切换模型\n${raw.slice('Switching to '.length).replace(/\.\.\.$/, '')}`;
  }
  if (raw.startsWith('Authentication failed')) {
    return '鉴权失败\n请检查 Token 是否正确';
  }
  if (raw.startsWith('Unexpected chunk index')) {
    return '图片分片顺序异常\n请重新上传';
  }
  if (raw.startsWith('Upload incomplete')) {
    return '图片上传不完整\n请重新上传';
  }
  if (raw.startsWith('Image upload failed:')) {
    return `图片上传失败\n${raw.slice('Image upload failed:'.length).trim()}`;
  }
  return raw;
}

function showToast(text) {
  const message = localizeToastText(text);
  if (!message) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'alert');
  el.textContent = message;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

function makeUploadId() {
  return `upl_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function imageProgressLabel(image) {
  if (!image) return '0%';
  if (image.status === 'uploaded') return 'Done';
  if (image.status === 'submitting') return 'Send';
  if (image.status === 'failed') return 'Retry';
  return `${Math.max(0, Math.min(100, Math.round((image.progress || 0) * 100)))}%`;
}

function updateImagePreviewUi() {
  const preview = $('image-preview');
  const img = $('image-preview-img');
  const overlay = $('image-upload-overlay');
  const ring = $('image-upload-ring');
  const text = $('image-upload-text');
  const removeBtn = $('image-preview-remove');

  if (!pendingImage) {
    preview.classList.add('hidden');
    img.src = '';
    overlay.classList.add('hidden');
    text.textContent = '0%';
    ring.style.strokeDashoffset = '97.4';
    removeBtn.disabled = false;
    return;
  }

  preview.classList.remove('hidden');
  img.src = pendingImage.previewUrl || '';
  removeBtn.disabled = pendingImage.status === 'submitting';

  const showOverlay = pendingImage.status === 'uploading' || pendingImage.status === 'uploaded' ||
    pendingImage.status === 'submitting' || pendingImage.status === 'failed';
  overlay.classList.toggle('hidden', !showOverlay);
  text.textContent = imageProgressLabel(pendingImage);
  ring.style.strokeDashoffset = String(97.4 * (1 - Math.max(0, Math.min(1, pendingImage.progress || 0))));
}

function clearUploadWaiter(uploadId, err = null) {
  const waiter = S.uploadWaiters.get(uploadId);
  if (!waiter) return;
  S.uploadWaiters.delete(uploadId);
  if (err) waiter.reject(err);
  else waiter.resolve();
}

function waitForUploadStatus(uploadId, expectedStatuses, matchFn) {
  return new Promise((resolve, reject) => {
    S.uploadWaiters.set(uploadId, {
      expectedStatuses: new Set(expectedStatuses),
      matchFn,
      resolve,
      reject,
    });
  });
}

function handleUploadStatus(m) {
  if (pendingImage && m.uploadId === pendingImage.uploadId) {
    if (Number.isFinite(m.totalBytes) && m.totalBytes > 0) pendingImage.totalBytes = m.totalBytes;
    if (Number.isFinite(m.receivedBytes)) pendingImage.uploadedBytes = m.receivedBytes;
    const totalBytes = pendingImage.totalBytes || 0;
    if (totalBytes > 0 && Number.isFinite(pendingImage.uploadedBytes)) {
      pendingImage.progress = Math.max(0, Math.min(1, pendingImage.uploadedBytes / totalBytes));
    }
    if (m.status === 'ready_for_chunks' || m.status === 'uploading') pendingImage.status = 'uploading';
    else if (m.status === 'uploaded') {
      pendingImage.status = 'uploaded';
      pendingImage.progress = 1;
    } else if (m.status === 'submitted') {
      pendingImage.status = 'submitted';
      pendingImage.progress = 1;
    } else if (m.status === 'error' || m.status === 'aborted') {
      pendingImage.status = 'failed';
    }
    updateImagePreviewUi();
  }

  const waiter = S.uploadWaiters.get(m.uploadId);
  if (!waiter) return;
  if (m.status === 'error' || m.status === 'aborted') {
    S.uploadWaiters.delete(m.uploadId);
    waiter.reject(new Error(m.message || 'Image upload failed'));
    return;
  }
  if (!waiter.expectedStatuses.has(m.status)) return;
  if (waiter.matchFn && !waiter.matchFn(m)) return;
  S.uploadWaiters.delete(m.uploadId);
  waiter.resolve(m);
}

function clearPendingImage({ abortUpload = true } = {}) {
  if (pendingImage && abortUpload && pendingImage.uploadId && S.ws && S.ws.readyState === WebSocket.OPEN &&
      pendingImage.status !== 'submitted') {
    S.ws.send(JSON.stringify({ type: 'image_upload_abort', uploadId: pendingImage.uploadId }));
  }
  if (pendingImage?.previewUrl) {
    try { URL.revokeObjectURL(pendingImage.previewUrl); } catch {}
  }
  pendingImage = null;
  updateImagePreviewUi();
  updateSendBtn();
}

function fileChunkToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('Failed to read image chunk'));
    reader.onload = () => {
      const result = String(reader.result || '');
      const commaIdx = result.indexOf(',');
      resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => {
      try { URL.revokeObjectURL(objectUrl); } catch {}
      reject(new Error('Failed to decode image preview'));
    };
    img.onload = () => {
      try {
        const maxW = 480;
        const maxH = 320;
        const scale = Math.min(1, maxW / img.width, maxH / img.height);
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas unavailable');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      } catch (err) {
        reject(err);
      } finally {
        try { URL.revokeObjectURL(objectUrl); } catch {}
      }
    };
    img.src = objectUrl;
  });
}

async function submitPendingImageUpload() {
  if (!pendingImage || !pendingImage.submitQueued || pendingImage.status !== 'uploaded') return;
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) throw new Error('Connection lost');

  const uploadId = pendingImage.uploadId;
  pendingImage.status = 'submitting';
  updateImagePreviewUi();
  const waitForSubmitted = waitForUploadStatus(uploadId, ['submitted']);
  S.ws.send(JSON.stringify({
    type: 'image_submit',
    uploadId,
    text: pendingImage.queuedText || '',
  }));
  await waitForSubmitted;
  clearPendingImage({ abortUpload: false });
}

async function startImageUpload(image) {
  if (!image || !S.ws || S.ws.readyState !== WebSocket.OPEN) {
    throw new Error('Connection unavailable');
  }

  image.status = 'uploading';
  image.progress = 0;
  image.uploadedBytes = 0;
  updateImagePreviewUi();

  const totalChunks = Math.max(1, Math.ceil(image.file.size / IMAGE_CHUNK_BYTES));
  let waitForStatus = waitForUploadStatus(image.uploadId, ['ready_for_chunks']);
  S.ws.send(JSON.stringify({
    type: 'image_upload_init',
    uploadId: image.uploadId,
    totalBytes: image.file.size,
    totalChunks,
    mediaType: image.mediaType,
    name: image.name,
  }));
  await waitForStatus;

  for (let index = 0; index < totalChunks; index++) {
    const start = index * IMAGE_CHUNK_BYTES;
    const end = Math.min(image.file.size, start + IMAGE_CHUNK_BYTES);
    const base64 = await fileChunkToBase64(image.file.slice(start, end));
    waitForStatus = waitForUploadStatus(image.uploadId, ['uploading'], msg => msg.chunkIndex === index);
    S.ws.send(JSON.stringify({
      type: 'image_upload_chunk',
      uploadId: image.uploadId,
      index,
      base64,
    }));
    await waitForStatus;
  }

  waitForStatus = waitForUploadStatus(image.uploadId, ['uploaded']);
  S.ws.send(JSON.stringify({ type: 'image_upload_complete', uploadId: image.uploadId }));
  await waitForStatus;

  if (pendingImage && pendingImage.uploadId === image.uploadId && pendingImage.submitQueued) {
    await submitPendingImageUpload();
  }
}

function renderMd(text) {
  try {
    if (typeof marked === 'undefined') return esc(text);
    const html = marked.parse(text, { breaks: true, gfm: true });
    const d = document.createElement('div');
    d.innerHTML = html;
    if (typeof hljs !== 'undefined') {
      d.querySelectorAll('pre code').forEach(el => { try { hljs.highlightElement(el); } catch {} });
    }
    return d.innerHTML;
  } catch { return esc(text); }
}

function formatTokens(n) {
  if (!n) return '';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k tokens';
  return n + ' tokens';
}

// Dynamic welcome getter (not cached — survives resetAppState)
function getWelcome() { return $('welcome'); }
function removeWelcome() {
  const w = getWelcome();
  if (w && w.parentNode) w.remove();
}

// Auto-scroll
$chat.addEventListener('scroll', () => {
  S.isAtBottom = ($chat.scrollHeight - $chat.scrollTop - $chat.clientHeight) < 60;
  updateScrollBtn();
});
function scrollEnd() {
  keepWorkingAtBottom();
  if (S.isAtBottom) requestAnimationFrame(() => { $chat.scrollTop = $chat.scrollHeight; });
}

// ============================================================
//  Waiting / Working indicator
// ============================================================
function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m + 'm' + (rem > 0 ? rem + 's' : '');
}

function setWaiting(on, reason = '') {
  debugLog(on ? 'waiting_on' : 'waiting_off', {
    reason,
    waitingBefore: S.waiting,
    sessionId: S.sessionId || null,
    lastSeq: S.lastSeq,
    replaying: S.replaying,
  });
  S.waiting = on;
  if (on) {
    S.waitStartedAt = Date.now();
  } else {
    S.waitStartedAt = 0;
  }
  $input.disabled = on;
  $('btn-send').disabled = on;
  $input.placeholder = on ? INPUT_PLACEHOLDER_WAITING : INPUT_PLACEHOLDER_DEFAULT;
  $('input-area').classList.toggle('waiting', on);
  if (on) {
    removeWorkingIndicator();
    const el = document.createElement('div');
    el.className = 'working-indicator';
    el.innerHTML = '<div class="working-spinner"></div><span class="working-text">Thinking</span>';
    $msgs.appendChild(el);
    S.workingEl = el;
    scrollEnd();
  } else {
    showElapsedTime();
    removeWorkingIndicator();
  }
  updateSendBtn();
}

function switchToWorking() {
  if (S.workingEl) {
    const txt = S.workingEl.querySelector('.working-text');
    if (txt) txt.textContent = 'Working';
  }
}

function keepWorkingAtBottom() {
  if (S.workingEl && S.workingEl.parentNode) {
    $msgs.appendChild(S.workingEl);
  }
}

function showElapsedTime() {
  if (!S.waitStartedAt) return;
  const elapsed = Date.now() - S.waitStartedAt;
  if (elapsed < 1000) return;
  const el = document.createElement('div');
  el.className = 'elapsed-time';
  el.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span>${formatElapsed(elapsed)}</span>`;
  $msgs.appendChild(el);
}

function removeWorkingIndicator() {
  if (S.workingEl && S.workingEl.parentNode) S.workingEl.remove();
  S.workingEl = null;
}

function updateSendBtn() {
  const empty = !$input.value.trim() && !pendingImage;
  $('btn-send').classList.toggle('empty', empty && !S.waiting);
}

function syncConfirmedModel(nextModel, { allowToast = false } = {}) {
  const normalized = String(nextModel || '').trim();
  if (!normalized) return false;

  const prevModel = S.model || '';
  if (prevModel === normalized) return false;

  S.model = normalized;
  updateHeaderInfo();

  if (allowToast && !S.replaying && prevModel) {
    showToast('Now using ' + formatModel(S.model));
  }
  return true;
}

function cacheTurnState(state) {
  if (!state) return;
  const nextVersion = Number.isInteger(state.version) ? state.version : 0;
  const pendingVersion = Number.isInteger(S.pendingTurnState?.version) ? S.pendingTurnState.version : -1;
  if (nextVersion < pendingVersion) return;
  S.pendingTurnState = state;
}

function applyTurnState(state, reason = '') {
  if (!state) return;
  const nextVersion = Number.isInteger(state.version) ? state.version : 0;
  if (nextVersion < S.turnStateVersion) return;
  S.turnStateVersion = nextVersion;
  S.pendingTurnState = null;

  const shouldWait = state.phase === 'running';
  if (S.waiting !== shouldWait) {
    setWaiting(shouldWait, reason || `turn_state:${state.phase || 'idle'}`);
  }
}

function updateScrollBtn() {
  $('btn-scroll').classList.toggle('visible', !S.isAtBottom);
}

function shortenPath(p) {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').replace(/\/$/, '').split('/');
  if (parts.length <= 2) return parts.join('/');
  return parts.slice(-2).join('/');
}

function getWelcomeMarkup() {
  return `<div class="welcome" id="welcome">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/></svg>
    <h2>Claude Remote Control</h2>
    <p>Connected. Send a message below to start.</p>
  </div>`;
}

function clearConversationUi() {
  debugLog('clear_conversation_ui', {
    waiting: S.waiting,
    sessionId: S.sessionId || null,
    lastSeq: S.lastSeq,
    replaying: S.replaying,
  });
  if (S.cacheSaveTimer) {
    clearTimeout(S.cacheSaveTimer);
    S.cacheSaveTimer = null;
  }
  for (const [uploadId, waiter] of S.uploadWaiters) {
    waiter.reject(new Error('Upload reset'));
    S.uploadWaiters.delete(uploadId);
  }
  S.seenUuids.clear();
  S.messageMap.clear();
  S.toolMap.clear();
  S.currentGroup = null;
  S.currentGroupCount = 0;
  S.isAtBottom = true;
  S.waiting = false;
  S.workingEl = null;
  S.waitStartedAt = 0;
  S.lastSeq = 0;
  S.pendingPerms = [];
  S.pendingPlanContent = '';
  questionQueue = [];
  currentQuestions = null;
  currentQuestionIdx = 0;
  $('question-overlay').classList.remove('visible');
  $('plan-overlay').classList.remove('visible');
  resetTodoState();
  clearPendingImage({ abortUpload: false });
  $msgs.innerHTML = getWelcomeMarkup();
  $('input-area').classList.remove('waiting');
  $input.disabled = false;
  $('btn-send').disabled = false;
  $input.placeholder = INPUT_PLACEHOLDER_DEFAULT;
  updateSendBtn();
  updateScrollBtn();
  setConnBanner(false);
  $('perm-overlay').classList.remove('visible');
}


function rebuildRuntimeStateFromDom() {
  S.messageMap.clear();
  S.toolMap.clear();
  S.currentGroup = null;
  S.currentGroupCount = 0;

  $msgs.querySelectorAll('[data-message-id]').forEach(el => {
    if (el.dataset.messageId) S.messageMap.set(el.dataset.messageId, el);
  });

  $msgs.querySelectorAll('.step-item[data-tool-id]').forEach(item => {
    const toolId = item.dataset.toolId;
    if (!toolId) return;
    const detail = document.getElementById(`detail-${toolId}`);
    S.toolMap.set(toolId, {
      item,
      detail,
      name: item.dataset.toolName || '',
      group: item.closest('.step-group'),
    });
  });

  const lastChild = $msgs.lastElementChild;
  if (lastChild && lastChild.classList.contains('step-group')) {
    S.currentGroup = lastChild;
    S.currentGroupCount = lastChild.querySelectorAll('.step-item').length;
  }
}

function getTodoSnapshot() {
  return {
    tasks: Array.from(todoState.tasks.entries()),
    panelOpen: todoState.panelOpen,
  };
}

function restoreTodoSnapshot(snapshot) {
  resetTodoState();
  if (!snapshot || !Array.isArray(snapshot.tasks) || snapshot.tasks.length === 0) return;
  snapshot.tasks.forEach(([taskId, task]) => {
    todoState.tasks.set(String(taskId), task);
  });
  todoState.panelOpen = !!snapshot.panelOpen;
  todoState.autoOpenedForBatch = todoState.tasks.size > 0;
  renderTodoPanel();
  $('todo-panel').classList.toggle('open', todoState.panelOpen && todoState.tasks.size > 0);
}

async function restoreSessionCache(sessionId) {
  debugLog('restore_session_cache_start', { sessionId });
  if (!serverCacheAddr || !sessionId) return false;

  let record;
  try {
    record = await chatCacheRead(buildCacheKey(serverCacheAddr, sessionId));
  } catch {
    return false;
  }
  if (!record || !record.html) {
    debugLog('restore_session_cache_miss', { sessionId });
    return false;
  }

  $msgs.innerHTML = record.html;
  $msgs.querySelectorAll('[data-optimistic], .working-indicator').forEach(el => el.remove());
  S.seenUuids = new Set(Array.isArray(record.seenUuids) ? record.seenUuids : []);
  S.lastSeq = Number.isInteger(record.lastSeq) ? record.lastSeq : 0;
  S.cwd = record.cwd || S.cwd;
  S.model = record.model || '';
  restoreTodoSnapshot({
    tasks: Array.isArray(record.todoTasks) ? record.todoTasks : [],
    panelOpen: !!record.todoPanelOpen,
  });
  rebuildRuntimeStateFromDom();
  removeWorkingIndicator();
  $input.disabled = false;
  $('btn-send').disabled = false;
  $('input-area').classList.remove('waiting');
  $input.placeholder = INPUT_PLACEHOLDER_DEFAULT;
  updateHeaderInfo();
  updateSendBtn();
  updateScrollBtn();
  requestAnimationFrame(() => { $chat.scrollTop = $chat.scrollHeight; });
  debugLog('restore_session_cache_done', {
    sessionId,
    lastSeq: S.lastSeq,
    waiting: S.waiting,
  });
  return true;
}

async function flushSessionCacheSave() {
  if (S.cacheSaveTimer) {
    clearTimeout(S.cacheSaveTimer);
    S.cacheSaveTimer = null;
  }
  await persistSessionCache();
}

async function persistSessionCache() {
  if (!serverCacheAddr || !S.sessionId) return;
  const todoSnapshot = getTodoSnapshot();
  const record = {
    cacheKey: buildCacheKey(serverCacheAddr, S.sessionId),
    serverAddr,
    sessionId: S.sessionId,
    html: buildCacheHtmlSnapshot(),
    seenUuids: Array.from(S.seenUuids),
    todoTasks: todoSnapshot.tasks,
    todoPanelOpen: todoSnapshot.panelOpen,
    cwd: S.cwd,
    model: S.model,
    lastSeq: S.lastSeq,
    updatedAt: Date.now(),
  };
  record.sizeBytes = estimateCacheBytes(record);

  try {
    if (record.sizeBytes > CHAT_CACHE_MAX_SESSION_BYTES) {
      await chatCacheDelete(record.cacheKey).catch(() => {});
      return;
    }
    await chatCacheWrite(record);
    await pruneChatCache();
  } catch (err) {
    console.warn('[chat-cache]', err);
  }
}

function scheduleSessionCacheSave() {
  if (!serverCacheAddr || !S.sessionId) return;
  if (S.cacheSaveTimer) clearTimeout(S.cacheSaveTimer);
  S.cacheSaveTimer = setTimeout(async () => {
    S.cacheSaveTimer = null;
    await persistSessionCache();
  }, 250);
}

function hasOptimisticBubble() {
  return !!$msgs.querySelector('[data-optimistic]');
}

async function syncSessionState(sessionId, serverLastSeq) {
  const syncToken = ++S.sessionSyncToken;
  const prevSessionId = S.sessionId;
  const nextSessionId = sessionId || '';
  const sessionChanged = nextSessionId !== prevSessionId;
  debugLog('sync_session_start', {
    syncToken,
    prevSessionId: prevSessionId || null,
    nextSessionId: nextSessionId || null,
    sessionChanged,
    serverLastSeq,
    waiting: S.waiting,
    lastSeq: S.lastSeq,
    wsState: wsReadyStateName(S.ws),
    hidden: typeof document !== 'undefined' ? !!document.hidden : null,
    online: typeof navigator !== 'undefined' && 'onLine' in navigator ? !!navigator.onLine : null,
  });
  S.replaying = true;

  if (sessionChanged) {
    S.sessionId = nextSessionId;
    S.model = '';
    const shouldKeepOptimisticUi = !prevSessionId && hasOptimisticBubble();
    if (shouldKeepOptimisticUi) {
      debugLog('sync_session_keep_optimistic', {
        syncToken,
        nextSessionId: nextSessionId || null,
      });
      rebuildRuntimeStateFromDom();
      updateHeaderInfo();
      scheduleSessionCacheSave();
    } else {
      debugLog('sync_session_clear_ui', {
        syncToken,
        nextSessionId: nextSessionId || null,
      });
      clearConversationUi();
    }
    if (nextSessionId && !shouldKeepOptimisticUi) {
      const restored = await restoreSessionCache(nextSessionId);
      if (!restored) updateHeaderInfo();
    }
  }

  if (syncToken !== S.sessionSyncToken) return;

  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  if (S.resumeRequestedFor === nextSessionId) return;

  S.resumeRequestedFor = nextSessionId;
  debugLog('sync_session_resume_request', {
    syncToken,
    sessionId: nextSessionId || null,
    lastSeq: nextSessionId ? S.lastSeq : 0,
    serverLastSeq: Number.isInteger(serverLastSeq) ? serverLastSeq : null,
    wsState: wsReadyStateName(S.ws),
    hidden: typeof document !== 'undefined' ? !!document.hidden : null,
    online: typeof navigator !== 'undefined' && 'onLine' in navigator ? !!navigator.onLine : null,
  });
  S.ws.send(JSON.stringify({
    type: 'resume',
    sessionId: nextSessionId || null,
    lastSeq: nextSessionId ? S.lastSeq : 0,
    serverLastSeq: Number.isInteger(serverLastSeq) ? serverLastSeq : null,
  }));
}

function formatModel(m) {
  if (!m) return '';
  return m.replace(/^claude-/, '').replace(/-(\d)/g, ' $1').replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function updateHeaderInfo() {
  const pathStr = shortenPath(S.cwd);
  const model = formatModel(S.model);
  $('title').textContent = pathStr || 'Claude Remote';
  $('header-model').textContent = model;
}

// ============================================================
//  Tool Icons (SVG)
// ============================================================
const ICONS = {
  Bash:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 17l6-6-6-6"/><path d="M12 19h8"/></svg>',
  Read:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  Edit:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  Write:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  Glob:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>',
  Grep:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>',
  WebFetch:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  WebSearch:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  Task:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
};
function iconFor(name) { return ICONS[name] || ICONS.Bash; }

function toolDesc(name, input) {
  if (!input) return '';
  switch (name) {
    case 'Bash': return input.description || input.command || '';
    case 'Read': return input.file_path || '';
    case 'Write': return input.file_path || '';
    case 'Edit': return input.file_path || '';
    case 'Glob': return input.pattern || '';
    case 'Grep': return input.pattern || '';
    case 'WebFetch': return input.url || '';
    case 'WebSearch': return input.query || '';
    case 'Task': return input.description || input.prompt || '';
    default: return JSON.stringify(input).substring(0, 80);
  }
}

function toolInputFull(name, input) {
  if (!input) return '';
  switch (name) {
    case 'Bash': return input.command || '';
    case 'Read': return input.file_path || '';
    case 'Write': return `${input.file_path || ''}\n${'─'.repeat(30)}\n${trunc(input.content, 800)}`;
    case 'Edit': {
      let s = (input.file_path || '') + '\n';
      if (input.old_string !== undefined) s += `- ${trunc(input.old_string, 300)}\n+ ${trunc(input.new_string, 300)}`;
      return s;
    }
    case 'Glob': return `pattern: ${input.pattern}${input.path ? '\npath: ' + input.path : ''}`;
    case 'Grep': return `pattern: ${input.pattern}${input.path ? '\npath: ' + input.path : ''}`;
    case 'WebFetch': return `${input.url}\n${input.prompt || ''}`;
    case 'WebSearch': return input.query || '';
    case 'Task': return `[${input.subagent_type || 'agent'}] ${input.description || ''}\n${trunc(input.prompt, 300)}`;
    default: return JSON.stringify(input, null, 2);
  }
}

// ============================================================
//  Diff Rendering
// ============================================================
function buildDiffHtml(oldStr, newStr, filePath, startLine) {
  const lineOffset = (startLine || 1) - 1;
  const oldLines = (oldStr || '').split('\n');
  const newLines = (newStr || '').split('\n');

  // Simple LCS-based diff
  const m = oldLines.length, n = newLines.length;
  // Optimisation: limit to reasonable size to avoid O(m*n) blowup
  if (m * n > 500000) {
    // Fallback: show all old as deleted, all new as added
    return buildDiffFallback(oldLines, newLines, filePath, lineOffset);
  }

  // Build LCS table
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);

  // Backtrack to produce diff ops
  const ops = []; // { type: 'ctx'|'del'|'add', text, oldLn?, newLn? }
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: 'ctx', text: oldLines[i - 1], oldLn: i, newLn: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'add', text: newLines[j - 1], newLn: j });
      j--;
    } else {
      ops.push({ type: 'del', text: oldLines[i - 1], oldLn: i });
      i--;
    }
  }
  ops.reverse();

  return renderDiffOps(ops, filePath, lineOffset);
}

function buildDiffFallback(oldLines, newLines, filePath, lineOffset) {
  const ops = [];
  oldLines.forEach((l, i) => ops.push({ type: 'del', text: l, oldLn: i + 1 }));
  newLines.forEach((l, i) => ops.push({ type: 'add', text: l, newLn: i + 1 }));
  return renderDiffOps(ops, filePath, lineOffset || 0);
}

function renderDiffOps(ops, filePath, lineOffset) {
  const off = lineOffset || 0;
  let addCount = 0, delCount = 0;
  ops.forEach(o => { if (o.type === 'add') addCount++; if (o.type === 'del') delCount++; });

  let rows = '';
  for (const o of ops) {
    const cls = o.type === 'del' ? 'diff-del' : o.type === 'add' ? 'diff-add' : 'diff-ctx';
    const sign = o.type === 'del' ? '-' : o.type === 'add' ? '+' : ' ';
    // Single line number column with source file offset
    const rawLn = o.type === 'del' ? (o.oldLn || '') : (o.newLn || o.oldLn || '');
    const ln = rawLn !== '' ? rawLn + off : '';
    rows += `<tr class="${cls}"><td class="diff-ln">${ln}</td><td class="diff-sign">${sign}</td><td class="diff-code">${esc(o.text)}</td></tr>`;
  }

  const shortPath = shortenPath(filePath);

  return `<div class="diff-view">
    <div class="diff-header">
      <svg class="diff-file-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
      <span class="diff-file-path" title="${esc(filePath)}">${esc(shortPath)}</span>
      <span class="diff-stats"><span class="ds-add">+${addCount}</span> <span class="ds-del">-${delCount}</span></span>
    </div>
    <div class="diff-body"><table class="diff-table">${rows}</table></div>
  </div>`;
}

// ============================================================
//  Rendering — step group management
// ============================================================
function closeGroup() {
  if (S.currentGroup) {
    S.currentGroup.querySelector('.step-count').textContent = S.currentGroupCount + ' steps';
    S.currentGroup = null;
    S.currentGroupCount = 0;
  }
}

function ensureGroup() {
  if (!S.currentGroup) {
    const g = document.createElement('div');
    g.className = 'step-group open';
    g.innerHTML = `
      <div class="step-group-header">
        <span class="step-chevron"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></span>
        <span class="step-count">steps</span>
      </div>
      <div class="step-list"></div>
    `;
    $msgs.appendChild(g);
    S.currentGroup = g;
    S.currentGroupCount = 0;
  }
  return S.currentGroup.querySelector('.step-list');
}

// ============================================================
//  Event Processing
// ============================================================
const JUNK_PATTERNS = [
  /^Caveat:/i,
  /^<local-command/,
  /^<command-name>/,
  /^<command-message>/,
  /^<command-args>/,
  /^<local-command-stdout>/,
  /^<\/local-command/,
];

function isJunkContent(content) {
  if (typeof content !== 'string') return false;
  const t = content.trim();
  if (/^\/[a-z]+$/i.test(t)) return true;
  if (/^Set model to/i.test(t) || /Set model to/i.test(t.replace(/\x1B\[[0-9;]*m/g, ''))) return true;
  return JUNK_PATTERNS.some(p => p.test(t));
}

function processEvent(evt, seq) {
  try {
    if (!evt) return;
    if (Number.isInteger(seq) && seq > S.lastSeq) S.lastSeq = seq;
    if (S.seenUuids.has(evt.uuid)) return;
    if (evt.uuid) S.seenUuids.add(evt.uuid);
    removeWelcome();

    // Compact summary: collapse all previous messages
    if (evt.isCompactSummary) {
      renderCompactSummary(evt);
      scrollEnd();
      return;
    }

    // Local command results (e.g. /cost)
    if (evt.type === 'system' && evt.subtype === 'local_command') {
      const raw = (evt.content || '').replace(/<\/?local-command-stdout>/g, '').replace(/\x1B\[[0-9;]*m/g, '').trim();
      if (raw.includes('Total cost:')) {
        renderCostCard(raw);
        scrollEnd();
      }
      return;
    }

    if (evt.type === 'user' && evt.message) {
      const c = evt.message.content;
      if (typeof c === 'string' && isJunkContent(c)) return;
      // Hide "[Request interrupted by user...]" carry-over from session switch
      if (typeof c === 'string' && /^\[Request interrupted by user/.test(c.trim())) return;
      if (Array.isArray(c) && c.length === 1 && c[0].type === 'text' &&
          /^\[Request interrupted by user/.test(c[0].text)) return;
      // Plan mode: render plan card instead of raw "Implement the following plan:" message
      const planPrefix = 'Implement the following plan:';
      const rawText = typeof c === 'string' ? c
        : (Array.isArray(c) && c.length >= 1 && c[0].type === 'text' ? c[0].text : '');
      if (rawText.trimStart().startsWith(planPrefix)) {
        // Extract the plan markdown (everything after the prefix, before the transcript hint)
        let planBody = rawText.trimStart().slice(planPrefix.length).trim();
        // Strip the trailing "If you need specific details..." boilerplate
        const boilerplateIdx = planBody.indexOf('\nIf you need specific details from before exiting plan mode');
        if (boilerplateIdx !== -1) planBody = planBody.slice(0, boilerplateIdx).trim();
        if (planBody) {
          renderPlanCard(planBody);
          return;
        }
      }
    }
    if (evt.type === 'assistant' && evt.message) {
      const blocks = evt.message.content;
      if (Array.isArray(blocks) && blocks.length === 1 && blocks[0].type === 'text') {
        const txt = blocks[0].text;
        if (isJunkContent(txt)) return;
      }
    }

    if (evt.type === 'user' && evt.message) renderUser(evt);
    else if (evt.type === 'assistant' && evt.message) {
      // Switch from "Thinking" to "Working" on first assistant response
      if (S.waiting) switchToWorking();
      renderAssistant(evt);
    }
    scrollEnd();
    scheduleSessionCacheSave();
  } catch (e) {
    console.error('[processEvent]', e);
  }
}

// --- User ---
function renderUser(evt) {
  const c = evt.message.content;
  if (Array.isArray(c)) {
    const imageBlocks = c.filter(b => b && b.type === 'image');
    const textBlocks = c.filter(b => b && b.type === 'text' && b.text);
    if (imageBlocks.length > 0 || textBlocks.length > 0) {
      closeGroup();
      const opt = $msgs.querySelector('[data-optimistic]');
      if (opt) { opt.removeAttribute('data-optimistic'); return; }

      const el = document.createElement('div');
      el.className = 'user-msg';
      let html = '';
      if (imageBlocks.length > 0) {
        html += imageBlocks.map(block => {
          const source = block.source && block.source.type === 'base64' ? block.source : null;
          if (!source || !source.data) return '';
          const mediaType = source.media_type || 'image/png';
          return `<img src="data:${mediaType};base64,${source.data}" style="max-width:200px;max-height:120px;border-radius:8px;display:block;margin-bottom:${textBlocks.length ? '6px' : '0'}">`;
        }).join('');
      }
      if (textBlocks.length > 0) {
        const cleaned = textBlocks.map(block => stripImageTags(block.text)).filter(Boolean);
        if (cleaned.length > 0) {
          html += cleaned.map(t => esc(t).replace(/\n/g, '<br>')).join('<br>');
        }
      }
      if (html) {
        el.innerHTML = html;
        $msgs.appendChild(el);
      }
      return;
    }
    for (const b of c) {
      if (b.type === 'tool_result') {
        handleTodoToolResult(b, evt);
        attachResult(b);
      }
    }
    return;
  }
  if (typeof c === 'string') {
    const cleaned = stripImageTags(c);
    if (cleaned.trim()) {
      closeGroup();
      const opt = $msgs.querySelector('[data-optimistic]');
      if (opt) { opt.removeAttribute('data-optimistic'); return; }
      const el = document.createElement('div');
      el.className = 'user-msg';
      el.innerHTML = esc(cleaned).replace(/\n/g, '<br>');
      $msgs.appendChild(el);
    }
  }
}

// --- Cost Card ---
function renderCostCard(raw) {
  closeGroup();
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

  // Parse fields
  let totalCost = '', apiDuration = '', wallDuration = '', codeChanges = '';
  const models = [];
  let inModels = false;

  for (const line of lines) {
    if (line.startsWith('Total cost:')) totalCost = line.replace('Total cost:', '').trim();
    else if (line.startsWith('Total duration (API):')) apiDuration = line.replace('Total duration (API):', '').trim();
    else if (line.startsWith('Total duration (wall):')) wallDuration = line.replace('Total duration (wall):', '').trim();
    else if (line.startsWith('Total code changes:')) codeChanges = line.replace('Total code changes:', '').trim();
    else if (line.startsWith('Usage by model:')) inModels = true;
    else if (inModels) {
      // e.g. "claude-opus-4-6:  3 input, 295 output, 10.5k cache read, 13.7k cache write ($0.0983)"
      const m = line.match(/^(.+?):\s*(.+)\((\$[\d.]+)\)\s*$/);
      if (m) {
        models.push({ name: m[1].trim(), detail: m[2].trim().replace(/,\s*$/, ''), cost: m[3] });
      } else {
        // fallback: model line without cost in parens
        const m2 = line.match(/^(.+?):\s*(.+)$/);
        if (m2) models.push({ name: m2[1].trim(), detail: m2[2].trim(), cost: '' });
      }
    }
  }

  const el = document.createElement('div');
  el.className = 'cost-card';
  el.innerHTML = `
    <div class="cost-header">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
      <span>费用概览</span>
    </div>
    <div class="cost-grid">
      <div class="cost-item">
        <div class="cost-label">总费用</div>
        <div class="cost-value cost-highlight">${esc(totalCost)}</div>
      </div>
      <div class="cost-item">
        <div class="cost-label">API 耗时</div>
        <div class="cost-value">${esc(apiDuration)}</div>
      </div>
      <div class="cost-item">
        <div class="cost-label">实际耗时</div>
        <div class="cost-value">${esc(wallDuration)}</div>
      </div>
      <div class="cost-item">
        <div class="cost-label">代码变更</div>
        <div class="cost-value">${esc(codeChanges)}</div>
      </div>
    </div>
    ${models.length ? `
    <div class="cost-models">
      <div class="cost-models-title">模型用量</div>
      ${models.map(m => `
        <div class="cost-model-row">
          <div class="cost-model-name">${esc(m.name)}</div>
          <div class="cost-model-detail">${esc(m.detail)}</div>
          ${m.cost ? `<div class="cost-model-cost">${esc(m.cost)}</div>` : ''}
        </div>
      `).join('')}
    </div>` : ''}
  `;
  $msgs.appendChild(el);
}

// --- Plan Card (shown at top of new session after plan mode option 1) ---
function renderPlanCard(planContent) {
  // Avoid duplicates
  if ($msgs.querySelector('.plan-inline-card')) return;
  closeGroup();
  const el = document.createElement('div');
  el.className = 'plan-inline-card';
  el.innerHTML = `
    <div class="plan-inline-header">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12l2 2 4-4"/></svg>
      <span>执行计划</span>
    </div>
    <div class="plan-inline-body">${renderMd(planContent)}</div>
  `;
  $msgs.appendChild(el);
}

function normalizePlanContent(plan) {
  return String(plan || '').trim();
}

function consumePendingPlanCard() {
  const plan = normalizePlanContent(S.pendingPlanContent);
  S.pendingPlanContent = '';
  if (!plan) return;
  renderPlanCard(plan);
  scrollEnd();
  scheduleSessionCacheSave();
}

// --- Compact Summary ---
function renderCompactSummary(evt) {
  // Dismiss the command overlay
  hideCmdOverlay();
  $('input-area').classList.remove('waiting');
  if (S.waiting) setWaiting(false, 'compact_summary');

  // Collapse all previous messages into one indicator
  closeGroup();
  S.messageMap.clear();
  S.toolMap.clear();
  S.currentGroup = null;
  S.currentGroupCount = 0;
  $msgs.innerHTML = '';

  const el = document.createElement('div');
  el.className = 'compact-divider';
  el.innerHTML = `
    <div class="compact-line"></div>
    <div class="compact-badge">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.66 0 3-4.03 3-9s-1.34-9-3-9m0 18c-1.66 0-3-4.03-3-9s1.34-9 3-9"/></svg>
      <span>历史对话已压缩</span>
    </div>
    <div class="compact-line"></div>
  `;
  $msgs.appendChild(el);
}

const HIDDEN_STEP_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'AskUserQuestion', 'ExitPlanMode']);

// --- Assistant ---
function renderAssistant(evt) {
  const blocks = evt.message.content || [];
  const msgId = evt.message.id;
  const usage = evt.message.usage;

  syncConfirmedModel(evt.message.model, { allowToast: true });

  for (const b of blocks) {
    try {
      if (b.type === 'thinking' && b.thinking) renderThinking(b);
      else if (b.type === 'text' && b.text) { closeGroup(); renderText(b.text, msgId); }
      else if (b.type === 'tool_use') {
        const toolName = b.name || '';
        // Todo tools — intercept for panel state
        if (isTodoTool(toolName)) {
          handleTodoToolUse(b);
        }
        if (toolName === 'AskUserQuestion' && b.input && b.input.questions) {
          if (!S.replaying) showQuestion(b.input.questions);
        } else if (toolName === 'ExitPlanMode') {
          if (S.replaying) {
            const plan = normalizePlanContent(b.input?.plan || '');
            if (plan) renderPlanCard(plan);
          } else {
            showPlanApproval(b.input);
          }
        } else if (!HIDDEN_STEP_TOOLS.has(toolName)) {
          renderTool(b);
        }
      }
    } catch (e) {
      console.error('[renderBlock]', e);
    }
  }

  if (usage && evt.message.stop_reason) {
    const total = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) +
                  (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0);
    if (total > 0 && S.currentGroup) {
      let tc = S.currentGroup.querySelector('.token-count');
      if (!tc) {
        tc = document.createElement('div');
        tc.className = 'token-count';
        S.currentGroup.appendChild(tc);
      }
      tc.textContent = formatTokens(total);
    }
  }
}

function renderText(text, msgId) {
  let el = S.messageMap.get(msgId);
  if (!el) {
    el = document.createElement('div');
    el.className = 'assistant-text';
    if (msgId) el.dataset.messageId = msgId;
    S.messageMap.set(msgId, el);
    $msgs.appendChild(el);
  }
  const d = document.createElement('div');
  d.innerHTML = renderMd(text);
  el.appendChild(d);
}

function renderThinking(b) {
  closeGroup();
  const el = document.createElement('div');
  el.className = 'thinking';
  const preview = trunc(b.thinking.replace(/\n/g, ' '), 60);
  el.innerHTML = `
    <div class="thinking-toggle">
      <span class="thinking-chevron"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></span>
      <span>Thinking</span>
      <span style="color:var(--text-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">${esc(preview)}</span>
    </div>
    <div class="thinking-content">${esc(b.thinking)}</div>
  `;
  $msgs.appendChild(el);
}

function renderTool(b) {
  const list = ensureGroup();
  S.currentGroupCount++;
  S.currentGroup.querySelector('.step-count').textContent = S.currentGroupCount + ' steps';

  const desc = toolDesc(b.name, b.input);
  const item = document.createElement('div');
  item.className = 'step-item loading';
  item.dataset.toolId = b.id || '';
  item.dataset.toolName = b.name || '';
  item.innerHTML = `
    <div class="step-icon">${iconFor(b.name)}</div>
    <span class="step-name">${esc(b.name)}</span>
    <span class="step-desc">${esc(trunc(desc, 40))}</span>
    <span class="step-duration" id="dur-${b.id}"></span>
    <span class="step-arrow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></span>
  `;

  const detail = document.createElement('div');
  detail.className = 'step-detail';
  detail.id = `detail-${b.id}`;
  const inputFull = toolInputFull(b.name, b.input);

  // Edit tool: render diff view (no result text — pure diff only)
  const isEdit = b.name === 'Edit' && b.input && b.input.old_string !== undefined;
  if (isEdit) {
    detail.innerHTML = buildDiffHtml(b.input.old_string, b.input.new_string, b.input.file_path, b.input._startLine);
  } else {
    detail.innerHTML = `
      <div class="detail-input">${esc(inputFull)}</div>
      <div class="detail-result" id="result-${b.id}"></div>
    `;
  }

  list.appendChild(item);
  list.appendChild(detail);

  S.toolMap.set(b.id, { item, detail, name: b.name, group: S.currentGroup });
}

function attachResult(b) {
  const info = S.toolMap.get(b.tool_use_id);
  if (!info) return;

  // Stop loading animation
  info.item.classList.remove('loading');

  const isErr = b.is_error === true;
  if (isErr) info.detail.classList.add('error');

  let text = '';
  let images = [];
  if (typeof b.content === 'string') {
    text = b.content;
  } else if (Array.isArray(b.content)) {
    const textParts = [];
    for (const c of b.content) {
      if (c.type === 'image' && c.source && c.source.data) {
        const mediaType = c.source.media_type || 'image/png';
        images.push({ data: c.source.data, mediaType });
      } else if (c.text) {
        textParts.push(c.text);
      } else {
        textParts.push(JSON.stringify(c));
      }
    }
    text = textParts.join('\n');
  }

  const resultEl = info.detail.querySelector('.detail-result');
  if (resultEl) {
    resultEl.textContent = trunc(text, 3000);
    if (isErr) resultEl.style.color = 'var(--error)';
  }

  // Render images as top-level blocks (same level as assistant-text)
  if (images.length > 0) {
    closeGroup();
    for (const img of images) {
      const wrapper = document.createElement('div');
      wrapper.className = 'result-image-block';
      const imgEl = document.createElement('img');
      imgEl.src = `data:${img.mediaType};base64,${img.data}`;
      imgEl.addEventListener('click', () => showImageOverlay(imgEl.src));
      wrapper.appendChild(imgEl);
      $msgs.appendChild(wrapper);
    }
    scrollEnd();
  }
}

function showImageOverlay(src) {
  let overlay = document.getElementById('image-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'image-overlay';
    overlay.className = 'image-overlay';
    overlay.addEventListener('click', () => overlay.classList.remove('visible'));
    overlay.innerHTML = '<img>';
    document.body.appendChild(overlay);
  }
  overlay.querySelector('img').src = src;
  overlay.classList.add('visible');
}

// ============================================================
//  Slash Commands
// ============================================================
const COMMANDS = [
  { name: '/model', desc: 'Switch model', icon: '\u2699' },
  { name: '/cost', desc: 'Show token costs', icon: '$' },
  { name: '/compact', desc: 'Compact context', icon: '\u229E' },
  { name: '/clear', desc: 'Clear conversation', icon: '\u2715' },
  { name: '/help', desc: 'Show help', icon: '?' },
];

const MODELS = [
  { num: '1', id: 'default', label: 'Default (Sonnet 4.6)', desc: 'Recommended' },
  { num: '2', id: 'sonnet-1m', label: 'Sonnet (1M context)', desc: 'Long sessions' },
  { num: '3', id: 'opus', label: 'Opus', desc: 'Most capable' },
  { num: '4', id: 'opus-1m', label: 'Opus (1M context)', desc: 'Long sessions' },
  { num: '5', id: 'haiku', label: 'Haiku', desc: 'Fast answers' },
];

let cmdMenuOpen = false;
let cmdActiveIdx = -1;

function showCmdMenu(filter) {
  const menu = $('cmd-menu');
  const items = COMMANDS.filter(c => c.name.includes(filter.toLowerCase()));
  if (items.length === 0) { hideCmdMenu(); return; }

  menu.innerHTML = items.map((c, i) =>
    `<div class="cmd-item${i === 0 ? ' active' : ''}" data-cmd="${c.name}">
      <div class="cmd-icon">${c.icon}</div>
      <div><div class="cmd-name">${c.name}</div><div class="cmd-desc">${c.desc}</div></div>
    </div>`
  ).join('');

  menu.querySelectorAll('.cmd-item').forEach(el => {
    el.addEventListener('click', () => execCmd(el.dataset.cmd));
  });

  cmdActiveIdx = 0;
  cmdMenuOpen = true;
  menu.classList.add('visible');
}

function hideCmdMenu() {
  $('cmd-menu').classList.remove('visible');
  cmdMenuOpen = false;
  cmdActiveIdx = -1;
}

const CMD_FEEDBACK = {
  '/compact': { toast: null, overlay: true, label: '对话压缩中...' },
  '/clear':   { toast: 'Clearing conversation...', overlay: false },
  '/cost':    { toast: 'Fetching token costs...', overlay: false },
  '/help':    { toast: 'Loading help...', overlay: false },
};

function normalizeSlashCommandInput(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const match = value.match(/^(\/[^\s]+)/);
  if (!match || match[0] !== value) return '';
  return match[1].toLowerCase();
}

function execCmd(cmd) {
  cmd = normalizeSlashCommandInput(cmd) || String(cmd || '').trim().toLowerCase();
  hideCmdMenu();
  $input.value = '';
  $input.style.height = 'auto';
  updateSendBtn();

  if (cmd === '/model') {
    showModelPicker();
    return;
  }

  // /cost: show user bubble then wait for JSONL event
  if (cmd === '/cost') {
    closeGroup();
    const el = document.createElement('div');
    el.className = 'user-msg';
    el.textContent = '/cost';
    $msgs.appendChild(el);
    scrollEnd();
    sendSlashCmd(cmd);
    return;
  }

  // /clear: immediately clear the conversation UI — don't wait for the
  // server-side session switch detection, which may be slow or fail.
  if (cmd === '/clear') {
    clearConversationUi();
    S.sessionId = '';
    S.resumeRequestedFor = '';
    sendSlashCmd(cmd);
    return;
  }

  const fb = CMD_FEEDBACK[cmd];
  if (fb) {
    if (fb.overlay) showCmdOverlay(fb.label);
    else if (fb.toast) showToast(fb.toast);
  }
  sendSlashCmd(cmd);
}

function sendSlashCmd(text) {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  S.ws.send(JSON.stringify({ type: 'chat', text }));
}

function sendControlInput(data) {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  S.ws.send(JSON.stringify({ type: 'input', data: String(data) }));
}

function sendControlEnter() {
  sendControlInput('\r');
}

function sendControlLine(text, { startDelayMs = 0, submitDelayMs = 120 } = {}) {
  setTimeout(() => {
    if (S.ws?.readyState === WebSocket.OPEN) sendControlInput(text);
  }, startDelayMs);
  setTimeout(() => {
    if (S.ws?.readyState === WebSocket.OPEN) sendControlEnter();
  }, startDelayMs + submitDelayMs);
}

// ============================================================
//  Command Overlay (blocking spinner for /compact etc.)
// ============================================================
function showCmdOverlay(label) {
  let ov = $('cmd-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'cmd-overlay';
    ov.innerHTML = `
      <div class="cmd-overlay-card">
        <div class="cmd-overlay-spinner"></div>
        <span class="cmd-overlay-label"></span>
      </div>
    `;
    document.getElementById('app').appendChild(ov);
  }
  ov.querySelector('.cmd-overlay-label').textContent = label;
  ov.classList.add('visible');
  $('input-area').classList.add('waiting');
}

function hideCmdOverlay() {
  const ov = $('cmd-overlay');
  if (ov) ov.classList.remove('visible');
}

function showModelPicker() {
  const list = $('model-list');
  list.innerHTML = MODELS.map(m =>
    `<div class="model-item" data-num="${m.num}">
      <span class="mi-num">${m.num}</span>
      <div class="mi-info">
        <span class="mi-name">${m.label}</span>
        <span class="mi-desc">${m.desc}</span>
      </div>
    </div>`
  ).join('');

  list.querySelectorAll('.model-item').forEach(el => {
    el.addEventListener('click', () => {
      const picked = MODELS.find(m => m.num === el.dataset.num);
      hideModelPicker();
      if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
      showToast('Switching to ' + (picked ? picked.label : 'model') + '...');
      sendControlInput('\x1b');
      setTimeout(() => {
        if (S.ws?.readyState === WebSocket.OPEN) sendSlashCmd('/model');
      }, 250);
      sendControlLine(el.dataset.num, { startDelayMs: 2400, submitDelayMs: 140 });
    });
  });

  $('model-picker').classList.add('visible');
}

function hideModelPicker() {
  $('model-picker').classList.remove('visible');
}
$('model-picker').addEventListener('click', e => {
  if (e.target === $('model-picker')) hideModelPicker();
});

// ============================================================
//  Input
// ============================================================
$input.addEventListener('input', () => {
  $input.style.height = 'auto';
  $input.style.height = Math.min($input.scrollHeight, 120) + 'px';
  updateSendBtn();

  const val = $input.value;
  if (val.startsWith('/') && !val.includes(' ') && val.length > 0) {
    showCmdMenu(val);
  } else {
    hideCmdMenu();
  }
});
$input.addEventListener('keydown', e => {
  if (cmdMenuOpen) {
    const items = $('cmd-menu').querySelectorAll('.cmd-item');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[cmdActiveIdx]?.classList.remove('active');
      if (e.key === 'ArrowDown') cmdActiveIdx = Math.min(cmdActiveIdx + 1, items.length - 1);
      else cmdActiveIdx = Math.max(cmdActiveIdx - 1, 0);
      items[cmdActiveIdx]?.classList.add('active');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const active = items[cmdActiveIdx];
      if (active) execCmd(active.dataset.cmd);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      hideCmdMenu();
      return;
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
$('btn-send').addEventListener('click', send);
$('btn-scroll').addEventListener('click', () => { $chat.scrollTop = $chat.scrollHeight; });

// ============================================================
//  Image Upload
// ============================================================
$('btn-image').addEventListener('click', () => {
  if (S.waiting) return;
  $('image-file-input').click();
});

$('image-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = ''; // reset so same file can be re-selected

  if (!file.type.startsWith('image/')) {
    showToast('Please select an image file');
    return;
  }

  if (file.size > MAX_IMAGE_BYTES) {
    showToast('Image too large (max 4MB)');
    return;
  }
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN || !S.authenticated) {
    showToast('Connection unavailable');
    return;
  }

  clearPendingImage();
  const previewUrl = await fileToDataUrl(file);
  pendingImage = {
    file,
    mediaType: file.type || 'image/png',
    name: file.name,
    previewUrl,
    uploadId: makeUploadId(),
    status: 'uploading',
    progress: 0,
    uploadedBytes: 0,
    totalBytes: file.size,
    submitQueued: false,
    queuedText: '',
  };
  updateImagePreviewUi();
  updateSendBtn();

  try {
    await startImageUpload(pendingImage);
  } catch (err) {
    if (pendingImage) {
      const wasQueued = pendingImage.submitQueued;
      pendingImage.status = 'failed';
      updateImagePreviewUi();
      if (wasQueued && S.waiting) setWaiting(false, 'image_upload_failed');
    }
    showToast(err.message || 'Image upload failed');
  }
});

$('image-preview-remove').addEventListener('click', () => {
  clearPendingImage();
});

updateImagePreviewUi();
updateSendBtn();

// Back button — disconnect and return to connect screen
$('btn-back').addEventListener('click', () => {
  (async () => {
    const hadWs = !!S.ws;
    S.intentionalDisconnect = hadWs;
    S.skipNextCloseHandling = hadWs;
    await flushSessionCacheSave().catch(() => {});
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

function resetAppState() {
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
  $input.value = '';
  updateHeaderInfo();
  $('perm-overlay').classList.remove('visible');
}

function send() {
  const t = $input.value.trim();
  const hasImage = !!pendingImage;
  if ((!t && !hasImage) || !S.ws || S.ws.readyState !== WebSocket.OPEN || !S.authenticated || S.waiting) return;
  debugLog('send_invoked', {
    hasImage,
    textPreview: t.slice(0, 80),
    sessionId: S.sessionId || null,
    waiting: S.waiting,
  });

  // Intercept slash commands typed directly (only when no image)
  const slashCommand = normalizeSlashCommandInput(t);
  if (!hasImage && COMMANDS.some(command => command.name === slashCommand)) {
    execCmd(slashCommand);
    return;
  }

  removeWelcome(); closeGroup();

  // Show user message bubble (with image thumbnail if present)
  const el = document.createElement('div');
  el.className = 'user-msg'; el.dataset.optimistic = '1';
  let html = '';
  if (hasImage) {
    if (pendingImage.status === 'failed') {
      showToast('Image upload failed. Re-select the image and try again.');
      return;
    }
    html += `<img src="${pendingImage.previewUrl}" style="max-width:200px;max-height:120px;border-radius:8px;display:block;margin-bottom:${t ? '6px' : '0'}">`;
  }
  if (t) html += esc(t).replace(/\n/g, '<br>');
  el.innerHTML = html;
  $msgs.appendChild(el);
  S.isAtBottom = true; scrollEnd();
  scheduleSessionCacheSave();

  if (hasImage) {
    pendingImage.submitQueued = true;
    pendingImage.queuedText = t || '';
  } else {
    S.ws.send(JSON.stringify({ type: 'chat', text: t }));
  }

  $input.value = ''; $input.style.height = 'auto';

  if (hasImage && pendingImage.status === 'uploaded') {
    submitPendingImageUpload().catch(err => {
      if (pendingImage) {
        pendingImage.status = 'failed';
        updateImagePreviewUi();
      }
      setWaiting(false, 'image_submit_failed');
      showToast(err.message || 'Image submit failed');
    });
  }
}

// ============================================================
//  WebSocket
// ============================================================
function connect() {
  let ws;
  let connectErrorShown = false;
  const isCurrentSocket = () => S.ws === ws;
  const failConnect = (message) => {
    if (connectErrorShown) return;
    connectErrorShown = true;
    hideHubConnectOverlay();
    renderHubCards();
    showToast(message);
  };
  try {
    ws = new WebSocket(serverWsUrl);
  } catch (e) {
    failConnect('Invalid server address');
    return;
  }
  S.ws = ws;
  S.authenticated = false;
  S.resumeRequestedFor = '';
  S.replaying = true;
  debugLog('ws_connect_start', {
    serverWsUrl,
    sessionId: S.sessionId || null,
    hidden: typeof document !== 'undefined' ? !!document.hidden : null,
    online: typeof navigator !== 'undefined' && 'onLine' in navigator ? !!navigator.onLine : null,
  });

  const connectTimeout = setTimeout(() => {
    if (!isCurrentSocket()) return;
    if (ws.readyState !== WebSocket.OPEN) {
      ws.close();
      failConnect('Connection timed out');
    }
  }, 8000);

  ws.onopen = () => {
    clearTimeout(connectTimeout);
    if (!isCurrentSocket()) {
      try { ws.close(); } catch {}
      return;
    }
    clearForegroundProbe('ws_open');
    S.lastMessageAt = Date.now();
    S.intentionalDisconnect = false;
    S.skipNextCloseHandling = false;
    setStatus('starting');
    ws.send(JSON.stringify({
      type: 'hello',
      clientInstanceId: CLIENT_INSTANCE_ID,
      token: serverToken || '',
      page: location.pathname || '/',
      userAgent: navigator.userAgent || '',
    }));
    debugLog('ws_open', {
      sessionId: S.sessionId || null,
      waiting: S.waiting,
      replaying: S.replaying,
      wsState: wsReadyStateName(ws),
      hidden: typeof document !== 'undefined' ? !!document.hidden : null,
      online: typeof navigator !== 'undefined' && 'onLine' in navigator ? !!navigator.onLine : null,
    });
    flushPendingDebugLogs();
    // Sync approval mode to server
    ws.send(JSON.stringify({ type: 'set_approval_mode', mode: approvalMode }));
  };

  ws.onmessage = async e => {
    if (!isCurrentSocket()) return;
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    S.lastMessageAt = Date.now();
    if (m.type === 'auth_ok' || m.type === 'status' || m.type === 'transcript_ready' || m.type === 'replay_done' ||
        m.type === 'turn_state' || m.type === 'pty_exit') {
      debugLog('ws_message', {
        type: m.type,
        sessionId: 'sessionId' in m ? (m.sessionId ?? null) : null,
        lastSeq: Number.isInteger(m.lastSeq) ? m.lastSeq : null,
        waiting: S.waiting,
        replaying: S.replaying,
        wsState: wsReadyStateName(ws),
      });
    }
    try {
      if (!S.authenticated && isAuthReadyMessage(m)) {
        finalizeAuthenticatedConnection();
      }
      if (!S.authenticated) return;
      if (m.type === 'auth_ok') return;
      if (m.type === 'pty_output') { /* ignored — no terminal panel */ }
      else if (m.type === 'log_event') processEvent(m.event, m.seq);
      else if (m.type === 'image_upload_status') handleUploadStatus(m);
      else if (m.type === 'foreground_probe_ack') {
        if (!m.probeId || m.probeId !== S.foregroundProbeId) {
          debugLog('foreground_probe_ack_ignored', {
            probeId: m.probeId || '',
            expectedProbeId: S.foregroundProbeId || '',
            sessionId: 'sessionId' in m ? (m.sessionId ?? null) : null,
            lastSeq: Number.isInteger(m.lastSeq) ? m.lastSeq : null,
            wsState: wsReadyStateName(ws),
          });
          return;
        }
        clearForegroundProbe('ack');
        debugLog('foreground_probe_ack', {
          probeId: m.probeId || '',
          sessionId: 'sessionId' in m ? (m.sessionId ?? null) : null,
          lastSeq: Number.isInteger(m.lastSeq) ? m.lastSeq : null,
          wsState: wsReadyStateName(ws),
          waiting: S.waiting,
        });
        if (m.cwd) { S.cwd = m.cwd; updateHeaderInfo(); }
        if ('sessionId' in m) {
          S.resumeRequestedFor = '';
          await syncSessionState(m.sessionId, m.lastSeq);
        }
      }
      else if (m.type === 'transcript_ready') {
        setStatus('connected');
        await syncSessionState(m.sessionId, m.lastSeq);
      }
      else if (m.type === 'replay_done') {
        if (m.sessionId !== undefined && m.sessionId !== null) S.sessionId = m.sessionId;
        if (Number.isInteger(m.lastSeq) && m.lastSeq > S.lastSeq) S.lastSeq = m.lastSeq;
        S.replaying = false;
        if (S.pendingTurnState) applyTurnState(S.pendingTurnState, 'replay_done');
        scheduleSessionCacheSave();
      }
      else if (m.type === 'status') {
        setStatus(m.status === 'running' ? 'connected' : 'starting');
        if (m.cwd) { S.cwd = m.cwd; updateHeaderInfo(); }
        if ('sessionId' in m) await syncSessionState(m.sessionId, m.lastSeq);
      }
      else if (m.type === 'turn_state') {
        if (S.replaying) cacheTurnState(m);
        else applyTurnState(m, 'turn_state');
      }
      else if (m.type === 'pty_exit') { setStatus('disconnected'); if (S.waiting) setWaiting(false, 'pty_exit'); }
      else if (m.type === 'permission_request') showPermission(m);
      else if (m.type === 'clear_permissions') {
        S.pendingPerms = [];
        $('perm-overlay').classList.remove('visible');
      }
      else if (m.type === 'sessions') {
        renderSessionList(m.sessions || []);
        updateSettingsCwd();
      }
      else if (m.type === 'dir_list') {
        renderDirBrowser(m);
      }
      else if (m.type === 'cwd_changed') {
        S.cwd = m.cwd;
        updateHeaderInfo();
        if ('sessionId' in m) await syncSessionState(m.sessionId, m.lastSeq);
        updateSettingsCwd();
      }
      else if (m.type === 'cwd_change_error') {
        showToast(m.error || 'Failed to change folder');
        if (m.cwd) {
          $('settings-cwd-input').value = m.cwd;
        }
      }
    } catch (err) {
      console.error('[ws.onmessage]', err);
    }
  };

  ws.onclose = (event) => {
    clearTimeout(connectTimeout);
    if (!isCurrentSocket()) return;
    clearForegroundProbe('ws_close');
    S.authenticated = false;
    hideHubConnectOverlay();
    renderHubCards();
    setStatus('disconnected');
    S.resumeRequestedFor = '';
    S.pendingTurnState = null;
    debugLog('ws_close', {
      sessionId: S.sessionId || null,
      waiting: S.waiting,
      replaying: S.replaying,
      intentionalDisconnect: S.intentionalDisconnect,
      code: event && typeof event.code === 'number' ? event.code : null,
      reason: event && typeof event.reason === 'string' ? event.reason : '',
      wasClean: event && typeof event.wasClean === 'boolean' ? event.wasClean : null,
      wsState: wsReadyStateName(ws),
      hidden: typeof document !== 'undefined' ? !!document.hidden : null,
      online: typeof navigator !== 'undefined' && 'onLine' in navigator ? !!navigator.onLine : null,
    });
    for (const [uploadId, waiter] of S.uploadWaiters) {
      waiter.reject(new Error('Connection lost'));
      S.uploadWaiters.delete(uploadId);
    }
    if (pendingImage && pendingImage.status !== 'submitted') {
      pendingImage.status = 'failed';
      updateImagePreviewUi();
      if (S.waiting) setWaiting(false, 'ws_close_pending_image');
    }
    if (S.skipNextCloseHandling) {
      S.skipNextCloseHandling = false;
      S.intentionalDisconnect = false;
      return;
    }
    if (S.intentionalDisconnect) return;

    // Auth failure — don't auto-reconnect, prompt user to fix token
    if (isCloseEvent(event, WS_CLOSE_AUTH_FAILED, WS_CLOSE_REASON_AUTH_FAILED)) {
      showToast('Authentication failed — check your Token');
      hideHubConnectOverlay();
      renderHubCards();
      // Open the edit dialog for the current server so user can fix token
      const servers = getSavedServers();
      const current = servers.find(x => x.wsUrl === serverWsUrl);
      if (current) openEditServerDialog(current.id);
      return;
    }

    if (isCloseEvent(event, WS_CLOSE_AUTH_TIMEOUT, WS_CLOSE_REASON_AUTH_TIMEOUT) && $('app').classList.contains('hidden')) {
      failConnect('Handshake timed out - check client/server compatibility and try again');
      return;
    }

    if (!$('app').classList.contains('hidden')) {
      setConnBanner(true, true);
      S.reconnectTimer = setTimeout(connect, 2000);
    } else {
      failConnect('Connection failed - check the address and server');
    }
  };

  ws.onerror = () => {
    if (!isCurrentSocket()) return;
    debugLog('ws_error', {
      sessionId: S.sessionId || null,
      waiting: S.waiting,
      replaying: S.replaying,
      wsState: wsReadyStateName(ws),
      hidden: typeof document !== 'undefined' ? !!document.hidden : null,
      online: typeof navigator !== 'undefined' && 'onLine' in navigator ? !!navigator.onLine : null,
    });
  };
}

function setStatus(s) {
  $('status-dot').className = 'status-dot ' + s;
}

function setConnBanner(show, reconnecting) {
  const el = $('conn-banner');
  el.classList.toggle('visible', show);
  el.classList.toggle('reconnecting', !!reconnecting);
  $('conn-text').textContent = reconnecting ? 'Reconnecting...' : 'Disconnected';
}

// ============================================================
//  Permission Dialog
// ============================================================
function permToolDetail(name, input) {
  if (!input) return name;
  switch (name) {
    case 'Bash': return input.command || input.description || '';
    case 'Read': return input.file_path || '';
    case 'Write': return `Write \u2192 ${input.file_path || ''}`;
    case 'Edit': return `Edit \u2192 ${input.file_path || ''}`;
    case 'Glob': return `Glob: ${input.pattern || ''}`;
    case 'Grep': return `Grep: ${input.pattern || ''}`;
    case 'WebFetch': return input.url || '';
    case 'WebSearch': return `Search: ${input.query || ''}`;
    case 'Task': return input.description || '';
    default: return JSON.stringify(input, null, 2).substring(0, 300);
  }
}

function showPermission(m) {
  S.pendingPerms.push({ id: m.id, toolName: m.toolName, toolInput: m.toolInput });
  if (S.pendingPerms.length === 1) showNextPerm();
  else updatePermCounter();
}

function showNextPerm() {
  if (S.pendingPerms.length === 0) {
    $('perm-overlay').classList.remove('visible');
    return;
  }
  const p = S.pendingPerms[0];
  $('perm-tool-name').textContent = p.toolName;
  $('perm-detail').textContent = permToolDetail(p.toolName, p.toolInput);
  $('perm-overlay').classList.add('visible');
  updatePermCounter();
}

function updatePermCounter() {
  let counter = $('perm-counter');
  if (!counter) {
    counter = document.createElement('span');
    counter.id = 'perm-counter';
    counter.style.cssText = 'font-size:12px;color:var(--text-muted);margin-left:8px;';
    $('perm-tool-name').parentNode.appendChild(counter);
  }
  if (S.pendingPerms.length > 1) {
    counter.textContent = `(1/${S.pendingPerms.length})`;
  } else {
    counter.textContent = '';
  }
}

function resolvePermission(decision) {
  if (S.pendingPerms.length === 0 || !S.ws) return;
  const p = S.pendingPerms.shift();
  S.ws.send(JSON.stringify({
    type: 'permission_response',
    id: p.id,
    decision,
  }));
  showNextPerm();
}

$('perm-allow').addEventListener('click', () => resolvePermission('allow'));
$('perm-deny').addEventListener('click', () => resolvePermission('deny'));

// ============================================================
//  AskUserQuestion — interactive question overlay
// ============================================================
let questionQueue = [];
let currentQuestions = null;
let currentQuestionIdx = 0;

function showQuestion(questions) {
  questionQueue.push(questions);
  if (questionQueue.length === 1) showNextQuestion();
}

function showNextQuestion() {
  if (questionQueue.length === 0) {
    $('question-overlay').classList.remove('visible');
    currentQuestions = null;
    return;
  }
  currentQuestions = questionQueue[0];
  currentQuestionIdx = 0;
  renderCurrentQuestion();
}

function renderCurrentQuestion() {
  if (!currentQuestions || currentQuestionIdx >= currentQuestions.length) {
    questionQueue.shift();
    showNextQuestion();
    return;
  }
  const q = currentQuestions[currentQuestionIdx];
  $('question-header-text').textContent = q.header || 'Question';
  $('question-text').textContent = q.question || '';

  const optionsEl = $('question-options');
  const options = q.options || [];
  optionsEl.innerHTML = options.map((opt, i) => `
    <button class="question-opt" data-idx="${i + 1}">
      <span class="question-opt-num">${i + 1}</span>
      <div class="question-opt-body">
        <div class="question-opt-label">${esc(opt.label)}</div>
        ${opt.description ? `<div class="question-opt-desc">${esc(opt.description)}</div>` : ''}
      </div>
    </button>
  `).join('');

  optionsEl.querySelectorAll('.question-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.idx;
      sendQuestionAnswer(idx);
    });
  });

  $('question-other-input').value = '';
  $('question-overlay').classList.add('visible');
}

function sendQuestionAnswer(numKey) {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  S.ws.send(JSON.stringify({ type: 'input', data: String(numKey) }));
  $('question-overlay').classList.remove('visible');
  currentQuestionIdx++;
  if (currentQuestions && currentQuestionIdx < currentQuestions.length) {
    setTimeout(renderCurrentQuestion, 500);
  } else {
    questionQueue.shift();
    if (questionQueue.length > 0) setTimeout(showNextQuestion, 500);
    else currentQuestions = null;
  }
}

function sendQuestionOther() {
  const text = $('question-other-input').value.trim();
  if (!text || !S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  const options = currentQuestions?.[currentQuestionIdx]?.options || [];
  const otherNum = String(options.length + 1);
  S.ws.send(JSON.stringify({ type: 'input', data: otherNum }));
  setTimeout(() => {
    if (S.ws?.readyState === WebSocket.OPEN) {
      S.ws.send(JSON.stringify({ type: 'chat', text }));
    }
  }, 500);
  $('question-overlay').classList.remove('visible');
  currentQuestionIdx++;
  if (currentQuestions && currentQuestionIdx < currentQuestions.length) {
    setTimeout(renderCurrentQuestion, 1000);
  } else {
    questionQueue.shift();
    if (questionQueue.length > 0) setTimeout(showNextQuestion, 1000);
    else currentQuestions = null;
  }
}

$('question-other-btn').addEventListener('click', sendQuestionOther);
$('question-other-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); sendQuestionOther(); }
});

// ============================================================
//  ExitPlanMode — plan approval overlay (4 fixed options)
// ============================================================
const PLAN_OPTIONS = [
  { num: '1', label: 'Yes, clear context and auto-accept edits', desc: 'Clear context + shift+tab' },
  { num: '2', label: 'Yes, auto-accept edits', desc: 'Auto-accept edits mode' },
  { num: '3', label: 'Yes, manually approve edits', desc: 'Review each edit' },
];

function showPlanApproval(input) {
  const plan = normalizePlanContent(input?.plan || '');
  S.pendingPlanContent = plan;
  const contentEl = $('plan-content');
  if (plan) {
    contentEl.style.display = '';
    contentEl.innerHTML = renderMd(plan);
  } else {
    contentEl.style.display = 'none';
  }

  const optionsEl = $('plan-options');
  optionsEl.innerHTML = PLAN_OPTIONS.map(opt => `
    <button class="question-opt" data-num="${opt.num}">
      <span class="question-opt-num">${opt.num}</span>
      <div class="question-opt-body">
        <div class="question-opt-label">${esc(opt.label)}</div>
        <div class="question-opt-desc">${esc(opt.desc)}</div>
      </div>
    </button>
  `).join('');

  optionsEl.querySelectorAll('.question-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
      // Option 1 triggers /clear inside Claude Code — notify server to expect session switch
      if (btn.dataset.num === '1') {
        S.ws.send(JSON.stringify({ type: 'expect_clear' }));
      } else {
        consumePendingPlanCard();
      }
      S.ws.send(JSON.stringify({ type: 'input', data: btn.dataset.num }));
      $('plan-overlay').classList.remove('visible');
    });
  });

  $('plan-other-input').value = '';
  $('plan-overlay').classList.add('visible');
}

function sendPlanOther() {
  const text = $('plan-other-input').value.trim();
  if (!text || !S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  consumePendingPlanCard();
  S.ws.send(JSON.stringify({ type: 'input', data: '4' }));
  setTimeout(() => {
    if (S.ws?.readyState === WebSocket.OPEN) {
      S.ws.send(JSON.stringify({ type: 'chat', text }));
    }
  }, 500);
  $('plan-overlay').classList.remove('visible');
}

$('plan-other-btn').addEventListener('click', sendPlanOther);
$('plan-other-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); sendPlanOther(); }
});

// ============================================================
//  Todo Panel — state management + rendering
// ============================================================
const todoState = {
  tasks: new Map(),       // taskId -> { subject, description, status, activeForm, blockedBy, blocks }
  pendingCreates: new Map(), // tool_use_id -> input (waiting for tool_result to get taskId)
  panelOpen: false,
  autoOpenedForBatch: false,
  clearTimer: null,
};

const TODO_AUTO_CLEAR_DELAY_MS = 1800;

function cancelTodoAutoClear() {
  if (!todoState.clearTimer) return;
  clearTimeout(todoState.clearTimer);
  todoState.clearTimer = null;
}

function clearTodoBatch() {
  cancelTodoAutoClear();
  todoState.tasks.clear();
  todoState.pendingCreates.clear();
  todoState.panelOpen = false;
  todoState.autoOpenedForBatch = false;
  $('todo-panel').classList.remove('has-tasks', 'open');
  $('todo-list').innerHTML = '';
  $('todo-summary').textContent = '';
  $('todo-progress-bar').style.width = '0%';
  $('todo-progress-bar').classList.remove('all-done');
  $('todo-badge').textContent = '0';
  $('todo-badge').classList.remove('done');
  scheduleSessionCacheSave();
}

function syncTodoPanelLifecycle(tasks) {
  const hasTasks = tasks.length > 0;
  const hasPendingCreates = todoState.pendingCreates.size > 0;
  const hasOpenTasks = tasks.some(([, task]) => (task.status || 'pending') !== 'completed');

  if (!hasTasks) {
    cancelTodoAutoClear();
    todoState.autoOpenedForBatch = false;
    todoState.panelOpen = false;
    return;
  }

  if (!todoState.autoOpenedForBatch) {
    todoState.autoOpenedForBatch = true;
    todoState.panelOpen = true;
  }

  if (hasOpenTasks || hasPendingCreates) {
    cancelTodoAutoClear();
    return;
  }

  if (!todoState.clearTimer) {
    todoState.clearTimer = setTimeout(() => {
      todoState.clearTimer = null;
      const latestTasks = Array.from(todoState.tasks.values());
      const latestHasPendingCreates = todoState.pendingCreates.size > 0;
      const latestHasOpenTasks = latestTasks.some(task => (task.status || 'pending') !== 'completed');
      if (!latestHasPendingCreates && latestTasks.length > 0 && !latestHasOpenTasks) {
        clearTodoBatch();
      }
    }, TODO_AUTO_CLEAR_DELAY_MS);
  }
}

function handleTodoToolUse(b) {
  const { name, id, input } = b;
  if (name === 'TaskCreate') {
    // Claude's task panel starts a fresh batch after all tasks are done.
    const hasOpenTasks = Array.from(todoState.tasks.values()).some(t => t.status !== 'completed');
    if (todoState.tasks.size > 0 && !hasOpenTasks) {
      clearTodoBatch();
    }
    todoState.pendingCreates.set(id, input);
  } else if (name === 'TaskUpdate' && input.taskId) {
    const task = todoState.tasks.get(input.taskId);
    if (task) {
      if (input.status) task.status = input.status;
      if (input.subject) task.subject = input.subject;
      if (input.description) task.description = input.description;
      if (input.activeForm) task.activeForm = input.activeForm;
      renderTodoPanel();
    }
  }
}

function handleTodoToolResult(b, evt) {
  const { tool_use_id, content } = b;
  const text = typeof content === 'string' ? content :
    Array.isArray(content) ? content.map(c => c.text || '').join('') : '';
  const toolUseResult = (evt && typeof evt.toolUseResult === 'object' && evt.toolUseResult) ? evt.toolUseResult : null;

  // TaskCreate result: "Task #1 created successfully: subject"
  const createInput = todoState.pendingCreates.get(tool_use_id);
  if (createInput) {
    todoState.pendingCreates.delete(tool_use_id);
    const metaTaskId = toolUseResult?.task?.id;
    const m = text.match(/Task #(\d+) created/i);
    const taskId = metaTaskId ? String(metaTaskId) : (m ? m[1] : '');
    if (taskId) {
      const metaSubject = toolUseResult?.task?.subject;
      todoState.tasks.set(taskId, {
        subject: metaSubject || createInput.subject || '',
        description: createInput.description || '',
        status: 'pending',
        activeForm: createInput.activeForm || '',
        blockedBy: [],
        blocks: [],
      });
      renderTodoPanel();
    }
    return;
  }

  if (toolUseResult?.taskId) {
    const taskId = String(toolUseResult.taskId);
    let task = todoState.tasks.get(taskId);
    if (!task) {
      task = {
        subject: `Task #${taskId}`,
        description: '',
        status: 'pending',
        activeForm: '',
        blockedBy: [],
        blocks: [],
      };
      todoState.tasks.set(taskId, task);
    }
    if (toolUseResult.statusChange?.to) {
      task.status = toolUseResult.statusChange.to;
    }
    renderTodoPanel();
    return;
  }

  // TaskList result: parse task listing
  if (text.includes('Task #') && (text.includes('[pending]') || text.includes('[in_progress]') || text.includes('[completed]'))) {
    const lines = text.split('\n');
    for (const line of lines) {
      const tm = line.match(/#(\d+)\.\s*\[(\w+)]\s*(.*)/);
      if (tm) {
        const [, taskId, status, subject] = tm;
        const existing = todoState.tasks.get(taskId);
        if (existing) {
          existing.status = status;
          if (subject.trim()) existing.subject = subject.trim();
        } else {
          todoState.tasks.set(taskId, {
            subject: subject.trim(),
            description: '',
            status,
            activeForm: '',
            blockedBy: [],
            blocks: [],
          });
        }
      }
    }
    renderTodoPanel();
    return;
  }

  // TaskUpdate result: "Updated task #1 status"
  const um = text.match(/Updated task #(\d+)/i);
  if (um) {
    renderTodoPanel();
  }
}

function isTodoTool(name) {
  return name === 'TaskCreate' || name === 'TaskUpdate' || name === 'TaskList' || name === 'TaskGet';
}

function renderTodoPanel() {
  const panel = $('todo-panel');
  const list = $('todo-list');
  const tasks = Array.from(todoState.tasks.entries()).sort(([aId], [bId]) => {
    const aNum = Number.parseInt(aId, 10);
    const bNum = Number.parseInt(bId, 10);
    const aOk = Number.isFinite(aNum);
    const bOk = Number.isFinite(bNum);
    if (aOk && bOk) return aNum - bNum;
    if (aOk) return -1;
    if (bOk) return 1;
    return String(aId).localeCompare(String(bId), undefined, { numeric: true });
  });

  if (tasks.length === 0) {
    panel.classList.remove('has-tasks', 'open');
    list.innerHTML = '';
    $('todo-summary').textContent = '';
    $('todo-progress-bar').style.width = '0%';
    $('todo-progress-bar').classList.remove('all-done');
    $('todo-badge').textContent = '0';
    $('todo-badge').classList.remove('done');
    return;
  }

  syncTodoPanelLifecycle(tasks);
  panel.classList.add('has-tasks');
  panel.classList.toggle('open', todoState.panelOpen);

  const total = tasks.length;
  const completed = tasks.filter(([, t]) => t.status === 'completed').length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Update badge
  const badge = $('todo-badge');
  const remaining = total - completed;
  badge.textContent = remaining > 0 ? remaining : '\u2713';
  badge.classList.toggle('done', remaining === 0);

  // Update progress bar
  const bar = $('todo-progress-bar');
  bar.style.width = pct + '%';
  bar.classList.toggle('all-done', pct === 100);

  // Update summary
  $('todo-summary').textContent = `${completed}/${total}`;

  // Render task list
  const STATUS_ICON = {
    pending: '\u25CB',
    in_progress: '\u25D4',
    completed: '\u2713',
  };
  const STATUS_LABEL = {
    pending: 'Pending',
    in_progress: 'Running',
    completed: 'Done',
  };

  list.innerHTML = tasks.map(([id, t]) => {
    const status = t.status || 'pending';
    const showActive = status === 'in_progress' && t.activeForm;
    return `<div class="todo-item ${status}">
      <div class="todo-icon">${STATUS_ICON[status] || '\u25CB'}</div>
      <div class="todo-body">
        <div class="todo-subject">${esc(t.subject || 'Task #' + id)}</div>
        ${showActive ? `<div class="todo-active-form">${esc(t.activeForm)}</div>` : ''}
      </div>
      <span class="todo-status-tag">${STATUS_LABEL[status] || status}</span>
    </div>`;
  }).join('');

  scrollEnd();
}

function toggleTodoPanel() {
  const panel = $('todo-panel');
  todoState.panelOpen = !todoState.panelOpen;
  panel.classList.toggle('open', todoState.panelOpen);
  scheduleSessionCacheSave();
}

function resetTodoState() {
  cancelTodoAutoClear();
  todoState.tasks.clear();
  todoState.pendingCreates.clear();
  todoState.panelOpen = false;
  todoState.autoOpenedForBatch = false;
  $('todo-panel').classList.remove('has-tasks', 'open');
  $('todo-list').innerHTML = '';
  $('todo-summary').textContent = '';
  $('todo-progress-bar').style.width = '0%';
  $('todo-progress-bar').classList.remove('all-done');
  $('todo-badge').textContent = '0';
  $('todo-badge').classList.remove('done');
}

// ============================================================
//  Settings — approval mode
// ============================================================
let approvalMode = localStorage.getItem('approvalMode') || 'default';
let confirmResolve = null;

function initSettings() {
  const radio = document.querySelector(`input[name="approval-mode"][value="${approvalMode}"]`);
  if (radio) radio.checked = true;
  updateSettingsActive();
}

function updateSettingsActive() {
  document.querySelectorAll('.settings-opt').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === approvalMode);
  });
}

function openSettings() {
  initSettings();
  updateSettingsCwd();
  $('settings-overlay').classList.add('visible');
}

function closeSettings() {
  $('settings-overlay').classList.remove('visible');
}

function setApprovalMode(mode) {
  approvalMode = mode;
  localStorage.setItem('approvalMode', mode);
  updateSettingsActive();
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify({ type: 'set_approval_mode', mode }));
  }
}

function showConfirm(text) {
  return new Promise(resolve => {
    $('confirm-text').textContent = text;
    $('confirm-overlay').classList.add('visible');
    confirmResolve = resolve;
  });
}

$('btn-settings').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', closeSettings);
$('settings-overlay').addEventListener('click', e => {
  if (e.target === $('settings-overlay')) closeSettings();
});

document.querySelectorAll('input[name="approval-mode"]').forEach(radio => {
  radio.addEventListener('change', async (e) => {
    const mode = e.target.value;
    if (mode === 'all') {
      const ok = await showConfirm(
        '全部自动审批将允许所有命令（包括 Bash、系统命令）无需确认直接执行，这可能存在风险。确定要开启吗？'
      );
      if (!ok) {
        const prev = document.querySelector(`input[name="approval-mode"][value="${approvalMode}"]`);
        if (prev) prev.checked = true;
        return;
      }
    } else if (mode === 'partial') {
      const ok = await showConfirm(
        '部分自动审批将自动放行 Read、Write、Edit、Glob、Grep 命令，无需手动确认。确定要开启吗？'
      );
      if (!ok) {
        const prev = document.querySelector(`input[name="approval-mode"][value="${approvalMode}"]`);
        if (prev) prev.checked = true;
        return;
      }
    }
    setApprovalMode(mode);
  });
});

$('confirm-ok').addEventListener('click', () => {
  $('confirm-overlay').classList.remove('visible');
  if (confirmResolve) { confirmResolve(true); confirmResolve = null; }
});
$('confirm-cancel').addEventListener('click', () => {
  $('confirm-overlay').classList.remove('visible');
  if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
});

// ============================================================
//  Session Drawer
// ============================================================
let sessionListCache = [];

function getSessionTitle(session) {
  return session.customTitle || session.summary || session.firstPrompt || 'Untitled';
}

function getSessionModifiedMs(session) {
  const value = session.lastModified ?? session.modified ?? null;
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getSessionCwd(session) {
  return session.projectPath || session.cwd || '';
}

function formatRelativeTime(session) {
  const ts = getSessionModifiedMs(session);
  if (!ts) return '';
  const diff = Math.max(0, Date.now() - ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function openSessionDrawer() {
  $('session-overlay').classList.add('visible');
  requestSessionList();
}

function closeSessionDrawer() {
  $('session-overlay').classList.remove('visible');
}

function requestSessionList() {
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    $('session-list').innerHTML = '<div class="drawer-loading">Loading...</div>';
    S.ws.send(JSON.stringify({ type: 'list_sessions' }));
  }
}

function renderSessionList(sessions) {
  sessionListCache = sessions;
  const $list = $('session-list');
  $list.innerHTML = '';
  if (!sessions.length) {
    $list.innerHTML = '<div class="drawer-loading">No sessions found</div>';
    return;
  }
  for (const s of sessions) {
    const isActive = s.sessionId === S.sessionId;
    const el = document.createElement('div');
    el.className = 'session-item' + (isActive ? ' active' : '');
    el.innerHTML =
      `<div class="session-summary">${esc(getSessionTitle(s))}</div>` +
      `<div class="session-meta">` +
        `<span>${formatRelativeTime(s)}</span>` +
        (s.gitBranch ? `<span class="session-branch">${esc(s.gitBranch)}</span>` : '') +
      `</div>`;
    if (!isActive) {
      el.addEventListener('click', () => confirmSwitchSession(s));
    }
    $list.appendChild(el);
  }
}

async function confirmSwitchSession(session) {
  const label = trunc(getSessionTitle(session), 40);
  const ok = await showConfirm(`切换到会话 "${label}"？\n当前对话进度不会丢失。`);
  if (!ok) return;
  closeSessionDrawer();
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify({ type: 'switch_session', sessionId: session.sessionId }));
  }
}

$('btn-sessions').addEventListener('click', openSessionDrawer);
$('session-drawer-close').addEventListener('click', closeSessionDrawer);
$('session-overlay').addEventListener('click', e => {
  if (e.target === $('session-overlay')) closeSessionDrawer();
});
$('btn-new-session').addEventListener('click', async () => {
  const ok = await showConfirm('新建会话？当前对话进度不会丢失。');
  if (!ok) return;
  closeSessionDrawer();
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify({ type: 'chat', text: '/clear' }));
  }
});

// ============================================================
//  Directory Picker
// ============================================================
function openDirPicker(startCwd = '') {
  $('dir-overlay').classList.add('visible');
  requestDirList(startCwd || dirBrowserState.cwd || S.cwd || '');
}

function closeDirPicker() {
  $('dir-overlay').classList.remove('visible');
}

function requestDirList(cwd) {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) {
    showToast('Connection unavailable');
    return;
  }
  $('dir-list').innerHTML = '<div class="drawer-loading">Loading...</div>';
  S.ws.send(JSON.stringify({ type: 'list_dirs', cwd }));
}

function renderDirBrowser(payload) {
  dirBrowserState.cwd = payload.cwd || '';
  dirBrowserState.parent = payload.parent || null;
  dirBrowserState.roots = Array.isArray(payload.roots) ? payload.roots : [];
  dirBrowserState.entries = Array.isArray(payload.entries) ? payload.entries : [];

  $('dir-current-path').textContent = dirBrowserState.cwd || 'Unknown';

  const $roots = $('dir-roots');
  $roots.innerHTML = '';
  for (const root of dirBrowserState.roots) {
    const chip = document.createElement('button');
    chip.className = 'dir-root-chip' + (normalizePathForCompare(root) === normalizePathForCompare(dirBrowserState.cwd) ? ' active' : '');
    chip.textContent = root;
    chip.addEventListener('click', () => requestDirList(root));
    $roots.appendChild(chip);
  }

  const $list = $('dir-list');
  $list.innerHTML = '';
  if (payload.error) {
    showToast(payload.error);
  }

  if (dirBrowserState.parent) {
    $list.appendChild(buildDirItem('..', dirBrowserState.parent, true));
  }

  if (!dirBrowserState.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'dir-empty';
    empty.textContent = payload.error ? 'Folder unavailable' : 'No subfolders';
    $list.appendChild(empty);
    return;
  }

  for (const entry of dirBrowserState.entries) {
    $list.appendChild(buildDirItem(entry.name, entry.path, false));
  }
}

function buildDirItem(name, fullPath, isParent) {
  const el = document.createElement('div');
  el.className = 'dir-item';
  el.innerHTML =
    `<div class="dir-item-main">` +
      `<div class="dir-item-icon">${isParent ? '&#8593;' : '&#128193;'}</div>` +
      `<div>` +
        `<div class="dir-item-name">${esc(name)}</div>` +
        `<div class="dir-item-path">${esc(shortenPath(fullPath))}</div>` +
      `</div>` +
    `</div>` +
    `<div class="dir-item-arrow">&#8250;</div>`;
  el.addEventListener('click', () => requestDirList(fullPath));
  return el;
}

function normalizePathForCompare(p) {
  return String(p || '').replace(/[\\/]+$/, '').toLowerCase();
}

$('dir-drawer-close').addEventListener('click', closeDirPicker);
$('dir-overlay').addEventListener('click', e => {
  if (e.target === $('dir-overlay')) closeDirPicker();
});
$('btn-select-cwd').addEventListener('click', async () => {
  if (!dirBrowserState.cwd) return;
  closeDirPicker();
  await confirmChangeCwd(dirBrowserState.cwd);
});

// ============================================================
//  CWD Switching (Settings)
// ============================================================
function updateSettingsCwd() {
  $('settings-cwd-display').textContent = S.cwd || 'Unknown';
  $('settings-cwd-input').value = S.cwd || '';
  const cwdSet = new Set();
  for (const s of sessionListCache) {
    const cwd = getSessionCwd(s);
    if (cwd && cwd !== S.cwd) cwdSet.add(cwd);
  }
  const $list = $('settings-cwd-list');
  $list.innerHTML = '';
  for (const cwd of cwdSet) {
    const chip = document.createElement('button');
    chip.className = 'cwd-chip';
    chip.textContent = shortenPath(cwd);
    chip.title = cwd;
    chip.addEventListener('click', () => confirmChangeCwd(cwd));
    $list.appendChild(chip);
  }
}

async function confirmChangeCwd(newCwd) {
  if (!newCwd || normalizePathForCompare(newCwd) === normalizePathForCompare(S.cwd)) return;
  const ok = await showConfirm(`切换工作目录到 "${shortenPath(newCwd)}"？\n将重启 Claude 进程。`);
  if (!ok) return;
  closeSettings();
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify({ type: 'change_cwd', cwd: newCwd }));
  }
}

$('btn-change-cwd').addEventListener('click', () => openDirPicker(S.cwd));
$('settings-cwd-input').addEventListener('click', () => openDirPicker(S.cwd));

// ============================================================
//  Keyboard handling for Android virtual keyboard
// ============================================================
function updateKeyboardOffset() {
  if (!window.visualViewport) return;
  const viewportGap = Math.max(
    0,
    Math.round(window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop)
  );
  document.documentElement.style.setProperty('--keyboard-offset', `${viewportGap}px`);

  if (S.isAtBottom) {
    requestAnimationFrame(() => { $chat.scrollTop = $chat.scrollHeight; });
  }
}

if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', updateKeyboardOffset);
  window.visualViewport.addEventListener('scroll', updateKeyboardOffset);
  window.addEventListener('orientationchange', updateKeyboardOffset);
  updateKeyboardOffset();
}

// ============================================================
//  External links — open in system browser, not in WebView
// ============================================================
function logLifecycleEvent(event) {
  debugLog(event, {
    hidden: typeof document !== 'undefined' ? !!document.hidden : null,
    visibilityState: typeof document !== 'undefined' ? document.visibilityState : null,
    focused: typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : null,
    online: typeof navigator !== 'undefined' && 'onLine' in navigator ? !!navigator.onLine : null,
    wsState: wsReadyStateName(typeof S !== 'undefined' ? S.ws : null),
    waiting: typeof S !== 'undefined' ? S.waiting : null,
    sessionId: typeof S !== 'undefined' ? (S.sessionId || null) : null,
    lastSeq: typeof S !== 'undefined' ? S.lastSeq : null,
    replaying: typeof S !== 'undefined' ? S.replaying : null,
  });
}

window.addEventListener('focus', () => {
  logLifecycleEvent('window_focus');
  recoverConnectionOnForeground('window_focus');
});
window.addEventListener('blur', () => logLifecycleEvent('window_blur'));
window.addEventListener('pageshow', () => {
  logLifecycleEvent('window_pageshow');
  recoverConnectionOnForeground('window_pageshow');
});
window.addEventListener('pagehide', () => logLifecycleEvent('window_pagehide'));
window.addEventListener('online', () => {
  logLifecycleEvent('network_online');
  recoverConnectionOnForeground('network_online');
});
window.addEventListener('offline', () => logLifecycleEvent('network_offline'));
document.addEventListener('visibilitychange', () => {
  const becameVisible = !document.hidden;
  logLifecycleEvent(becameVisible ? 'document_visible' : 'document_hidden');
  if (becameVisible) recoverConnectionOnForeground('document_visible');
});

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!href) return;
  // Only intercept external http/https links
  if (/^https?:\/\//i.test(href)) {
    e.preventDefault();
    e.stopPropagation();
    window.open(href, '_blank');
  }
});
