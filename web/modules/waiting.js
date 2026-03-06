// ============================================================
//  Waiting / Working indicator + Scroll
// ============================================================
import { $ } from './utils.js';
import { formatElapsed } from './utils.js';
import { S } from './state.js';
import { debugLog } from './debug.js';
import { setSendButtonMode, updateSendBtn } from './input.js';

const $msgs = $('messages');
const $chat = $('chat-area');
const $input = $('input');
const INPUT_PLACEHOLDER_DEFAULT = 'Reply...';
const INPUT_PLACEHOLDER_WAITING = 'AI 思考中…';

export function scrollEnd() {
  keepWorkingAtBottom();
  if (S.isAtBottom) requestAnimationFrame(() => { $chat.scrollTop = $chat.scrollHeight; });
}

export function updateScrollBtn() {
  $('btn-scroll').classList.toggle('visible', !S.isAtBottom);
}

export function setWaiting(on, reason = '') {
  debugLog(on ? 'waiting_on' : 'waiting_off', {
    reason,
    waitingBefore: S.waiting,
    sessionId: S.sessionId || null,
    lastSeq: S.lastSeq,
    replaying: S.replaying,
  });
  S.waiting = on;
  if (on) {
    S.waitStartedAt = Date.now();
  } else {
    S.waitStartedAt = 0;
  }
  $input.disabled = on;
  $input.placeholder = on ? INPUT_PLACEHOLDER_WAITING : INPUT_PLACEHOLDER_DEFAULT;
  $('input-area').classList.toggle('waiting', on);

  if (on) {
    setSendButtonMode('stop');
    removeWorkingIndicator();
    const el = document.createElement('div');
    el.className = 'working-indicator';
    el.innerHTML = '<div class="working-spinner"></div><span class="working-text">Thinking</span>';
    $msgs.appendChild(el);
    S.workingEl = el;
    scrollEnd();
  } else {
    setSendButtonMode('send');
    showElapsedTime();
    removeWorkingIndicator();
  }
  updateSendBtn();
}

export function switchToWorking() {
  if (S.workingEl) {
    const txt = S.workingEl.querySelector('.working-text');
    if (txt) txt.textContent = 'Working';
  }
}

export function keepWorkingAtBottom() {
  if (S.workingEl && S.workingEl.parentNode) {
    $msgs.appendChild(S.workingEl);
  }
}

export function showElapsedTime() {
  if (!S.waitStartedAt) return;
  const elapsed = Date.now() - S.waitStartedAt;
  if (elapsed < 1000) return;
  const el = document.createElement('div');
  el.className = 'elapsed-time';
  el.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span>${formatElapsed(elapsed)}</span>`;
  $msgs.appendChild(el);
}

export function removeWorkingIndicator() {
  if (S.workingEl && S.workingEl.parentNode) S.workingEl.remove();
  S.workingEl = null;
}

export function initWaiting() {
  $chat.addEventListener('scroll', () => {
    S.isAtBottom = ($chat.scrollHeight - $chat.scrollTop - $chat.clientHeight) < 60;
    updateScrollBtn();
  });
}
