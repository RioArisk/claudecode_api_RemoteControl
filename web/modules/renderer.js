// ============================================================
//  Renderer — message rendering engine
// ============================================================
import { JUNK_PATTERNS, HIDDEN_STEP_TOOLS, CHAT_CACHE_MAX_SESSION_BYTES } from './constants.js';
import { $, esc, trunc, stripImageTags, shortenPath, formatModel, formatTokens } from './utils.js';
import { S, serverAddr, serverCacheAddr } from './state.js';
import { debugLog } from './debug.js';
import { showToast } from './toast.js';
import {
  buildCacheKey, estimateCacheBytes,
  chatCacheRead, chatCacheWrite, chatCacheDelete, pruneChatCache,
} from './chat-cache.js';
import { scrollEnd, updateScrollBtn, setWaiting, switchToWorking, removeWorkingIndicator } from './waiting.js';
import { setSendButtonMode, updateSendBtn } from './input.js';
import { resetTodoState, restoreTodoSnapshot, getTodoSnapshot, renderTodoPanel, isTodoTool, handleTodoToolUse, handleTodoToolResult } from './todo.js';
import { clearPendingImage } from './image-upload.js';
import { resetInteractionState, registerInteractiveToolUse, resolveInteractiveToolResult, normalizePlanContent, presentNextPendingInteraction } from './interactions.js';
import { setConnBanner } from './websocket.js';
import { hideCmdOverlay } from './input.js';

const $msgs = $('messages');
const $chat = $('chat-area');
const $input = $('input');
const INPUT_PLACEHOLDER_DEFAULT = 'Reply...';

// ---- Tool Icons ----
const ICONS = {
  Bash:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 17l6-6-6-6"/><path d="M12 19h8"/></svg>',
  Read:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
  Edit:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
  Write:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
  Glob:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>',
  Grep:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>',
  WebFetch:   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  WebSearch:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  Task:       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
};
function iconFor(name) { return ICONS[name] || ICONS.Bash; }

function toolDesc(name, input) {
  if (!input) return '';
  switch (name) {
    case 'Bash': return input.description || input.command || '';
    case 'Read': return input.file_path || '';
    case 'Write': return input.file_path || '';
    case 'Edit': return input.file_path || '';
    case 'Glob': return input.pattern || '';
    case 'Grep': return input.pattern || '';
    case 'WebFetch': return input.url || '';
    case 'WebSearch': return input.query || '';
    case 'Task': return input.description || input.prompt || '';
    default: return JSON.stringify(input).substring(0, 80);
  }
}

function toolInputFull(name, input) {
  if (!input) return '';
  switch (name) {
    case 'Bash': return input.command || '';
    case 'Read': return input.file_path || '';
    case 'Write': return `${input.file_path || ''}\n${'─'.repeat(30)}\n${trunc(input.content, 800)}`;
    case 'Edit': {
      let s = (input.file_path || '') + '\n';
      if (input.old_string !== undefined) s += `- ${trunc(input.old_string, 300)}\n+ ${trunc(input.new_string, 300)}`;
      return s;
    }
    case 'Glob': return `pattern: ${input.pattern}${input.path ? '\npath: ' + input.path : ''}`;
    case 'Grep': return `pattern: ${input.pattern}${input.path ? '\npath: ' + input.path : ''}`;
    case 'WebFetch': return `${input.url}\n${input.prompt || ''}`;
    case 'WebSearch': return input.query || '';
    case 'Task': return `[${input.subagent_type || 'agent'}] ${input.description || ''}\n${trunc(input.prompt, 300)}`;
    default: return JSON.stringify(input, null, 2);
  }
}

// ---- Markdown ----
export function renderMd(text) {
  try {
    if (typeof marked === 'undefined') return esc(text);
    const html = marked.parse(text, { breaks: true, gfm: true });
    const d = document.createElement('div');
    d.innerHTML = html;
    if (typeof hljs !== 'undefined') {
      d.querySelectorAll('pre code').forEach(el => { try { hljs.highlightElement(el); } catch {} });
    }
    return d.innerHTML;
  } catch { return esc(text); }
}

// ---- Diff Rendering ----
function buildDiffHtml(oldStr, newStr, filePath, startLine) {
  const lineOffset = (startLine || 1) - 1;
  const oldLines = (oldStr || '').split('\n');
  const newLines = (newStr || '').split('\n');
  const m = oldLines.length, n = newLines.length;
  if (m * n > 500000) {
    return buildDiffFallback(oldLines, newLines, filePath, lineOffset);
  }

  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);

  const ops = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: 'ctx', text: oldLines[i - 1], oldLn: i, newLn: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'add', text: newLines[j - 1], newLn: j });
      j--;
    } else {
      ops.push({ type: 'del', text: oldLines[i - 1], oldLn: i });
      i--;
    }
  }
  ops.reverse();
  return renderDiffOps(ops, filePath, lineOffset);
}

function buildDiffFallback(oldLines, newLines, filePath, lineOffset) {
  const ops = [];
  oldLines.forEach((l, i) => ops.push({ type: 'del', text: l, oldLn: i + 1 }));
  newLines.forEach((l, i) => ops.push({ type: 'add', text: l, newLn: i + 1 }));
  return renderDiffOps(ops, filePath, lineOffset || 0);
}

function renderDiffOps(ops, filePath, lineOffset) {
  const off = lineOffset || 0;
  let addCount = 0, delCount = 0;
  ops.forEach(o => { if (o.type === 'add') addCount++; if (o.type === 'del') delCount++; });

  let rows = '';
  for (const o of ops) {
    const cls = o.type === 'del' ? 'diff-del' : o.type === 'add' ? 'diff-add' : 'diff-ctx';
    const sign = o.type === 'del' ? '-' : o.type === 'add' ? '+' : ' ';
    const rawLn = o.type === 'del' ? (o.oldLn || '') : (o.newLn || o.oldLn || '');
    const ln = rawLn !== '' ? rawLn + off : '';
    rows += `<tr class="${cls}"><td class="diff-ln">${ln}</td><td class="diff-sign">${sign}</td><td class="diff-code">${esc(o.text)}</td></tr>`;
  }

  const shortPath = shortenPath(filePath);
  return `<div class="diff-view">
    <div class="diff-header">
      <svg class="diff-file-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
      <span class="diff-file-path" title="${esc(filePath)}">${esc(shortPath)}</span>
      <span class="diff-stats"><span class="ds-add">+${addCount}</span> <span class="ds-del">-${delCount}</span></span>
    </div>
    <div class="diff-body"><table class="diff-table">${rows}</table></div>
  </div>`;
}

// ---- Step group management ----
export function closeGroup() {
  if (S.currentGroup) {
    S.currentGroup.querySelector('.step-count').textContent = S.currentGroupCount + ' steps';
    S.currentGroup = null;
    S.currentGroupCount = 0;
  }
}

function ensureGroup() {
  if (!S.currentGroup) {
    const g = document.createElement('div');
    g.className = 'step-group open';
    g.innerHTML = `
      <div class="step-group-header">
        <span class="step-chevron"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></span>
        <span class="step-count">steps</span>
      </div>
      <div class="step-list"></div>
    `;
    $msgs.appendChild(g);
    S.currentGroup = g;
    S.currentGroupCount = 0;
  }
  return S.currentGroup.querySelector('.step-list');
}

// ---- Welcome ----
function getWelcome() { return $('welcome'); }
export function removeWelcome() {
  const w = getWelcome();
  if (w && w.parentNode) w.remove();
}

export function getWelcomeMarkup() {
  return `<div class="welcome" id="welcome">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/></svg>
    <h2>Claude Remote Control</h2>
    <p>Connected. Send a message below to start.</p>
  </div>`;
}

// ---- Junk filtering ----
function isJunkContent(content) {
  if (typeof content !== 'string') return false;
  const t = content.trim();
  if (/^\/[a-z]+$/i.test(t)) return true;
  if (/^Set model to/i.test(t) || /Set model to/i.test(t.replace(/\x1B\[[0-9;]*m/g, ''))) return true;
  return JUNK_PATTERNS.some(p => p.test(t));
}

// ---- Model / Header ----
export function syncConfirmedModel(nextModel, { allowToast = false } = {}) {
  const normalized = String(nextModel || '').trim();
  if (!normalized) return false;
  const prevModel = S.model || '';
  if (prevModel === normalized) return false;
  S.model = normalized;
  updateHeaderInfo();
  if (allowToast && !S.replaying && prevModel) {
    showToast('Now using ' + formatModel(S.model));
  }
  return true;
}

export function updateHeaderInfo() {
  const pathStr = shortenPath(S.cwd);
  const model = formatModel(S.model);
  $('title').textContent = pathStr || 'Claude Remote';
  $('header-model').textContent = model;
}

// ---- Turn state ----
export function cacheTurnState(state) {
  if (!state) return;
  const nextVersion = Number.isInteger(state.version) ? state.version : 0;
  const pendingVersion = Number.isInteger(S.pendingTurnState?.version) ? S.pendingTurnState.version : -1;
  if (nextVersion < pendingVersion) return;
  S.pendingTurnState = state;
}

export function applyTurnState(state, reason = '') {
  if (!state) return;
  const nextVersion = Number.isInteger(state.version) ? state.version : 0;
  if (nextVersion < S.turnStateVersion) return;
  S.turnStateVersion = nextVersion;
  S.pendingTurnState = null;
  const shouldWait = state.phase === 'running';
  if (S.waiting !== shouldWait) {
    setWaiting(shouldWait, reason || `turn_state:${state.phase || 'idle'}`);
  }
}

// ---- Optimistic bubble ----
export function finalizeOptimisticBubble() {
  const opt = $msgs.querySelector('[data-optimistic]');
  if (!opt) return false;
  opt.removeAttribute('data-optimistic');
  return true;
}

export function hasOptimisticBubble() {
  return !!$msgs.querySelector('[data-optimistic]');
}

// ---- rebuildRuntimeStateFromDom ----
export function rebuildRuntimeStateFromDom() {
  S.messageMap.clear();
  S.toolMap.clear();
  S.currentGroup = null;
  S.currentGroupCount = 0;

  $msgs.querySelectorAll('[data-message-id]').forEach(el => {
    if (el.dataset.messageId) S.messageMap.set(el.dataset.messageId, el);
  });

  $msgs.querySelectorAll('.step-item[data-tool-id]').forEach(item => {
    const toolId = item.dataset.toolId;
    if (!toolId) return;
    const detail = document.getElementById(`detail-${toolId}`);
    S.toolMap.set(toolId, {
      item,
      detail,
      name: item.dataset.toolName || '',
      group: item.closest('.step-group'),
    });
  });

  const lastChild = $msgs.lastElementChild;
  if (lastChild && lastChild.classList.contains('step-group')) {
    S.currentGroup = lastChild;
    S.currentGroupCount = lastChild.querySelectorAll('.step-item').length;
  }
}

// ---- Clear conversation UI ----
export function clearConversationUi() {
  debugLog('clear_conversation_ui', {
    waiting: S.waiting,
    sessionId: S.sessionId || null,
    lastSeq: S.lastSeq,
    replaying: S.replaying,
  });
  if (S.cacheSaveTimer) {
    clearTimeout(S.cacheSaveTimer);
    S.cacheSaveTimer = null;
  }
  for (const [uploadId, waiter] of S.uploadWaiters) {
    waiter.reject(new Error('Upload reset'));
    S.uploadWaiters.delete(uploadId);
  }
  S.seenUuids.clear();
  S.messageMap.clear();
  S.toolMap.clear();
  S.currentGroup = null;
  S.currentGroupCount = 0;
  S.isAtBottom = true;
  S.waiting = false;
  S.workingEl = null;
  S.waitStartedAt = 0;
  S.lastSeq = 0;
  S.pendingPerms = [];
  S.pendingPlanContent = '';
  resetInteractionState();
  resetTodoState();
  clearPendingImage({ abortUpload: false });
  $msgs.innerHTML = getWelcomeMarkup();
  $('input-area').classList.remove('waiting');
  $input.disabled = false;
  $input.placeholder = INPUT_PLACEHOLDER_DEFAULT;
  setSendButtonMode('send');
  updateSendBtn();
  updateScrollBtn();
  setConnBanner(false);
  $('perm-overlay').classList.remove('visible');
}

// ---- Session cache integration ----
export async function restoreSessionCache(sessionId) {
  debugLog('restore_session_cache_start', { sessionId });
  if (!serverCacheAddr || !sessionId) return false;

  let record;
  try {
    record = await chatCacheRead(buildCacheKey(serverCacheAddr, sessionId));
  } catch {
    return false;
  }
  if (!record || !record.html) {
    debugLog('restore_session_cache_miss', { sessionId });
    return false;
  }

  $msgs.innerHTML = record.html;
  $msgs.querySelectorAll('[data-optimistic], .working-indicator').forEach(el => el.remove());
  S.seenUuids = new Set(Array.isArray(record.seenUuids) ? record.seenUuids : []);
  S.lastSeq = Number.isInteger(record.lastSeq) ? record.lastSeq : 0;
  S.cwd = record.cwd || S.cwd;
  S.model = record.model || '';
  restoreTodoSnapshot({
    tasks: Array.isArray(record.todoTasks) ? record.todoTasks : [],
    panelOpen: !!record.todoPanelOpen,
  });
  rebuildRuntimeStateFromDom();
  removeWorkingIndicator();
  $input.disabled = false;
  $('btn-send').disabled = false;
  $('input-area').classList.remove('waiting');
  $input.placeholder = INPUT_PLACEHOLDER_DEFAULT;
  updateHeaderInfo();
  updateSendBtn();
  updateScrollBtn();
  requestAnimationFrame(() => { $chat.scrollTop = $chat.scrollHeight; });
  debugLog('restore_session_cache_done', {
    sessionId,
    lastSeq: S.lastSeq,
    waiting: S.waiting,
  });
  return true;
}

export async function flushSessionCacheSave() {
  if (S.cacheSaveTimer) {
    clearTimeout(S.cacheSaveTimer);
    S.cacheSaveTimer = null;
  }
  await persistSessionCache();
}

async function persistSessionCache() {
  if (!serverCacheAddr || !S.sessionId) return;
  const todoSnapshot = getTodoSnapshot();
  const snapshotRoot = $msgs.cloneNode(true);
  snapshotRoot.querySelectorAll('[data-optimistic], .working-indicator').forEach(el => el.remove());
  const record = {
    cacheKey: buildCacheKey(serverCacheAddr, S.sessionId),
    serverAddr,
    sessionId: S.sessionId,
    html: snapshotRoot.innerHTML,
    seenUuids: Array.from(S.seenUuids),
    todoTasks: todoSnapshot.tasks,
    todoPanelOpen: todoSnapshot.panelOpen,
    cwd: S.cwd,
    model: S.model,
    lastSeq: S.lastSeq,
    updatedAt: Date.now(),
  };
  record.sizeBytes = estimateCacheBytes(record);

  try {
    if (record.sizeBytes > CHAT_CACHE_MAX_SESSION_BYTES) {
      await chatCacheDelete(record.cacheKey).catch(() => {});
      return;
    }
    await chatCacheWrite(record);
    await pruneChatCache();
  } catch (err) {
    console.warn('[chat-cache]', err);
  }
}

export function scheduleSessionCacheSave() {
  if (!serverCacheAddr || !S.sessionId) return;
  if (S.cacheSaveTimer) clearTimeout(S.cacheSaveTimer);
  S.cacheSaveTimer = setTimeout(async () => {
    S.cacheSaveTimer = null;
    await persistSessionCache();
  }, 250);
}

// ---- Plan card ----
export function renderPlanCard(planContent) {
  if ($msgs.querySelector('.plan-inline-card')) return;
  closeGroup();
  const el = document.createElement('div');
  el.className = 'plan-inline-card';
  el.innerHTML = `
    <div class="plan-inline-header">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12l2 2 4-4"/></svg>
      <span>执行计划</span>
    </div>
    <div class="plan-inline-body">${renderMd(planContent)}</div>
  `;
  $msgs.appendChild(el);
}

export function consumePendingPlanCard() {
  const plan = normalizePlanContent(S.pendingPlanContent);
  S.pendingPlanContent = '';
  if (!plan) return;
  renderPlanCard(plan);
  scrollEnd();
  scheduleSessionCacheSave();
}

// ---- Image overlay ----
function showImageOverlay(src) {
  let overlay = document.getElementById('image-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'image-overlay';
    overlay.className = 'image-overlay';
    overlay.addEventListener('click', () => overlay.classList.remove('visible'));
    overlay.innerHTML = '<img>';
    document.body.appendChild(overlay);
  }
  overlay.querySelector('img').src = src;
  overlay.classList.add('visible');
}

// ---- Event Processing ----
export function processEvent(evt, seq) {
  try {
    if (!evt) return;
    if (Number.isInteger(seq) && seq > S.lastSeq) S.lastSeq = seq;
    if (S.seenUuids.has(evt.uuid)) return;
    if (evt.uuid) S.seenUuids.add(evt.uuid);
    removeWelcome();

    if (evt.isCompactSummary) {
      renderCompactSummary(evt);
      scrollEnd();
      return;
    }

    if (evt.type === 'system' && evt.subtype === 'local_command') {
      const raw = (evt.content || '').replace(/<\/?local-command-stdout>/g, '').replace(/\x1B\[[0-9;]*m/g, '').trim();
      if (raw.includes('Total cost:')) {
        renderCostCard(raw);
        scrollEnd();
      }
      return;
    }

    if (evt.type === 'interrupt') {
      finalizeOptimisticBubble();
      renderInterruptBanner(evt);
      scrollEnd();
      return;
    }

    if (evt.type === 'user' && evt.message) {
      const c = evt.message.content;
      if (typeof c === 'string' && isJunkContent(c)) return;
      if (typeof c === 'string' && /^\[Request interrupted by user/.test(c.trim())) return;
      if (Array.isArray(c) && c.length === 1 && c[0].type === 'text' &&
          /^\[Request interrupted by user/.test(c[0].text)) return;
      const planPrefix = 'Implement the following plan:';
      const rawText = typeof c === 'string' ? c
        : (Array.isArray(c) && c.length >= 1 && c[0].type === 'text' ? c[0].text : '');
      if (rawText.trimStart().startsWith(planPrefix)) {
        let planBody = rawText.trimStart().slice(planPrefix.length).trim();
        const boilerplateIdx = planBody.indexOf('\nIf you need specific details from before exiting plan mode');
        if (boilerplateIdx !== -1) planBody = planBody.slice(0, boilerplateIdx).trim();
        if (planBody) {
          renderPlanCard(planBody);
          return;
        }
      }
    }
    if (evt.type === 'assistant' && evt.message) {
      const blocks = evt.message.content;
      if (Array.isArray(blocks) && blocks.length === 1 && blocks[0].type === 'text') {
        const txt = blocks[0].text;
        if (isJunkContent(txt)) return;
      }
    }

    if (evt.type === 'user' && evt.message) renderUser(evt);
    else if (evt.type === 'assistant' && evt.message) {
      if (S.waiting) switchToWorking();
      renderAssistant(evt);
    }
    scrollEnd();
    scheduleSessionCacheSave();
  } catch (e) {
    console.error('[processEvent]', e);
  }
}

// ---- User ----
function renderUser(evt) {
  const c = evt.message.content;
  if (Array.isArray(c)) {
    const imageBlocks = c.filter(b => b && b.type === 'image');
    const textBlocks = c.filter(b => b && b.type === 'text' && b.text);
    if (imageBlocks.length > 0 || textBlocks.length > 0) {
      closeGroup();
      if (finalizeOptimisticBubble()) return;

      const el = document.createElement('div');
      el.className = 'user-msg';
      let html = '';
      if (imageBlocks.length > 0) {
        html += imageBlocks.map(block => {
          const source = block.source && block.source.type === 'base64' ? block.source : null;
          if (!source || !source.data) return '';
          const mediaType = source.media_type || 'image/png';
          return `<img src="data:${mediaType};base64,${source.data}" style="max-width:200px;max-height:120px;border-radius:8px;display:block;margin-bottom:${textBlocks.length ? '6px' : '0'}">`;
        }).join('');
      }
      if (textBlocks.length > 0) {
        const cleaned = textBlocks.map(block => stripImageTags(block.text)).filter(Boolean);
        if (cleaned.length > 0) {
          html += cleaned.map(t => esc(t).replace(/\n/g, '<br>')).join('<br>');
        }
      }
      if (html) {
        el.innerHTML = html;
        $msgs.appendChild(el);
      }
      return;
    }
    for (const b of c) {
      if (b.type === 'tool_result') {
        resolveInteractiveToolResult(b);
        handleTodoToolResult(b, evt);
        attachResult(b);
      }
    }
    return;
  }
  if (typeof c === 'string') {
    const cleaned = stripImageTags(c);
    if (cleaned.trim()) {
      closeGroup();
      if (finalizeOptimisticBubble()) return;
      const el = document.createElement('div');
      el.className = 'user-msg';
      el.innerHTML = esc(cleaned).replace(/\n/g, '<br>');
      $msgs.appendChild(el);
    }
  }
}

// ---- Interrupt Banner ----
function renderInterruptBanner(evt) {
  closeGroup();
  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'position:relative;display:flex;align-items:center;margin:12px 0;overflow:hidden;';
  const line = document.createElement('div');
  line.style.cssText = 'position:absolute;left:0;right:0;top:50%;height:1px;background:var(--border);';
  wrapper.appendChild(line);
  const el = document.createElement('div');
  const isTerminal = evt.source === 'terminal';
  el.className = 'interrupt-banner' + (isTerminal ? ' terminal-interrupt' : ' user-interrupt');
  const label = isTerminal ? '终端中断' : '用户中断';
  const icon = isTerminal
    ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M7 15l3-3-3-3"/><line x1="13" y1="15" x2="17" y2="15"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  el.innerHTML = icon + '<span>' + label + '</span>';
  wrapper.appendChild(el);
  $msgs.appendChild(wrapper);
}

// ---- Cost Card ----
function renderCostCard(raw) {
  closeGroup();
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  let totalCost = '', apiDuration = '', wallDuration = '', codeChanges = '';
  const models = [];
  let inModels = false;

  for (const line of lines) {
    if (line.startsWith('Total cost:')) totalCost = line.replace('Total cost:', '').trim();
    else if (line.startsWith('Total duration (API):')) apiDuration = line.replace('Total duration (API):', '').trim();
    else if (line.startsWith('Total duration (wall):')) wallDuration = line.replace('Total duration (wall):', '').trim();
    else if (line.startsWith('Total code changes:')) codeChanges = line.replace('Total code changes:', '').trim();
    else if (line.startsWith('Usage by model:')) inModels = true;
    else if (inModels) {
      const m = line.match(/^(.+?):\s*(.+)\((\$[\d.]+)\)\s*$/);
      if (m) {
        models.push({ name: m[1].trim(), detail: m[2].trim().replace(/,\s*$/, ''), cost: m[3] });
      } else {
        const m2 = line.match(/^(.+?):\s*(.+)$/);
        if (m2) models.push({ name: m2[1].trim(), detail: m2[2].trim(), cost: '' });
      }
    }
  }

  const el = document.createElement('div');
  el.className = 'cost-card';
  el.innerHTML = `
    <div class="cost-header">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
      <span>费用概览</span>
    </div>
    <div class="cost-grid">
      <div class="cost-item"><div class="cost-label">总费用</div><div class="cost-value cost-highlight">${esc(totalCost)}</div></div>
      <div class="cost-item"><div class="cost-label">API 耗时</div><div class="cost-value">${esc(apiDuration)}</div></div>
      <div class="cost-item"><div class="cost-label">实际耗时</div><div class="cost-value">${esc(wallDuration)}</div></div>
      <div class="cost-item"><div class="cost-label">代码变更</div><div class="cost-value">${esc(codeChanges)}</div></div>
    </div>
    ${models.length ? `
    <div class="cost-models">
      <div class="cost-models-title">模型用量</div>
      ${models.map(m => `
        <div class="cost-model-row">
          <div class="cost-model-name">${esc(m.name)}</div>
          <div class="cost-model-detail">${esc(m.detail)}</div>
          ${m.cost ? `<div class="cost-model-cost">${esc(m.cost)}</div>` : ''}
        </div>
      `).join('')}
    </div>` : ''}
  `;
  $msgs.appendChild(el);
}

// ---- Compact Summary ----
function renderCompactSummary(evt) {
  hideCmdOverlay();
  $('input-area').classList.remove('waiting');
  if (S.waiting) setWaiting(false, 'compact_summary');

  closeGroup();
  S.messageMap.clear();
  S.toolMap.clear();
  S.currentGroup = null;
  S.currentGroupCount = 0;
  $msgs.innerHTML = '';

  const el = document.createElement('div');
  el.className = 'compact-divider';
  el.innerHTML = `
    <div class="compact-line"></div>
    <div class="compact-badge">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.66 0 3-4.03 3-9s-1.34-9-3-9m0 18c-1.66 0-3-4.03-3-9s1.34-9 3-9"/></svg>
      <span>历史对话已压缩</span>
    </div>
    <div class="compact-line"></div>
  `;
  $msgs.appendChild(el);
}

// ---- Assistant ----
function renderAssistant(evt) {
  const blocks = evt.message.content || [];
  const msgId = evt.message.id;
  const usage = evt.message.usage;

  syncConfirmedModel(evt.message.model, { allowToast: true });

  for (const b of blocks) {
    try {
      if (b.type === 'thinking' && b.thinking) renderThinking(b);
      else if (b.type === 'text' && b.text) { closeGroup(); renderText(b.text, msgId); }
      else if (b.type === 'tool_use') {
        const toolName = b.name || '';
        if (isTodoTool(toolName)) {
          handleTodoToolUse(b);
        }
        if (registerInteractiveToolUse(b)) {
          // handled by interaction state machine
        } else if (!HIDDEN_STEP_TOOLS.has(toolName)) {
          renderTool(b);
        }
      }
    } catch (e) {
      console.error('[renderBlock]', e);
    }
  }

  if (usage && evt.message.stop_reason) {
    const total = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) +
                  (usage.cache_creation_input_tokens || 0) + (usage.output_tokens || 0);
    if (total > 0 && S.currentGroup) {
      let tc = S.currentGroup.querySelector('.token-count');
      if (!tc) {
        tc = document.createElement('div');
        tc.className = 'token-count';
        S.currentGroup.appendChild(tc);
      }
      tc.textContent = formatTokens(total);
    }
  }
}

function renderText(text, msgId) {
  let el = S.messageMap.get(msgId);
  if (!el) {
    el = document.createElement('div');
    el.className = 'assistant-text';
    if (msgId) el.dataset.messageId = msgId;
    S.messageMap.set(msgId, el);
    $msgs.appendChild(el);
  }
  const d = document.createElement('div');
  d.innerHTML = renderMd(text);
  el.appendChild(d);
}

function renderThinking(b) {
  closeGroup();
  const el = document.createElement('div');
  el.className = 'thinking';
  const preview = trunc(b.thinking.replace(/\n/g, ' '), 60);
  el.innerHTML = `
    <div class="thinking-toggle">
      <span class="thinking-chevron"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg></span>
      <span>Thinking</span>
      <span style="color:var(--text-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">${esc(preview)}</span>
    </div>
    <div class="thinking-content">${esc(b.thinking)}</div>
  `;
  $msgs.appendChild(el);
}

function renderTool(b) {
  const list = ensureGroup();
  S.currentGroupCount++;
  S.currentGroup.querySelector('.step-count').textContent = S.currentGroupCount + ' steps';

  const desc = toolDesc(b.name, b.input);
  const item = document.createElement('div');
  item.className = 'step-item loading';
  item.dataset.toolId = b.id || '';
  item.dataset.toolName = b.name || '';
  item.innerHTML = `
    <div class="step-icon">${iconFor(b.name)}</div>
    <span class="step-name">${esc(b.name)}</span>
    <span class="step-desc">${esc(trunc(desc, 40))}</span>
    <span class="step-duration" id="dur-${b.id}"></span>
    <span class="step-arrow"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></span>
  `;

  const detail = document.createElement('div');
  detail.className = 'step-detail';
  detail.id = `detail-${b.id}`;
  const inputFull = toolInputFull(b.name, b.input);
  const isEdit = b.name === 'Edit' && b.input && b.input.old_string !== undefined;
  if (isEdit) {
    detail.innerHTML = buildDiffHtml(b.input.old_string, b.input.new_string, b.input.file_path, b.input._startLine);
  } else {
    detail.innerHTML = `
      <div class="detail-input">${esc(inputFull)}</div>
      <div class="detail-result" id="result-${b.id}"></div>
    `;
  }

  list.appendChild(item);
  list.appendChild(detail);
  S.toolMap.set(b.id, { item, detail, name: b.name, group: S.currentGroup });
}

function attachResult(b) {
  const info = S.toolMap.get(b.tool_use_id);
  if (!info) return;
  info.item.classList.remove('loading');
  const isErr = b.is_error === true;
  if (isErr) info.detail.classList.add('error');

  let text = '';
  let images = [];
  if (typeof b.content === 'string') {
    text = b.content;
  } else if (Array.isArray(b.content)) {
    const textParts = [];
    for (const c of b.content) {
      if (c.type === 'image' && c.source && c.source.data) {
        const mediaType = c.source.media_type || 'image/png';
        images.push({ data: c.source.data, mediaType });
      } else if (c.text) {
        textParts.push(c.text);
      } else {
        textParts.push(JSON.stringify(c));
      }
    }
    text = textParts.join('\n');
  }

  const resultEl = info.detail.querySelector('.detail-result');
  if (resultEl) {
    resultEl.textContent = trunc(text, 3000);
    if (isErr) resultEl.style.color = 'var(--error)';
  }

  if (images.length > 0) {
    closeGroup();
    for (const img of images) {
      const wrapper = document.createElement('div');
      wrapper.className = 'result-image-block';
      const imgEl = document.createElement('img');
      imgEl.src = `data:${img.mediaType};base64,${img.data}`;
      imgEl.addEventListener('click', () => showImageOverlay(imgEl.src));
      wrapper.appendChild(imgEl);
      $msgs.appendChild(wrapper);
    }
    scrollEnd();
  }
}

// ---- Init delegated click handlers ----
export function initRenderer() {
  $msgs.addEventListener('click', (e) => {
    const toggle = e.target.closest('.thinking-toggle');
    if (toggle) { toggle.parentElement.classList.toggle('open'); return; }
    const header = e.target.closest('.step-group-header');
    if (header) { header.parentElement.classList.toggle('open'); return; }
    const item = e.target.closest('.step-item');
    if (item) {
      const toolId = item.dataset.toolId;
      const detail = toolId && document.getElementById(`detail-${toolId}`);
      if (detail) detail.classList.toggle('open');
    }
  });
}

