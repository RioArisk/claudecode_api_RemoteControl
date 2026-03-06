// ============================================================
//  Chat Cache (IndexedDB) — pure data layer
// ============================================================
import {
  CHAT_CACHE_DB, CHAT_CACHE_STORE, CHAT_CACHE_MAX_SESSIONS,
  CHAT_CACHE_MAX_TOTAL_BYTES, CHAT_CACHE_MAX_SESSION_BYTES,
} from './constants.js';

let chatCacheDbPromise = null;

export function openChatCacheDb() {
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

export async function chatCacheRead(cacheKey) {
  const db = await openChatCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHAT_CACHE_STORE, 'readonly');
    const req = tx.objectStore(CHAT_CACHE_STORE).get(cacheKey);
    req.onerror = () => reject(req.error || new Error('Failed to read chat cache'));
    req.onsuccess = () => resolve(req.result || null);
  });
}

export async function chatCacheWrite(record) {
  const db = await openChatCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHAT_CACHE_STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to write chat cache'));
    tx.objectStore(CHAT_CACHE_STORE).put(record);
  });
}

export async function chatCacheDelete(cacheKey) {
  const db = await openChatCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHAT_CACHE_STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Failed to delete chat cache'));
    tx.objectStore(CHAT_CACHE_STORE).delete(cacheKey);
  });
}

export async function chatCacheReadAll() {
  const db = await openChatCacheDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CHAT_CACHE_STORE, 'readonly');
    const req = tx.objectStore(CHAT_CACHE_STORE).getAll();
    req.onerror = () => reject(req.error || new Error('Failed to list chat cache'));
    req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
  });
}

export function buildCacheKey(addr, sessionId) {
  return `${addr}::${sessionId}`;
}

export function estimateCacheBytes(record) {
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

export async function pruneChatCache() {
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
