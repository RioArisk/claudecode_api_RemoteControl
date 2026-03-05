// ============================================================
//  Debug Logging
// ============================================================
import { CLIENT_INSTANCE_KEY } from './constants.js';
import { S } from './state.js';

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

export const CLIENT_INSTANCE_ID = getClientInstanceId();
let debugLogSeq = 0;
const MAX_PENDING_DEBUG_LOGS = 120;
export const pendingDebugLogs = [];

export function wsReadyStateName(ws) {
  if (!ws) return 'null';
  switch (ws.readyState) {
    case WebSocket.CONNECTING: return 'CONNECTING';
    case WebSocket.OPEN: return 'OPEN';
    case WebSocket.CLOSING: return 'CLOSING';
    case WebSocket.CLOSED: return 'CLOSED';
    default: return String(ws.readyState);
  }
}

export function queueDebugPayload(payload) {
  pendingDebugLogs.push(payload);
  if (pendingDebugLogs.length > MAX_PENDING_DEBUG_LOGS) pendingDebugLogs.shift();
}

export function restorePendingDebugLogs(payloads) {
  if (!payloads || !payloads.length) return;
  pendingDebugLogs.unshift(...payloads);
  while (pendingDebugLogs.length > MAX_PENDING_DEBUG_LOGS) pendingDebugLogs.shift();
}

export function sendDebugPayload(payload) {
  try {
    if (S.ws && S.ws.readyState === WebSocket.OPEN) {
      S.ws.send(JSON.stringify({ type: 'debug_log', ...payload }));
      return true;
    }
  } catch {}
  return false;
}

export function flushPendingDebugLogs() {
  if (!pendingDebugLogs.length) return;
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  const backlog = pendingDebugLogs.splice(0, pendingDebugLogs.length);
  for (let i = 0; i < backlog.length; i += 1) {
    const payload = backlog[i];
    if (!sendDebugPayload(payload)) {
      restorePendingDebugLogs(backlog.slice(i));
      break;
    }
  }
}

export function debugLog(event, detail = {}) {
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
