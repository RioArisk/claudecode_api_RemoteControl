// ============================================================
//  Keyboard & Lifecycle events
// ============================================================
import { $ } from './utils.js';
import { S } from './state.js';
import { debugLog, wsReadyStateName } from './debug.js';
import { recoverConnectionOnForeground } from './websocket.js';

function updateKeyboardOffset() {
  if (!window.visualViewport) return;
  const viewportGap = Math.max(
    0,
    Math.round(window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop)
  );
  document.documentElement.style.setProperty('--keyboard-offset', `${viewportGap}px`);

  if (S.isAtBottom) {
    const $chat = $('chat-area');
    requestAnimationFrame(() => { $chat.scrollTop = $chat.scrollHeight; });
  }
}

function logLifecycleEvent(event) {
  debugLog(event, {
    hidden: typeof document !== 'undefined' ? !!document.hidden : null,
    visibilityState: typeof document !== 'undefined' ? document.visibilityState : null,
    focused: typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() : null,
    online: typeof navigator !== 'undefined' && 'onLine' in navigator ? !!navigator.onLine : null,
    wsState: wsReadyStateName(S.ws),
    waiting: S.waiting,
    sessionId: S.sessionId || null,
    lastSeq: S.lastSeq,
    replaying: S.replaying,
  });
}

export function initKeyboard() {
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', updateKeyboardOffset);
    window.visualViewport.addEventListener('scroll', updateKeyboardOffset);
    window.addEventListener('orientationchange', updateKeyboardOffset);
    updateKeyboardOffset();
  }

  window.addEventListener('focus', () => {
    logLifecycleEvent('window_focus');
    recoverConnectionOnForeground('window_focus');
  });
  window.addEventListener('blur', () => logLifecycleEvent('window_blur'));
  window.addEventListener('pageshow', () => {
    logLifecycleEvent('window_pageshow');
    recoverConnectionOnForeground('window_pageshow');
  });
  window.addEventListener('pagehide', () => logLifecycleEvent('window_pagehide'));
  window.addEventListener('online', () => {
    logLifecycleEvent('network_online');
    recoverConnectionOnForeground('network_online');
  });
  window.addEventListener('offline', () => logLifecycleEvent('network_offline'));
  document.addEventListener('visibilitychange', () => {
    const becameVisible = !document.hidden;
    logLifecycleEvent(becameVisible ? 'document_visible' : 'document_hidden');
    if (becameVisible) recoverConnectionOnForeground('document_visible');
  });

  // External links — open in system browser
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href) return;
    if (/^https?:\/\//i.test(href)) {
      e.preventDefault();
      e.stopPropagation();
      window.open(href, '_blank');
    }
  });
}
