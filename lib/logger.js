'use strict';

const fs = require('fs');
const { WebSocket } = require('ws');
const crypto = require('crypto');
const { state, LOG_FILE, EVENT_BUFFER_MAX } = require('./state');
const APPROVAL_MODE_ORDER = { default: 0, partial: 1, all: 2 };

// --- Logging → file only (never pollute the terminal) ---
fs.writeFileSync(LOG_FILE, `--- Bridge started ${new Date().toISOString()} ---\n`);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

function wsLabel(ws) {
  const clientId = ws && ws._clientInstanceId ? ` client=${ws._clientInstanceId}` : '';
  return `ws#${ws && ws._bridgeId ? ws._bridgeId : '?'}${clientId}`;
}

function isAuthenticatedClient(ws) {
  return !!ws && ws.readyState === WebSocket.OPEN && !!ws._authenticated;
}

function normalizeApprovalMode(mode) {
  const normalized = String(mode || '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(APPROVAL_MODE_ORDER, normalized) ? normalized : 'default';
}

function computeConnectedHighestApprovalMode() {
  if (!state.wss) return 'default';
  let best = 'default';
  let bestScore = APPROVAL_MODE_ORDER.default;
  for (const ws of state.wss.clients) {
    if (!isAuthenticatedClient(ws)) continue;
    const mode = normalizeApprovalMode(ws._approvalMode);
    const score = APPROVAL_MODE_ORDER[mode];
    if (score > bestScore) {
      best = mode;
      bestScore = score;
    }
  }
  return best;
}

function sendWs(ws, msg, context = '') {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  if (msg.type === 'status' || msg.type === 'transcript_ready' || msg.type === 'replay_done' || msg.type === 'turn_state') {
    const extra = [];
    if (msg.sessionId !== undefined) extra.push(`session=${msg.sessionId ?? 'null'}`);
    if (msg.lastSeq !== undefined) extra.push(`lastSeq=${msg.lastSeq}`);
    if (msg.resumed !== undefined) extra.push(`resumed=${msg.resumed}`);
    if (msg.phase !== undefined) extra.push(`phase=${msg.phase}`);
    if (msg.version !== undefined) extra.push(`version=${msg.version}`);
    log(`Send ${msg.type}${context ? ` (${context})` : ''} -> ${wsLabel(ws)}${extra.length ? ` ${extra.join(' ')}` : ''}`);
  }
  return true;
}

function broadcast(msg) {
  if (!state.wss) return;
  const raw = JSON.stringify(msg);
  const recipients = [];
  for (const ws of state.wss.clients) {
    if (isAuthenticatedClient(ws)) {
      ws.send(raw);
      recipients.push(wsLabel(ws));
    }
  }
  if (msg.type === 'status' || msg.type === 'transcript_ready' || msg.type === 'turn_state') {
    log(`Broadcast ${msg.type} -> ${recipients.length} client(s)${recipients.length ? ` [${recipients.join(', ')}]` : ''}`);
  }
}

function autoResolveAllPendingApprovals(reason = '') {
  if (state.pendingApprovals.size === 0) return;
  for (const [id, approval] of state.pendingApprovals) {
    clearTimeout(approval.timer);
    approval.res.writeHead(200, { 'Content-Type': 'application/json' });
    approval.res.end(JSON.stringify({ decision: 'allow' }));
    log(`Permission #${id}: auto-allowed (${reason || 'effective mode switched to all'})`);
  }
  state.pendingApprovals.clear();
  broadcast({ type: 'clear_permissions' });
}

function recomputeEffectiveApprovalMode(reason = '') {
  const connectedHighest = computeConnectedHighestApprovalMode();
  const connectedScore = APPROVAL_MODE_ORDER[connectedHighest];
  const turnFloor = normalizeApprovalMode(state.turnApprovalFloorMode);
  const turnFloorScore = APPROVAL_MODE_ORDER[turnFloor];
  const floorActive = state.turnState.phase === 'running' && !!state.turnApprovalFloorMode;
  const nextMode = (floorActive && turnFloorScore > connectedScore) ? turnFloor : connectedHighest;
  if (state.approvalMode === nextMode) return nextMode;

  const prevMode = state.approvalMode;
  state.approvalMode = nextMode;
  log(`Approval mode effective: ${prevMode} -> ${nextMode}${reason ? ` (${reason})` : ''} connected=${connectedHighest} turnFloor=${floorActive ? turnFloor : 'none'} phase=${state.turnState.phase}`);
  if (nextMode === 'all' && prevMode !== 'all') {
    autoResolveAllPendingApprovals(reason || 'effective mode switched to all');
  }
  return nextMode;
}

function setClientApprovalMode(ws, mode, reason = '') {
  if (!ws) return state.approvalMode;
  const normalized = normalizeApprovalMode(mode);
  ws._approvalMode = normalized;
  log(`Approval mode reported by ${wsLabel(ws)}: ${normalized}${reason ? ` (${reason})` : ''}`);
  return recomputeEffectiveApprovalMode(`client mode update ${wsLabel(ws)}`);
}

function setTurnApprovalFloorMode(mode, reason = '') {
  const normalized = normalizeApprovalMode(mode);
  const prev = state.turnApprovalFloorMode || 'none';
  state.turnApprovalFloorMode = normalized;
  log(`Turn approval floor set: ${prev} -> ${normalized}${reason ? ` (${reason})` : ''}`);
  return normalized;
}

function clearTurnApprovalFloorMode(reason = '') {
  if (!state.turnApprovalFloorMode) return state.approvalMode;
  const prev = state.turnApprovalFloorMode;
  state.turnApprovalFloorMode = '';
  log(`Turn approval floor cleared: ${prev}${reason ? ` (${reason})` : ''}`);
  return recomputeEffectiveApprovalMode(`turn floor cleared${reason ? `: ${reason}` : ''}`);
}

function latestEventSeq() {
  return state.eventBuffer.length > 0 ? state.eventBuffer[state.eventBuffer.length - 1].seq : 0;
}

function getTurnStatePayload() {
  return {
    type: 'turn_state',
    phase: state.turnState.phase,
    sessionId: state.turnState.sessionId,
    version: state.turnState.version,
    updatedAt: state.turnState.updatedAt,
    reason: state.turnState.reason || '',
  };
}

function sendTurnState(ws, context = '') {
  return sendWs(ws, getTurnStatePayload(), context);
}

function setTurnState(phase, { sessionId = state.currentSessionId, reason = '', force = false } = {}) {
  const normalizedPhase = phase === 'running' ? 'running' : 'idle';
  const normalizedSessionId = sessionId || null;
  const changed = force ||
    state.turnState.phase !== normalizedPhase ||
    state.turnState.sessionId !== normalizedSessionId;

  if (!changed) return false;

  state.turnState = {
    phase: normalizedPhase,
    sessionId: normalizedSessionId,
    version: ++state.turnStateVersion,
    updatedAt: Date.now(),
    reason,
  };

  const modeReason = reason || `turn_state:${normalizedPhase}`;
  if (normalizedPhase !== 'running' && state.turnApprovalFloorMode) {
    clearTurnApprovalFloorMode(modeReason);
  } else {
    recomputeEffectiveApprovalMode(modeReason);
  }

  log(`Turn state -> phase=${state.turnState.phase} session=${state.turnState.sessionId ?? 'null'} version=${state.turnState.version}${reason ? ` reason=${reason}` : ''}`);
  broadcast(getTurnStatePayload());
  return true;
}

function emitInterrupt(source) {
  const interruptEvent = {
    type: 'interrupt',
    source,
    timestamp: Date.now(),
    uuid: crypto.randomUUID(),
  };
  const record = { seq: ++state.eventSeq, event: interruptEvent };
  state.eventBuffer.push(record);
  if (state.eventBuffer.length > EVENT_BUFFER_MAX) {
    state.eventBuffer = state.eventBuffer.slice(-Math.round(EVENT_BUFFER_MAX * 0.8));
  }
  broadcast({ type: 'log_event', seq: record.seq, event: interruptEvent });
  setTurnState('idle', { reason: `${source}_interrupt` });
}

function formatTtyInputChunk(chunk) {
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  return `len=${buf.length} hex=${buf.toString('hex')} base64=${buf.toString('base64')} utf8=${JSON.stringify(buf.toString('utf8'))}`;
}

module.exports = {
  log,
  wsLabel,
  isAuthenticatedClient,
  sendWs,
  broadcast,
  latestEventSeq,
  getTurnStatePayload,
  sendTurnState,
  setTurnState,
  recomputeEffectiveApprovalMode,
  setClientApprovalMode,
  setTurnApprovalFloorMode,
  clearTurnApprovalFloorMode,
  emitInterrupt,
  formatTtyInputChunk,
};
