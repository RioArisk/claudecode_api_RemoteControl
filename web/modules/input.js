// ============================================================
//  Input handling & slash commands
// ============================================================
import { COMMANDS } from './constants.js';
import { $, esc } from './utils.js';
import { S, pendingImage } from './state.js';
import { debugLog } from './debug.js';
import { showToast } from './toast.js';
import { scrollEnd } from './waiting.js';
import { removeWelcome, closeGroup, scheduleSessionCacheSave, clearConversationUi } from './renderer.js';
import { showModelPicker } from './model-picker.js';
import { submitPendingImageUpload, updateImagePreviewUi } from './image-upload.js';
import { setWaiting } from './waiting.js';

const $input = $('input');
const $msgs = $('messages');

let cmdMenuOpen = false;
let cmdActiveIdx = -1;

export function updateSendBtn() {
  const btn = $('btn-send');
  if (S.waiting) {
    btn.classList.remove('empty');
    return;
  }
  const empty = !$input.value.trim() && !pendingImage;
  btn.classList.toggle('empty', empty);
}

export function setSendButtonMode(mode) {
  const btn = $('btn-send');
  btn.disabled = false;
  if (mode === 'stop') {
    btn.classList.add('stop-mode');
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    btn.title = 'Stop';
    return;
  }
  btn.classList.remove('stop-mode');
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  btn.title = 'Send';
}

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

function normalizeSlashCommandInput(text) {
  const value = String(text || '').trim();
  if (!value) return '';
  const match = value.match(/^(\/[^\s]+)/);
  if (!match || match[0] !== value) return '';
  return match[1].toLowerCase();
}

function execCmd(cmd) {
  cmd = normalizeSlashCommandInput(cmd) || String(cmd || '').trim().toLowerCase();
  hideCmdMenu();
  $input.value = '';
  $input.style.height = 'auto';
  updateSendBtn();

  if (cmd === '/model') {
    showModelPicker();
    return;
  }

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

  if (cmd === '/clear') {
    clearConversationUi();
    S.sessionId = '';
    S.resumeRequestedFor = '';
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

export function sendSlashCmd(text) {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  S.ws.send(JSON.stringify({ type: 'chat', text }));
}

export function sendControlInput(data) {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  S.ws.send(JSON.stringify({ type: 'input', data: String(data) }));
}

export function sendControlEnter() {
  sendControlInput('\r');
}

export function sendControlLine(text, { startDelayMs = 0, submitDelayMs = 120 } = {}) {
  setTimeout(() => {
    if (S.ws?.readyState === WebSocket.OPEN) sendControlInput(text);
  }, startDelayMs);
  setTimeout(() => {
    if (S.ws?.readyState === WebSocket.OPEN) sendControlEnter();
  }, startDelayMs + submitDelayMs);
}

export function showCmdOverlay(label) {
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

export function hideCmdOverlay() {
  const ov = $('cmd-overlay');
  if (ov) ov.classList.remove('visible');
}

export function send() {
  if (S.waiting) {
    if (S.ws && S.ws.readyState === WebSocket.OPEN && S.authenticated) {
      S.ws.send(JSON.stringify({ type: 'interrupt' }));
    }
    return;
  }
  const t = $input.value.trim();
  const hasImage = !!pendingImage;
  if ((!t && !hasImage) || !S.ws || S.ws.readyState !== WebSocket.OPEN || !S.authenticated) return;
  debugLog('send_invoked', {
    hasImage,
    textPreview: t.slice(0, 80),
    sessionId: S.sessionId || null,
    waiting: S.waiting,
  });

  const slashCommand = normalizeSlashCommandInput(t);
  if (!hasImage && COMMANDS.some(command => command.name === slashCommand)) {
    execCmd(slashCommand);
    return;
  }

  removeWelcome(); closeGroup();

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

  if (hasImage && pendingImage.status === 'uploaded') {
    submitPendingImageUpload().catch(err => {
      if (pendingImage) {
        pendingImage.status = 'failed';
        updateImagePreviewUi();
      }
      setWaiting(false, 'image_submit_failed');
      showToast(err.message || 'Image submit failed');
    });
  }
}

export function initInput() {
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
  $('btn-scroll').addEventListener('click', () => {
    const chat = $('chat-area');
    chat.scrollTop = chat.scrollHeight;
  });
}
