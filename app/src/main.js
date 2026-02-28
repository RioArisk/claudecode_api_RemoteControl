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
const CHAT_CACHE_DB = 'claude_remote_chat_cache';
const CHAT_CACHE_STORE = 'sessions';
const CHAT_CACHE_MAX_SESSIONS = 8;
const CHAT_CACHE_MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const CHAT_CACHE_MAX_SESSION_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_CHUNK_BYTES = 96 * 1024;
let chatCacheDbPromise = null;

function getSavedServers() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}
function saveServer(addr) {
  let list = getSavedServers();
  list = list.filter(a => a !== addr);
  list.unshift(addr);
  if (list.length > 5) list = list.slice(0, 5);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  localStorage.setItem(LAST_KEY, addr);
}
function removeServer(addr) {
  let list = getSavedServers().filter(a => a !== addr);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
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
    mode: record.mode || '',
    lastSeq: record.lastSeq || 0,
    updatedAt: record.updatedAt || 0,
  });
  return payload.length;
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

function renderHistory() {
  const container = $('connect-history');
  const list = getSavedServers();
  container.innerHTML = list.map(addr => {
    const safe = esc(addr);
    return `<span class="history-chip" data-addr="${safe}">
      <span>${safe}</span>
      <button class="remove-chip" data-remove="${safe}">&times;</button>
    </span>`;
  }).join('');

  container.querySelectorAll('.history-chip').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('remove-chip')) {
        e.stopPropagation();
        removeServer(e.target.dataset.remove);
        renderHistory();
        return;
      }
      $('server-addr').value = el.dataset.addr;
    });
  });
}

// Restore last address
const lastAddr = localStorage.getItem(LAST_KEY);
if (lastAddr) $('server-addr').value = lastAddr;
renderHistory();

let serverAddr = '';
let serverWsUrl = '';
let serverCacheAddr = '';
let pendingImage = null; // { file, mediaType, name, previewUrl, uploadId, status, progress, ... }

$('btn-connect').addEventListener('click', tryConnect);
$('server-addr').addEventListener('keydown', e => {
  if (e.key === 'Enter') tryConnect();
});

function tryConnect() {
  const input = $('server-addr').value.trim();
  if (!input) { $('connect-error').textContent = 'Please enter a server address'; return; }

  const parsed = parseServerAddress(input);
  if (!parsed.ok) {
    $('connect-error').textContent = parsed.error;
    return;
  }

  serverAddr = parsed.displayAddr;
  serverWsUrl = parsed.wsUrl;
  serverCacheAddr = parsed.cacheAddr;
  $('server-addr').value = parsed.displayAddr;

  $('connect-error').textContent = '';
  $('btn-connect').classList.add('connecting');
  $('btn-connect').querySelector('span').textContent = 'Connecting...';

  connect();
}

function showConnectScreen() {
  $('connect-screen').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('btn-connect').classList.remove('connecting');
  $('btn-connect').querySelector('span').textContent = 'Connect';
  renderHistory();
}

function showApp() {
  $('connect-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  saveServer(serverAddr);
  renderHistory();
}

// ============================================================
//  App State
// ============================================================
const S = {
  ws: null,
  sessionId: '',
  lastSeq: 0,
  seenUuids: new Set(),
  messageMap: new Map(),
  toolMap: new Map(),
  currentGroup: null,
  currentGroupCount: 0,
  isAtBottom: true,
  waiting: false,
  thinkingEl: null,
  cwd: '',
  model: '',
  mode: 'default',
  pendingPerms: [],
  waitStartedAt: 0,
  replaying: true,           // true during history replay, false after replay_done
  reconnectTimer: null,
  intentionalDisconnect: false,
  resumeRequestedFor: '',
  cacheSaveTimer: null,
  sessionSyncToken: 0,
  uploadWaiters: new Map(),
};

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

function showToast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3200);
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
  if (S.isAtBottom) requestAnimationFrame(() => { $chat.scrollTop = $chat.scrollHeight; });
}

// ============================================================
//  Waiting / Thinking indicator
// ============================================================
function setWaiting(on) {
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
    removeThinkingIndicator();
    const el = document.createElement('div');
    el.className = 'thinking-indicator';
    el.innerHTML = '<div class="dot-pulse"><span></span><span></span><span></span></div><span>Thinking...</span>';
    $msgs.appendChild(el);
    S.thinkingEl = el;
    scrollEnd();
  } else {
    removeThinkingIndicator();
  }
  updateSendBtn();
}

function removeThinkingIndicator() {
  if (S.thinkingEl && S.thinkingEl.parentNode) S.thinkingEl.remove();
  S.thinkingEl = null;
}

function updateSendBtn() {
  const empty = !$input.value.trim() && !pendingImage;
  $('btn-send').classList.toggle('empty', empty && !S.waiting);
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
  S.thinkingEl = null;
  S.waitStartedAt = 0;
  S.lastSeq = 0;
  S.pendingPerms = [];
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
  renderTodoPanel();
  $('todo-panel').classList.toggle('open', todoState.panelOpen && todoState.tasks.size > 0);
}

async function restoreSessionCache(sessionId) {
  if (!serverCacheAddr || !sessionId) return false;

  let record;
  try {
    record = await chatCacheRead(buildCacheKey(serverCacheAddr, sessionId));
  } catch {
    return false;
  }
  if (!record || !record.html) return false;

  $msgs.innerHTML = record.html;
  S.seenUuids = new Set(Array.isArray(record.seenUuids) ? record.seenUuids : []);
  S.lastSeq = Number.isInteger(record.lastSeq) ? record.lastSeq : 0;
  S.cwd = record.cwd || S.cwd;
  S.model = record.model || '';
  S.mode = record.mode || S.mode;
  restoreTodoSnapshot({
    tasks: Array.isArray(record.todoTasks) ? record.todoTasks : [],
    panelOpen: !!record.todoPanelOpen,
  });
  rebuildRuntimeStateFromDom();
  removeThinkingIndicator();
  $input.disabled = false;
  $('btn-send').disabled = false;
  $('input-area').classList.remove('waiting');
  $input.placeholder = INPUT_PLACEHOLDER_DEFAULT;
  updateHeaderInfo();
  updateSendBtn();
  updateScrollBtn();
  requestAnimationFrame(() => { $chat.scrollTop = $chat.scrollHeight; });
  return true;
}

async function persistSessionCache() {
  if (!serverCacheAddr || !S.sessionId) return;
  const todoSnapshot = getTodoSnapshot();
  const record = {
    cacheKey: buildCacheKey(serverCacheAddr, S.sessionId),
    serverAddr,
    sessionId: S.sessionId,
    html: $msgs.innerHTML,
    seenUuids: Array.from(S.seenUuids),
    todoTasks: todoSnapshot.tasks,
    todoPanelOpen: todoSnapshot.panelOpen,
    cwd: S.cwd,
    model: S.model,
    mode: S.mode,
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
  S.replaying = true;

  if (sessionChanged) {
    S.sessionId = nextSessionId;
    S.model = '';
    const shouldKeepOptimisticUi = !prevSessionId && hasOptimisticBubble();
    if (shouldKeepOptimisticUi) {
      rebuildRuntimeStateFromDom();
      updateHeaderInfo();
      scheduleSessionCacheSave();
    } else {
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
function buildDiffHtml(oldStr, newStr, filePath) {
  const oldLines = (oldStr || '').split('\n');
  const newLines = (newStr || '').split('\n');

  // Simple LCS-based diff
  const m = oldLines.length, n = newLines.length;
  // Optimisation: limit to reasonable size to avoid O(m*n) blowup
  if (m * n > 500000) {
    // Fallback: show all old as deleted, all new as added
    return buildDiffFallback(oldLines, newLines, filePath);
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

  return renderDiffOps(ops, filePath);
}

function buildDiffFallback(oldLines, newLines, filePath) {
  const ops = [];
  oldLines.forEach((l, i) => ops.push({ type: 'del', text: l, oldLn: i + 1 }));
  newLines.forEach((l, i) => ops.push({ type: 'add', text: l, newLn: i + 1 }));
  return renderDiffOps(ops, filePath);
}

function renderDiffOps(ops, filePath) {
  let addCount = 0, delCount = 0;
  ops.forEach(o => { if (o.type === 'add') addCount++; if (o.type === 'del') delCount++; });

  let rows = '';
  for (const o of ops) {
    const cls = o.type === 'del' ? 'diff-del' : o.type === 'add' ? 'diff-add' : 'diff-ctx';
    const sign = o.type === 'del' ? '-' : o.type === 'add' ? '+' : ' ';
    const oldN = o.oldLn != null ? o.oldLn : '';
    const newN = o.newLn != null ? o.newLn : '';
    rows += `<tr class="${cls}"><td class="diff-ln">${oldN}</td><td class="diff-ln">${newN}</td><td class="diff-sign">${sign}</td><td class="diff-code">${esc(o.text)}</td></tr>`;
  }

  const ext = (filePath || '').split('.').pop() || '';
  const shortPath = shortenPath(filePath);

  return `<div class="diff-view">
    <div class="diff-header">
      <svg class="diff-file-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
      <span class="diff-file-path" title="${esc(filePath)}">${esc(shortPath)}</span>
      <span class="diff-stats"><span class="ds-add">+${addCount}</span><span class="ds-del">-${delCount}</span></span>
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
        const modelMatch = txt.match(/Set model to.*?\(([^)]+)\)/i) ||
                            txt.replace(/\x1B\[[0-9;]*m/g, '').match(/Set model to.*?\(([^)]+)\)/i);
        if (modelMatch) {
          S.model = modelMatch[1];
          updateHeaderInfo();
          showToast('Model switched to ' + formatModel(S.model));
        }
        if (isJunkContent(txt)) return;
      }
    }

    if (evt.type === 'user' && evt.message) renderUser(evt);
    else if (evt.type === 'assistant' && evt.message) {
      // Keep input locked while assistant turn is active; only remove spinner on first valid reply chunk.
      if (S.waiting) removeThinkingIndicator();
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
        html += textBlocks.map(block => esc(block.text).replace(/\n/g, '<br>')).join('<br>');
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
  if (typeof c === 'string' && c.trim()) {
    closeGroup();
    const opt = $msgs.querySelector('[data-optimistic]');
    if (opt) { opt.removeAttribute('data-optimistic'); return; }
    const el = document.createElement('div');
    el.className = 'user-msg';
    el.innerHTML = esc(c).replace(/\n/g, '<br>');
    $msgs.appendChild(el);
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

// --- Compact Summary ---
function renderCompactSummary(evt) {
  // Dismiss the command overlay
  hideCmdOverlay();
  $('input-area').classList.remove('waiting');
  if (S.waiting) setWaiting(false);

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

  if (!S.model && evt.message.model) {
    S.model = evt.message.model;
    updateHeaderInfo();
  }

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
          if (!S.replaying) showPlanApproval(b.input);
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

  // Edit tool: render diff view
  const isEdit = b.name === 'Edit' && b.input && b.input.old_string !== undefined;
  if (isEdit) {
    detail.innerHTML = buildDiffHtml(b.input.old_string, b.input.new_string, b.input.file_path)
      + `<div class="detail-result" id="result-${b.id}"></div>`;
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
  if (typeof b.content === 'string') text = b.content;
  else if (Array.isArray(b.content)) text = b.content.map(c => c.text || JSON.stringify(c)).join('\n');

  const resultEl = info.detail.querySelector('.detail-result');
  if (resultEl) {
    resultEl.textContent = trunc(text, 3000);
    if (isErr) resultEl.style.color = 'var(--error)';
  }
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

function execCmd(cmd) {
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

  const fb = CMD_FEEDBACK[cmd];
  if (fb) {
    if (fb.overlay) showCmdOverlay(fb.label);
    else if (fb.toast) showToast(fb.toast);
  }
  sendSlashCmd(cmd);
}

function sendSlashCmd(text) {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  S.ws.send(JSON.stringify({ type: 'input', data: '\x1b' }));
  setTimeout(() => {
    if (S.ws?.readyState === WebSocket.OPEN)
      S.ws.send(JSON.stringify({ type: 'chat', text }));
  }, 100);
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
      S.ws.send(JSON.stringify({ type: 'input', data: '\x1b' }));
      setTimeout(() => {
        if (S.ws?.readyState === WebSocket.OPEN)
          S.ws.send(JSON.stringify({ type: 'chat', text: '/model' }));
      }, 300);
      setTimeout(() => {
        if (S.ws?.readyState === WebSocket.OPEN)
          S.ws.send(JSON.stringify({ type: 'chat', text: el.dataset.num }));
      }, 2000);
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
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) {
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
      if (wasQueued && S.waiting) setWaiting(false);
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
  S.intentionalDisconnect = true;
  if (S.ws) S.ws.close();
  if (S.reconnectTimer) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; }
  resetAppState();
  showConnectScreen();
});

function resetAppState() {
  S.ws = null;
  S.sessionId = '';
  S.resumeRequestedFor = '';
  S.sessionSyncToken = 0;
  S.cwd = '';
  S.model = '';
  S.mode = 'default';
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
  if ((!t && !hasImage) || !S.ws || S.ws.readyState !== WebSocket.OPEN || S.waiting) return;

  // Intercept slash commands typed directly (only when no image)
  if (!hasImage && /^\/[a-z]+$/i.test(t)) {
    execCmd(t);
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
  setWaiting(true);

  if (hasImage && pendingImage.status === 'uploaded') {
    submitPendingImageUpload().catch(err => {
      if (pendingImage) {
        pendingImage.status = 'failed';
        updateImagePreviewUi();
      }
      setWaiting(false);
      showToast(err.message || 'Image submit failed');
    });
  }
}

// ============================================================
//  WebSocket
// ============================================================
function connect() {
  let ws;
  try {
    ws = new WebSocket(serverWsUrl);
  } catch (e) {
    $('connect-error').textContent = 'Invalid address';
    $('btn-connect').classList.remove('connecting');
    $('btn-connect').querySelector('span').textContent = 'Connect';
    return;
  }
  S.ws = ws;
  S.resumeRequestedFor = '';
  S.replaying = true;

  const connectTimeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      ws.close();
      $('connect-error').textContent = 'Connection timed out';
      $('btn-connect').classList.remove('connecting');
      $('btn-connect').querySelector('span').textContent = 'Connect';
    }
  }, 8000);

  ws.onopen = () => {
    clearTimeout(connectTimeout);
    setStatus('connected');
    setConnBanner(false);
    showApp();
    // Sync approval mode to server
    ws.send(JSON.stringify({ type: 'set_approval_mode', mode: approvalMode }));
  };

  ws.onmessage = async e => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    try {
      if (m.type === 'pty_output') { /* ignored — no terminal panel */ }
      else if (m.type === 'log_event') processEvent(m.event, m.seq);
      else if (m.type === 'image_upload_status') handleUploadStatus(m);
      else if (m.type === 'transcript_ready') {
        setStatus('connected');
        await syncSessionState(m.sessionId, m.lastSeq);
      }
      else if (m.type === 'replay_done') {
        if (m.sessionId !== undefined && m.sessionId !== null) S.sessionId = m.sessionId;
        if (Number.isInteger(m.lastSeq) && m.lastSeq > S.lastSeq) S.lastSeq = m.lastSeq;
        S.replaying = false;
        scheduleSessionCacheSave();
      }
      else if (m.type === 'status') {
        setStatus(m.status === 'running' ? 'connected' : 'starting');
        if (m.cwd) { S.cwd = m.cwd; updateHeaderInfo(); }
        if ('sessionId' in m) await syncSessionState(m.sessionId, m.lastSeq);
      }
      else if (m.type === 'pty_exit') { setStatus('disconnected'); if (S.waiting) setWaiting(false); }
      else if (m.type === 'turn_complete') {
        if (S.waiting) setWaiting(false);
      }
      else if (m.type === 'permission_request') showPermission(m);
      else if (m.type === 'clear_permissions') {
        S.pendingPerms = [];
        $('perm-overlay').classList.remove('visible');
      }
      else if (m.type === 'mode') {
        S.mode = m.mode; updateHeaderInfo();
        scheduleSessionCacheSave();
      }
    } catch (err) {
      console.error('[ws.onmessage]', err);
    }
  };

  ws.onclose = () => {
    clearTimeout(connectTimeout);
    setStatus('disconnected');
    S.resumeRequestedFor = '';
    for (const [uploadId, waiter] of S.uploadWaiters) {
      waiter.reject(new Error('Connection lost'));
      S.uploadWaiters.delete(uploadId);
    }
    if (pendingImage && pendingImage.status !== 'submitted') {
      pendingImage.status = 'failed';
      updateImagePreviewUi();
      if (S.waiting) setWaiting(false);
    }
    if (S.intentionalDisconnect) return;

    if (!$('app').classList.contains('hidden')) {
      setConnBanner(true, true);
      S.reconnectTimer = setTimeout(connect, 2000);
    } else {
      $('connect-error').textContent = 'Connection failed \u2014 check the address and server';
      $('btn-connect').classList.remove('connecting');
      $('btn-connect').querySelector('span').textContent = 'Connect';
    }
  };

  ws.onerror = () => {};
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
  const plan = input?.plan || '';
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
};

function handleTodoToolUse(b) {
  const { name, id, input } = b;
  if (name === 'TaskCreate') {
    // Claude's task panel starts a fresh batch after all tasks are done.
    const hasOpenTasks = Array.from(todoState.tasks.values()).some(t => t.status !== 'completed');
    if (todoState.tasks.size > 0 && !hasOpenTasks) {
      todoState.tasks.clear();
      renderTodoPanel();
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
    panel.classList.remove('has-tasks');
    return;
  }

  panel.classList.add('has-tasks');

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

  // Auto-open on first task
  if (!todoState.panelOpen && tasks.length > 0) {
    todoState.panelOpen = true;
    panel.classList.add('open');
  }

  scrollEnd();
}

function toggleTodoPanel() {
  const panel = $('todo-panel');
  todoState.panelOpen = !todoState.panelOpen;
  panel.classList.toggle('open', todoState.panelOpen);
  scheduleSessionCacheSave();
}

function resetTodoState() {
  todoState.tasks.clear();
  todoState.pendingCreates.clear();
  todoState.panelOpen = false;
  $('todo-panel').classList.remove('has-tasks', 'open');
  $('todo-list').innerHTML = '';
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
//  Keyboard handling for Android virtual keyboard
// ============================================================
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    if (S.isAtBottom) {
      requestAnimationFrame(() => { $chat.scrollTop = $chat.scrollHeight; });
    }
  });
}

// ============================================================
//  External links — open in system browser, not in WebView
// ============================================================
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
