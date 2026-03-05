// ============================================================
//  App State
// ============================================================

export const S = {
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
  replaying: true,
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

export const dirBrowserState = {
  cwd: '',
  parent: null,
  roots: [],
  entries: [],
};

export let serverAddr = '';
export let serverWsUrl = '';
export let serverCacheAddr = '';
export let serverToken = '';
export let pendingImage = null;
export let approvalMode = localStorage.getItem('approvalMode') || 'default';

export function setServerAddr(v) { serverAddr = v; }
export function setServerWsUrl(v) { serverWsUrl = v; }
export function setServerCacheAddr(v) { serverCacheAddr = v; }
export function setServerToken(v) { serverToken = v; }
export function setPendingImage(v) { pendingImage = v; }
export function setApprovalModeValue(v) { approvalMode = v; }
