// ============================================================
//  WebSocket connection management
// ============================================================
import {
  WS_CLOSE_AUTH_FAILED, WS_CLOSE_AUTH_TIMEOUT,
  WS_CLOSE_REASON_AUTH_FAILED, WS_CLOSE_REASON_AUTH_TIMEOUT,
  FOREGROUND_PROBE_TIMEOUT_MS, FOREGROUND_RECOVER_DEBOUNCE_MS,
} from './constants.js';
import { $ } from './utils.js';
import { S, serverWsUrl, serverToken, pendingImage, approvalMode } from './state.js';
import { debugLog, wsReadyStateName, CLIENT_INSTANCE_ID, flushPendingDebugLogs } from './debug.js';
import { showToast } from './toast.js';
import {
  hideHubConnectOverlay, renderHubCards, showApp, showConnectScreen,
  saveServer, getSavedServers, openEditServerDialog, showHubConnectOverlay,
} from './hub.js';
import { serverAddr } from './state.js';
import { processEvent, syncConfirmedModel, updateHeaderInfo, cacheTurnState, applyTurnState, clearConversationUi, restoreSessionCache, hasOptimisticBubble, rebuildRuntimeStateFromDom, scheduleSessionCacheSave, flushSessionCacheSave } from './renderer.js';
import { setWaiting } from './waiting.js';
import { showPermission, dismissPermissionById, clearPermissions } from './permissions.js';
import { handleUploadStatus, updateImagePreviewUi } from './image-upload.js';
import { renderSessionList } from './sessions.js';
import { renderDirBrowser, updateSettingsCwd } from './dir-picker.js';
import { presentNextPendingInteraction } from './interactions.js';

export function isAuthReadyMessage(msg) {
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

export function clearForegroundProbe(reason = '') {
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

export function recoverConnectionOnForeground(trigger) {
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

export function setStatus(s) {
  $('status-dot').className = 'status-dot ' + s;
}

export function setConnBanner(show, reconnecting) {
  const el = $('conn-banner');
  el.classList.toggle('visible', show);
  el.classList.toggle('reconnecting', !!reconnecting);
  $('conn-text').textContent = reconnecting ? 'Reconnecting...' : 'Disconnected';
}

export function connect() {
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
      if (m.type === 'pty_output') { /* ignored */ }
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
        presentNextPendingInteraction();
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
      else if (m.type === 'permission_resolved') dismissPermissionById(m.id);
      else if (m.type === 'clear_permissions') clearPermissions();
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
    const currentImage = pendingImage;
    if (currentImage && currentImage.status !== 'submitted') {
      currentImage.status = 'failed';
      updateImagePreviewUi();
      if (S.waiting) setWaiting(false, 'ws_close_pending_image');
    }
    if (S.skipNextCloseHandling) {
      S.skipNextCloseHandling = false;
      S.intentionalDisconnect = false;
      return;
    }
    if (S.intentionalDisconnect) return;

    if (isCloseEvent(event, WS_CLOSE_AUTH_FAILED, WS_CLOSE_REASON_AUTH_FAILED)) {
      showToast('Authentication failed — check your Token');
      hideHubConnectOverlay();
      renderHubCards();
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

export function tryConnect() {
  if (!serverWsUrl) return;
  connect();
}
