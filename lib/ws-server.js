'use strict';

const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const {
  state,
  WS_CLOSE_AUTH_FAILED,
  WS_CLOSE_AUTH_TIMEOUT,
  WS_CLOSE_REASON_AUTH_FAILED,
  WS_CLOSE_REASON_AUTH_TIMEOUT,
  AUTH_HELLO_TIMEOUT_MS,
  LEGACY_REPLAY_DELAY_MS,
  isTTY,
} = require('./state');
const {
  log,
  broadcast,
  wsLabel,
  isAuthenticatedClient,
  sendWs,
  sendTurnState,
  setTurnState,
  latestEventSeq,
  emitInterrupt,
} = require('./logger');
const {
  extractSlashCommand,
  markExpectingSwitch,
  scanSessions,
  listDirectories,
  getDirectoryRoots,
  assertDirectoryPath,
} = require('./transcript');
const {
  cleanupImageUpload,
  cleanupClientUploads,
  sendUploadStatus,
  handlePreparedImageUpload,
  handleImageUpload,
  createTempImageFile,
} = require('./image-upload');
const { restartClaude } = require('./pty-manager');

const APPROVAL_MODE_ORDER = { default: 0, partial: 1, all: 2 };

function normalizeApprovalMode(mode) {
  return Object.prototype.hasOwnProperty.call(APPROVAL_MODE_ORDER, mode) ? mode : 'default';
}

function computeEffectiveApprovalMode() {
  if (!state.wss) return 'default';
  let best = 'default';
  let bestScore = APPROVAL_MODE_ORDER.default;
  for (const client of state.wss.clients) {
    if (!isAuthenticatedClient(client)) continue;
    const mode = normalizeApprovalMode(client._approvalMode);
    const score = APPROVAL_MODE_ORDER[mode];
    if (score > bestScore) {
      best = mode;
      bestScore = score;
    }
  }
  return best;
}

function autoResolveAllPendingApprovals(reason = '') {
  if (state.pendingApprovals.size === 0) return;
  for (const [id, approval] of state.pendingApprovals) {
    clearTimeout(approval.timer);
    approval.res.writeHead(200, { 'Content-Type': 'application/json' });
    approval.res.end(JSON.stringify({ decision: 'allow' }));
    log(`Permission #${id}: auto-allowed (${reason || 'effective mode all'})`);
  }
  state.pendingApprovals.clear();
  broadcast({ type: 'clear_permissions' });
}

function refreshApprovalMode(reason = '') {
  const nextMode = computeEffectiveApprovalMode();
  if (state.approvalMode === nextMode) return;
  const prevMode = state.approvalMode;
  state.approvalMode = nextMode;
  log(`Approval mode effective: ${prevMode} -> ${state.approvalMode}${reason ? ` (${reason})` : ''}`);
  if (state.approvalMode === 'all') {
    autoResolveAllPendingApprovals('effective mode switched to all');
  }
}

function sendReplay(ws, lastSeq = null) {
  const normalizedLastSeq = Number.isInteger(lastSeq) && lastSeq >= 0 ? lastSeq : null;
  const replayFrom = normalizedLastSeq == null ? 0 : normalizedLastSeq;
  const records = replayFrom > 0
    ? state.eventBuffer.filter(record => record.seq > replayFrom)
    : state.eventBuffer;

  log(`Replay start -> ${wsLabel(ws)} from=${replayFrom} count=${records.length} currentSession=${state.currentSessionId ?? 'null'}`);

  for (const record of records) {
    ws.send(JSON.stringify({
      type: 'log_event',
      seq: record.seq,
      event: record.event,
    }));
  }

  sendWs(ws, {
    type: 'replay_done',
    sessionId: state.currentSessionId,
    lastSeq: latestEventSeq(),
    resumed: normalizedLastSeq != null,
  }, 'sendReplay');
  sendTurnState(ws, 'sendReplay');
}

function sendInitialMessages(ws) {
  sendWs(ws, {
    type: 'status',
    status: state.claudeProc ? 'running' : 'starting',
    hasTranscript: !!state.transcriptPath,
    cwd: state.CWD,
    sessionId: state.currentSessionId,
    lastSeq: latestEventSeq(),
  }, 'initial');

  if (state.currentSessionId) {
    sendWs(ws, {
      type: 'transcript_ready',
      transcript: state.transcriptPath,
      sessionId: state.currentSessionId,
      lastSeq: latestEventSeq(),
    }, 'initial');
  }
}

function sendAuthOk(ws) {
  sendWs(ws, {
    type: 'auth_ok',
    authRequired: !state.AUTH_DISABLED,
  }, 'auth_ok');
}

function setupWebSocketServer(server) {
  const wss = new WebSocketServer({ server });
  state.wss = wss;

  wss.on('connection', (ws, req) => {
    ws._bridgeId = ++state.nextWsId;
    ws._clientInstanceId = '';
    ws._authenticated = state.AUTH_DISABLED;
    ws._approvalMode = 'default';
    ws._authTimer = null;
    log(`WS connected: ${wsLabel(ws)} remote=${req.socket.remoteAddress || '?'} ua=${JSON.stringify(req.headers['user-agent'] || '')} authRequired=${!state.AUTH_DISABLED}`);

    if (state.AUTH_DISABLED) {
      sendAuthOk(ws);
      sendInitialMessages(ws);
    } else {
      ws._authTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN || ws._authenticated) return;
        log(`Auth timeout for ${wsLabel(ws)}`);
        ws.close(WS_CLOSE_AUTH_TIMEOUT, WS_CLOSE_REASON_AUTH_TIMEOUT);
      }, AUTH_HELLO_TIMEOUT_MS);
    }

    ws._resumeHandled = false;
    ws._legacyReplayTimer = null;
    if (state.AUTH_DISABLED) {
      ws._legacyReplayTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN || ws._resumeHandled) return;
        ws._resumeHandled = true;
        sendReplay(ws, null);
      }, LEGACY_REPLAY_DELAY_MS);
    }

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // --- Authentication gate ---
      if (!ws._authenticated) {
        if (msg.type !== 'hello') return;
        ws._clientInstanceId = String(msg.clientInstanceId || ws._clientInstanceId || '');
        log(`WS hello from ${wsLabel(ws)} page=${JSON.stringify(msg.page || '')} ua=${JSON.stringify(msg.userAgent || '')}`);

        const clientToken = String(msg.token || '');
        if (!state.AUTH_TOKEN || !clientToken) {
          log(`Auth failed for ${wsLabel(ws)}: missing token`);
          ws.close(WS_CLOSE_AUTH_FAILED, WS_CLOSE_REASON_AUTH_FAILED);
          return;
        }
        const a = Buffer.from(state.AUTH_TOKEN, 'utf8');
        const b = Buffer.from(clientToken, 'utf8');
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
          log(`Auth failed for ${wsLabel(ws)}: invalid token`);
          ws.close(WS_CLOSE_AUTH_FAILED, WS_CLOSE_REASON_AUTH_FAILED);
          return;
        }
        ws._authenticated = true;
        if (ws._authTimer) {
          clearTimeout(ws._authTimer);
          ws._authTimer = null;
        }
        log(`Auth OK for ${wsLabel(ws)}`);

        sendAuthOk(ws);
        sendInitialMessages(ws);
        ws._legacyReplayTimer = setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN || ws._resumeHandled) return;
          ws._resumeHandled = true;
          sendReplay(ws, null);
        }, LEGACY_REPLAY_DELAY_MS);
        return;
      }

      switch (msg.type) {
        case 'hello':
          ws._clientInstanceId = String(msg.clientInstanceId || ws._clientInstanceId || '');
          log(`WS hello from ${wsLabel(ws)} page=${JSON.stringify(msg.page || '')} ua=${JSON.stringify(msg.userAgent || '')}`);
          break;
        case 'debug_log':
          if (msg.clientInstanceId) ws._clientInstanceId = String(msg.clientInstanceId);
          log(`ClientDebug ${wsLabel(ws)} event=${msg.event || 'unknown'} detail=${JSON.stringify(msg.detail || {})}`);
          break;
        case 'resume': {
          ws._resumeHandled = true;
          if (ws._legacyReplayTimer) {
            clearTimeout(ws._legacyReplayTimer);
            ws._legacyReplayTimer = null;
          }

          if (!state.currentSessionId) {
            ws.send(JSON.stringify({
              type: 'replay_done',
              sessionId: null,
              lastSeq: 0,
              resumed: false,
            }));
            sendTurnState(ws, 'resume-empty');
            break;
          }

          const clientServerLastSeq = Number.isInteger(msg.serverLastSeq) && msg.serverLastSeq >= 0
            ? msg.serverLastSeq
            : null;
          const canResume = (
            msg.sessionId &&
            msg.sessionId === state.currentSessionId &&
            Number.isInteger(msg.lastSeq) &&
            msg.lastSeq >= 0 &&
            msg.lastSeq <= latestEventSeq() &&
            (clientServerLastSeq == null || msg.lastSeq <= clientServerLastSeq)
          );

          log(`Resume request from ${wsLabel(ws)} session=${msg.sessionId ?? 'null'} lastSeq=${msg.lastSeq} serverLastSeq=${clientServerLastSeq ?? 'null'} canResume=${canResume}`);

          sendReplay(ws, canResume ? msg.lastSeq : null);
          break;
        }
        case 'foreground_probe': {
          const probeId = typeof msg.probeId === 'string' ? msg.probeId : '';
          sendWs(ws, {
            type: 'foreground_probe_ack',
            probeId,
            sessionId: state.currentSessionId,
            lastSeq: latestEventSeq(),
            cwd: state.CWD,
          }, 'foreground_probe');
          log(`Foreground probe ack -> ${wsLabel(ws)} probeId=${probeId || 'none'} session=${state.currentSessionId ?? 'null'} lastSeq=${latestEventSeq()}`);
          break;
        }
        case 'input':
          if (state.claudeProc) state.claudeProc.write(msg.data);
          break;
        case 'interrupt': {
          if (!state.claudeProc || state.turnState.phase !== 'running') break;
          log(`Interrupt from ${wsLabel(ws)} — sending Ctrl+C to PTY`);
          state.claudeProc.write('\x03');
          emitInterrupt('app');
          break;
        }
        case 'expect_clear':
          markExpectingSwitch();
          break;
        case 'chat':
          if (state.claudeProc) {
            const text = msg.text;
            log(`Chat input → PTY: "${text.substring(0, 80)}"`);
            const slashCommand = extractSlashCommand(text);
            if (slashCommand === '/clear') {
              markExpectingSwitch();
            }
            if (!slashCommand) {
              setTurnState('running', { reason: 'chat' });
            }
            state.claudeProc.write(text);
            setTimeout(() => {
              if (state.claudeProc) state.claudeProc.write('\r');
            }, 150);
          }
          break;
        case 'resize':
          if (state.claudeProc && msg.cols && msg.rows && !isTTY) {
            state.claudeProc.resize(msg.cols, msg.rows);
          }
          break;
        case 'permission_response': {
          const approval = state.pendingApprovals.get(msg.id);
          if (approval) {
            clearTimeout(approval.timer);
            state.pendingApprovals.delete(msg.id);
            approval.res.writeHead(200, { 'Content-Type': 'application/json' });
            approval.res.end(JSON.stringify({
              decision: msg.decision,
              reason: msg.reason || '',
            }));
            log(`Permission #${msg.id}: ${msg.decision}`);
            broadcast({
              type: 'permission_resolved',
              id: msg.id,
              decision: msg.decision,
            });
          }
          break;
        }
        case 'set_approval_mode': {
          ws._approvalMode = normalizeApprovalMode(msg.mode);
          log(`Approval mode reported by ${wsLabel(ws)}: ${ws._approvalMode}`);
          refreshApprovalMode(`reported by ${wsLabel(ws)}`);
          break;
        }
        case 'image_upload_init': {
          const uploadId = String(msg.uploadId || '');
          if (!uploadId) {
            sendUploadStatus(ws, '', 'error', { message: 'Missing uploadId' });
            break;
          }
          cleanupImageUpload(uploadId);
          state.pendingImageUploads.set(uploadId, {
            id: uploadId,
            owner: ws,
            mediaType: msg.mediaType || 'image/png',
            name: msg.name || 'image',
            totalBytes: Number.isFinite(msg.totalBytes) ? msg.totalBytes : 0,
            totalChunks: Number.isFinite(msg.totalChunks) ? msg.totalChunks : 0,
            nextChunkIndex: 0,
            receivedBytes: 0,
            chunks: [],
            tmpFile: null,
            updatedAt: Date.now(),
          });
          sendUploadStatus(ws, uploadId, 'ready_for_chunks', { receivedBytes: 0, totalBytes: msg.totalBytes || 0 });
          break;
        }
        case 'image_upload_chunk': {
          const uploadId = String(msg.uploadId || '');
          const upload = state.pendingImageUploads.get(uploadId);
          if (!upload) {
            sendUploadStatus(ws, uploadId, 'error', { message: 'Upload session not found' });
            break;
          }
          if (upload.owner !== ws) {
            sendUploadStatus(ws, uploadId, 'error', { message: 'Upload owner mismatch' });
            break;
          }
          if (msg.index !== upload.nextChunkIndex) {
            sendUploadStatus(ws, uploadId, 'error', {
              message: `Unexpected chunk index ${msg.index}, expected ${upload.nextChunkIndex}`,
            });
            break;
          }
          if (!msg.base64) {
            sendUploadStatus(ws, uploadId, 'error', { message: 'Missing chunk payload' });
            break;
          }

          try {
            const chunk = Buffer.from(msg.base64, 'base64');
            upload.chunks.push(chunk);
            upload.receivedBytes += chunk.length;
            upload.nextChunkIndex += 1;
            upload.updatedAt = Date.now();
            sendUploadStatus(ws, uploadId, 'uploading', {
              chunkIndex: msg.index,
              receivedBytes: upload.receivedBytes,
              totalBytes: upload.totalBytes,
            });
          } catch (err) {
            sendUploadStatus(ws, uploadId, 'error', { message: err.message });
          }
          break;
        }
        case 'image_upload_complete': {
          const uploadId = String(msg.uploadId || '');
          const upload = state.pendingImageUploads.get(uploadId);
          if (!upload) {
            sendUploadStatus(ws, uploadId, 'error', { message: 'Upload session not found' });
            break;
          }
          if (upload.owner !== ws) {
            sendUploadStatus(ws, uploadId, 'error', { message: 'Upload owner mismatch' });
            break;
          }
          if (upload.nextChunkIndex !== upload.totalChunks) {
            sendUploadStatus(ws, uploadId, 'error', {
              message: `Upload incomplete (${upload.nextChunkIndex}/${upload.totalChunks})`,
            });
            break;
          }

          try {
            const buffer = Buffer.concat(upload.chunks);
            upload.tmpFile = createTempImageFile(buffer, upload.mediaType, uploadId);
            upload.chunks = [];
            upload.updatedAt = Date.now();
            log(`Image pre-upload complete: ${upload.tmpFile} (${buffer.length} bytes)`);
            sendUploadStatus(ws, uploadId, 'uploaded', {
              receivedBytes: upload.receivedBytes,
              totalBytes: upload.totalBytes,
            });
          } catch (err) {
            sendUploadStatus(ws, uploadId, 'error', { message: err.message });
            cleanupImageUpload(uploadId);
          }
          break;
        }
        case 'image_upload_abort': {
          const uploadId = String(msg.uploadId || '');
          if (uploadId) cleanupImageUpload(uploadId);
          sendUploadStatus(ws, uploadId, 'aborted');
          break;
        }
        case 'image_submit': {
          const uploadId = String(msg.uploadId || '');
          const upload = state.pendingImageUploads.get(uploadId);
          if (!upload || !upload.tmpFile) {
            sendUploadStatus(ws, uploadId, 'error', { message: 'Upload not ready' });
            break;
          }
          try {
            await handlePreparedImageUpload({
              tmpFile: upload.tmpFile,
              mediaType: upload.mediaType,
              text: msg.text || '',
              logLabel: upload.name || uploadId,
              onCleanup: () => cleanupImageUpload(uploadId),
            });
            upload.submitted = true;
            upload.updatedAt = Date.now();
            setTurnState('running', { reason: 'image_submit' });
            sendUploadStatus(ws, uploadId, 'submitted');
          } catch (err) {
            sendUploadStatus(ws, uploadId, 'error', { message: err.message });
            cleanupImageUpload(uploadId);
          }
          break;
        }
        case 'image_upload': {
          handleImageUpload(msg);
          break;
        }
        case 'list_sessions': {
          try {
            const sessions = scanSessions(state.CWD, 20);
            sendWs(ws, { type: 'sessions', sessions });
          } catch (err) {
            log(`scanSessions error: ${err.message}`);
            sendWs(ws, { type: 'sessions', sessions: [], error: err.message });
          }
          break;
        }
        case 'list_dirs': {
          try {
            const browser = listDirectories(msg.cwd || state.CWD);
            sendWs(ws, { type: 'dir_list', ...browser });
          } catch (err) {
            log(`listDirectories error: ${err.message}`);
            sendWs(ws, {
              type: 'dir_list',
              cwd: path.resolve(String(msg.cwd || state.CWD || '')),
              parent: null,
              roots: getDirectoryRoots(),
              entries: [],
              error: err.message,
            });
          }
          break;
        }
        case 'switch_session': {
          if (state.claudeProc && msg.sessionId) {
            log(`Switch session → /resume ${msg.sessionId}`);
            markExpectingSwitch();
            state.claudeProc.write(`/resume ${msg.sessionId}`);
            setTimeout(() => {
              if (state.claudeProc) state.claudeProc.write('\r');
            }, 150);
          }
          break;
        }
        case 'change_cwd': {
          if (msg.cwd) {
            try {
              const targetCwd = assertDirectoryPath(msg.cwd);
              restartClaude(targetCwd);
            } catch (err) {
              sendWs(ws, { type: 'cwd_change_error', cwd: String(msg.cwd), error: err.message });
            }
          }
          break;
        }
      }
    });

    ws.on('close', () => {
      if (ws._authTimer) {
        clearTimeout(ws._authTimer);
        ws._authTimer = null;
      }
      if (ws._legacyReplayTimer) {
        clearTimeout(ws._legacyReplayTimer);
        ws._legacyReplayTimer = null;
      }
      log(`WS closed: ${wsLabel(ws)}`);
      cleanupClientUploads(ws);
      refreshApprovalMode(`client disconnected ${wsLabel(ws)}`);
    });
  });
}

module.exports = { setupWebSocketServer };
