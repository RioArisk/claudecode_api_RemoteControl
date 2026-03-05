// ============================================================
//  Directory Picker
// ============================================================
import { $, esc, shortenPath, normalizePathForCompare } from './utils.js';
import { S, dirBrowserState } from './state.js';
import { showToast } from './toast.js';
import { showConfirm } from './confirm.js';
import { sessionListCache, getSessionCwd } from './sessions.js';
import { closeSettings } from './settings.js';

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

export function renderDirBrowser(payload) {
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

export function updateSettingsCwd() {
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

export function initDirPicker() {
  $('dir-drawer-close').addEventListener('click', closeDirPicker);
  $('dir-overlay').addEventListener('click', e => {
    if (e.target === $('dir-overlay')) closeDirPicker();
  });
  $('btn-select-cwd').addEventListener('click', async () => {
    if (!dirBrowserState.cwd) return;
    closeDirPicker();
    await confirmChangeCwd(dirBrowserState.cwd);
  });
  $('btn-change-cwd').addEventListener('click', () => openDirPicker(S.cwd));
  $('settings-cwd-input').addEventListener('click', () => openDirPicker(S.cwd));
}
