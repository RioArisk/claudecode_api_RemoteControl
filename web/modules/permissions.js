// ============================================================
//  Permissions
// ============================================================
import { $ } from './utils.js';
import { S } from './state.js';

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

export function showPermission(m) {
  if (!m || !m.id) return;
  if (S.pendingPerms.some(item => item.id === m.id)) return;
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
  if (S.pendingPerms.length === 0 || !S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  const p = S.pendingPerms.shift();
  S.ws.send(JSON.stringify({
    type: 'permission_response',
    id: p.id,
    decision,
  }));
  showNextPerm();
}

export function dismissPermissionById(id) {
  const permId = typeof id === 'string' ? id : '';
  if (!permId) return;
  const idx = S.pendingPerms.findIndex(item => item.id === permId);
  if (idx === -1) return;
  const wasCurrent = idx === 0;
  S.pendingPerms.splice(idx, 1);
  if (S.pendingPerms.length === 0) {
    $('perm-overlay').classList.remove('visible');
    updatePermCounter();
    return;
  }
  if (wasCurrent) showNextPerm();
  else updatePermCounter();
}

export function clearPermissions() {
  S.pendingPerms = [];
  $('perm-overlay').classList.remove('visible');
  updatePermCounter();
}

export function initPermissions() {
  $('perm-allow').addEventListener('click', () => resolvePermission('allow'));
  $('perm-deny').addEventListener('click', () => resolvePermission('deny'));
}
