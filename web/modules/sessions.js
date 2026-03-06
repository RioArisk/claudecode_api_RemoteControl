// ============================================================
//  Session Drawer
// ============================================================
import { $, esc, trunc } from './utils.js';
import { S } from './state.js';
import { showConfirm } from './confirm.js';

export let sessionListCache = [];

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

export function getSessionCwd(session) {
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

export function renderSessionList(sessions) {
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

export function initSessions() {
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
}
