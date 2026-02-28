// ============================================================
//  Claude Remote — Android Client (Tauri 2.0)
//  Connects to a running server.js bridge via WebSocket
// ============================================================

const $ = id => document.getElementById(id);

// ============================================================
//  Connection Screen
// ============================================================
const STORAGE_KEY = 'claude_remote_servers';
const LAST_KEY = 'claude_remote_last';

function getSavedServers() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; }
}
function saveServer(addr) {
  let list = getSavedServers();
  list = list.filter(a => a !== addr);
  list.unshift(addr);
  if (list.length > 5) list = list.slice(0, 5);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  localStorage.setItem(LAST_KEY, addr);
}
function removeServer(addr) {
  let list = getSavedServers().filter(a => a !== addr);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function renderHistory() {
  const container = $('connect-history');
  const list = getSavedServers();
  container.innerHTML = list.map(addr => {
    const safe = esc(addr);
    return `<span class="history-chip" data-addr="${safe}">
      <span>${safe}</span>
      <button class="remove-chip" data-remove="${safe}">&times;</button>
    </span>`;
  }).join('');

  container.querySelectorAll('.history-chip').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('remove-chip')) {
        e.stopPropagation();
        removeServer(e.target.dataset.remove);
        renderHistory();
        return;
      }
      $('server-addr').value = el.dataset.addr;
    });
  });
}

// Restore last address
const lastAddr = localStorage.getItem(LAST_KEY);
if (lastAddr) $('server-addr').value = lastAddr;
renderHistory();

let serverAddr = '';
let pendingImage = null; // { base64, mediaType, name }

$('btn-connect').addEventListener('click', tryConnect);
$('server-addr').addEventListener('keydown', e => {
  if (e.key === 'Enter') tryConnect();
});

function tryConnect() {
  let addr = $('server-addr').value.trim();
  if (!addr) { $('connect-error').textContent = 'Please enter a server address'; return; }

  // Normalize: strip protocol if entered
  addr = addr.replace(/^https?:\/\//, '').replace(/^wss?:\/\//, '').replace(/\/$/, '');
  serverAddr = addr;

  $('connect-error').textContent = '';
  $('btn-connect').classList.add('connecting');
  $('btn-connect').querySelector('span').textContent = 'Connecting...';

  connect();
}

function showConnectScreen() {
  $('connect-screen').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('btn-connect').classList.remove('connecting');
  $('btn-connect').querySelector('span').textContent = 'Connect';
  renderHistory();
}

function showApp() {
  $('connect-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  saveServer(serverAddr);
  renderHistory();
}

// ============================================================
//  App State
// ============================================================
const S = {
  ws: null,
  seenUuids: new Set(),
  messageMap: new Map(),
  toolMap: new Map(),
  currentGroup: null,
  currentGroupCount: 0,
  isAtBottom: true,
  waiting: false,
  thinkingEl: null,
  cwd: '',
  model: '',
  mode: 'default',
  pendingPerms: [],
  waitStartedAt: 0,
  replaying: true,           // true during history replay, false after replay_done
  reconnectTimer: null,
  intentionalDisconnect: false,
};

const $msgs = $('messages'), $chat = $('chat-area'), $input = $('input');
const INPUT_PLACEHOLDER_DEFAULT = 'Reply...';
const INPUT_PLACEHOLDER_WAITING = 'AI 思考中…';

// ============================================================
//  Utilities
// ============================================================
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function trunc(s, n) { return (!s || s.length <= n) ? s : s.substring(0, n) + '...'; }

function showToast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function renderMd(text) {
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

function formatTokens(n) {
  if (!n) return '';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k tokens';
  return n + ' tokens';
}

// Dynamic welcome getter (not cached — survives resetAppState)
function getWelcome() { return $('welcome'); }
function removeWelcome() {
  const w = getWelcome();
  if (w && w.parentNode) w.remove();
}

// Auto-scroll
$chat.addEventListener('scroll', () => {
  S.isAtBottom = ($chat.scrollHeight - $chat.scrollTop - $chat.clientHeight) < 60;
  updateScrollBtn();
});
function scrollEnd() {
  if (S.isAtBottom) requestAnimationFrame(() => { $chat.scrollTop = $chat.scrollHeight; });
}

// ============================================================
//  Waiting / Thinking indicator
// ============================================================
function setWaiting(on) {
  S.waiting = on;
  if (on) {
    S.waitStartedAt = Date.now();
  } else {
    S.waitStartedAt = 0;
  }
  $input.disabled = on;
  $('btn-send').disabled = on;
  $input.placeholder = on ? INPUT_PLACEHOLDER_WAITING : INPUT_PLACEHOLDER_DEFAULT;
  $('input-area').classList.toggle('waiting', on);
  if (on) {
    removeThinkingIndicator();
    const el = document.createElement('div');
    el.className = 'thinking-indicator';
    el.innerHTML = '<div class="dot-pulse"><span></span><span></span><span></span></div><span>Thinking...</span>';
    $msgs.appendChild(el);
    S.thinkingEl = el;
    scrollEnd();
  } else {
    removeThinkingIndicator();
  }
  updateSendBtn();
}

function removeThinkingIndicator() {
  if (S.thinkingEl && S.thinkingEl.parentNode) S.thinkingEl.remove();
  S.thinkingEl = null;
}

function updateSendBtn() {
  const empty = !$input.value.trim() && !pendingImage;
  $('btn-send').classList.toggle('empty', empty && !S.waiting);
}

function updateScrollBtn() {
  $('btn-scroll').classList.toggle('visible', !S.isAtBottom);
}

function shortenPath(p) {
  if (!p) return '';
  const parts = p.replace(/\\/g, '/').replace(/\/$/, '').split('/');
  if (parts.length <= 2) return parts.join('/');
  return parts.slice(-2).join('/');
}

function formatModel(m) {
  if (!m) return '';
  return m.replace(/^claude-/, '').replace(/-(\d)/g, ' $1').replace(/-/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function updateHeaderInfo() {
  const pathStr = shortenPath(S.cwd);
  const model = formatModel(S.model);
  $('title').textContent = pathStr || 'Claude Remote';
  $('header-model').textContent = model;
}

// ============================================================
//  Tool Icons (SVG)
// ============================================================
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

// ============================================================
//  Diff Rendering
// ============================================================
function buildDiffHtml(oldStr, newStr, filePath) {
  const oldLines = (oldStr || '').split('\n');
  const newLines = (newStr || '').split('\n');

  // Simple LCS-based diff
  const m = oldLines.length, n = newLines.length;
  // Optimisation: limit to reasonable size to avoid O(m*n) blowup
  if (m * n > 500000) {
    // Fallback: show all old as deleted, all new as added
    return buildDiffFallback(oldLines, newLines, filePath);
  }

  // Build LCS table
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);

  // Backtrack to produce diff ops
  const ops = []; // { type: 'ctx'|'del'|'add', text, oldLn?, newLn? }
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

  return renderDiffOps(ops, filePath);
}

function buildDiffFallback(oldLines, newLines, filePath) {
  const ops = [];
  oldLines.forEach((l, i) => ops.push({ type: 'del', text: l, oldLn: i + 1 }));
  newLines.forEach((l, i) => ops.push({ type: 'add', text: l, newLn: i + 1 }));
  return renderDiffOps(ops, filePath);
}

function renderDiffOps(ops, filePath) {
  let addCount = 0, delCount = 0;
  ops.forEach(o => { if (o.type === 'add') addCount++; if (o.type === 'del') delCount++; });

  let rows = '';
  for (const o of ops) {
    const cls = o.type === 'del' ? 'diff-del' : o.type === 'add' ? 'diff-add' : 'diff-ctx';
    const sign = o.type === 'del' ? '-' : o.type === 'add' ? '+' : ' ';
    const oldN = o.oldLn != null ? o.oldLn : '';
    const newN = o.newLn != null ? o.newLn : '';
    rows += `<tr class="${cls}"><td class="diff-ln">${oldN}</td><td class="diff-ln">${newN}</td><td class="diff-sign">${sign}</td><td class="diff-code">${esc(o.text)}</td></tr>`;
  }

  const ext = (filePath || '').split('.').pop() || '';
  const shortPath = shortenPath(filePath);

  return `<div class="diff-view">
    <div class="diff-header">
      <svg class="diff-file-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
      <span class="diff-file-path" title="${esc(filePath)}">${esc(shortPath)}</span>
      <span class="diff-stats"><span class="ds-add">+${addCount}</span><span class="ds-del">-${delCount}</span></span>
    </div>
    <div class="diff-body"><table class="diff-table">${rows}</table></div>
  </div>`;
}

// ============================================================
//  Rendering — step group management
// ============================================================
function closeGroup() {
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
      <div class="step-group-header" onclick="this.parentElement.classList.toggle('open')">
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

// ============================================================
//  Event Processing
// ============================================================
const JUNK_PATTERNS = [
  /^Caveat:/i,
  /^<local-command/,
  /^<command-name>/,
  /^<command-message>/,
  /^<command-args>/,
  /^<local-command-stdout>/,
  /^<\/local-command/,
];

function isJunkContent(content) {
  if (typeof content !== 'string') return false;
  const t = content.trim();
  if (/^\/[a-z]+$/i.test(t)) return true;
  if (/^Set model to/i.test(t) || /Set model to/i.test(t.replace(/\x1B\[[0-9;]*m/g, ''))) return true;
  return JUNK_PATTERNS.some(p => p.test(t));
}

function isAssistantTurnDone(evt) {
  if (!evt || evt.type !== 'assistant' || !evt.message) return false;
  const sr = evt.message.stop_reason;
  if (!sr) return false;
  // tool_use means Claude is still in the same turn (tool running / awaiting result).
  return sr !== 'tool_use';
}

function isCurrentWaitingTurnEvent(evt) {
  if (!S.waiting || !evt || evt.type !== 'assistant' || !evt.message) return false;

  const ts = Date.parse(evt.timestamp || '');
  if (Number.isFinite(ts) && S.waitStartedAt && ts < (S.waitStartedAt - 1500)) {
    return false;
  }
  return true;
}

function processEvent(evt) {
  try {
    if (!evt) return;
    if (S.seenUuids.has(evt.uuid)) return;
    if (evt.uuid) S.seenUuids.add(evt.uuid);
    removeWelcome();

    // Compact summary: collapse all previous messages
    if (evt.isCompactSummary) {
      renderCompactSummary(evt);
      scrollEnd();
      return;
    }

    if (evt.type === 'user' && evt.message) {
      const c = evt.message.content;
      if (typeof c === 'string' && isJunkContent(c)) return;
    }
    if (evt.type === 'assistant' && evt.message) {
      const blocks = evt.message.content;
      if (Array.isArray(blocks) && blocks.length === 1 && blocks[0].type === 'text') {
        const txt = blocks[0].text;
        const modelMatch = txt.match(/Set model to.*?\(([^)]+)\)/i) ||
                            txt.replace(/\x1B\[[0-9;]*m/g, '').match(/Set model to.*?\(([^)]+)\)/i);
        if (modelMatch) {
          S.model = modelMatch[1];
          updateHeaderInfo();
          showToast('Model switched to ' + formatModel(S.model));
        }
        if (isJunkContent(txt)) return;
      }
    }

    if (evt.type === 'user' && evt.message) renderUser(evt);
    else if (evt.type === 'assistant' && evt.message) {
      const isCurrentTurn = isCurrentWaitingTurnEvent(evt);
      // Keep input locked while assistant turn is active; only remove spinner on first valid reply chunk.
      if (isCurrentTurn) removeThinkingIndicator();
      renderAssistant(evt);
      if (isCurrentTurn && isAssistantTurnDone(evt)) setWaiting(false);
    }
    scrollEnd();
  } catch (e) {
    console.error('[processEvent]', e);
  }
}

// --- User ---
function renderUser(evt) {
  const c = evt.message.content;
  if (Array.isArray(c)) {
    for (const b of c) {
      if (b.type === 'tool_result') {
        handleTodoToolResult(b, evt);
        attachResult(b);
      }
    }
    return;
  }
  if (typeof c === 'string' && c.trim()) {
    closeGroup();
    const opt = $msgs.querySelector('[data-optimistic]');
    if (opt) { opt.removeAttribute('data-optimistic'); return; }
    const el = document.createElement('div');
    el.className = 'user-msg';
    el.innerHTML = esc(c).replace(/\n/g, '<br>');
    $msgs.appendChild(el);
  }
}

// --- Compact Summary ---
function renderCompactSummary(evt) {
  // Dismiss the command overlay
  hideCmdOverlay();
  $('input-area').classList.remove('waiting');
  if (S.waiting) setWaiting(false);

  // Collapse all previous messages into one indicator
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

const HIDDEN_STEP_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'AskUserQuestion', 'ExitPlanMode']);

// --- Assistant ---
function renderAssistant(evt) {
  const blocks = evt.message.content || [];
  const msgId = evt.message.id;
  const usage = evt.message.usage;

  if (!S.model && evt.message.model) {
    S.model = evt.message.model;
    updateHeaderInfo();
  }

  for (const b of blocks) {
    try {
      if (b.type === 'thinking' && b.thinking) renderThinking(b);
      else if (b.type === 'text' && b.text) { closeGroup(); renderText(b.text, msgId); }
      else if (b.type === 'tool_use') {
        const toolName = b.name || '';
        // Todo tools — intercept for panel state
        if (isTodoTool(toolName)) {
          handleTodoToolUse(b);
        }
        if (toolName === 'AskUserQuestion' && b.input && b.input.questions) {
          if (!S.replaying) showQuestion(b.input.questions);
        } else if (toolName === 'ExitPlanMode') {
          if (!S.replaying) showPlanApproval(b.input);
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
    <div class="thinking-toggle" onclick="this.parentElement.classList.toggle('open')">
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

  // Edit tool: render diff view
  const isEdit = b.name === 'Edit' && b.input && b.input.old_string !== undefined;
  if (isEdit) {
    detail.innerHTML = buildDiffHtml(b.input.old_string, b.input.new_string, b.input.file_path)
      + `<div class="detail-result" id="result-${b.id}"></div>`;
  } else {
    detail.innerHTML = `
      <div class="detail-input">${esc(inputFull)}</div>
      <div class="detail-result" id="result-${b.id}"></div>
    `;
  }

  item.addEventListener('click', () => detail.classList.toggle('open'));
  list.appendChild(item);
  list.appendChild(detail);

  S.toolMap.set(b.id, { item, detail, name: b.name, group: S.currentGroup });
}

function attachResult(b) {
  const info = S.toolMap.get(b.tool_use_id);
  if (!info) return;

  // Stop loading animation
  info.item.classList.remove('loading');

  const isErr = b.is_error === true;
  if (isErr) info.detail.classList.add('error');

  let text = '';
  if (typeof b.content === 'string') text = b.content;
  else if (Array.isArray(b.content)) text = b.content.map(c => c.text || JSON.stringify(c)).join('\n');

  const resultEl = info.detail.querySelector('.detail-result');
  if (resultEl) {
    resultEl.textContent = trunc(text, 3000);
    if (isErr) resultEl.style.color = 'var(--error)';
  }
}

// ============================================================
//  Slash Commands
// ============================================================
const COMMANDS = [
  { name: '/model', desc: 'Switch model', icon: '\u2699' },
  { name: '/cost', desc: 'Show token costs', icon: '$' },
  { name: '/compact', desc: 'Compact context', icon: '\u229E' },
  { name: '/clear', desc: 'Clear conversation', icon: '\u2715' },
  { name: '/help', desc: 'Show help', icon: '?' },
];

const MODELS = [
  { num: '1', id: 'default', label: 'Default (Sonnet 4.6)', desc: 'Recommended' },
  { num: '2', id: 'sonnet-1m', label: 'Sonnet (1M context)', desc: 'Long sessions' },
  { num: '3', id: 'opus', label: 'Opus', desc: 'Most capable' },
  { num: '4', id: 'opus-1m', label: 'Opus (1M context)', desc: 'Long sessions' },
  { num: '5', id: 'haiku', label: 'Haiku', desc: 'Fast answers' },
];

let cmdMenuOpen = false;
let cmdActiveIdx = -1;

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

function execCmd(cmd) {
  hideCmdMenu();
  $input.value = '';
  $input.style.height = 'auto';
  updateSendBtn();

  if (cmd === '/model') {
    showModelPicker();
    return;
  }

  const fb = CMD_FEEDBACK[cmd];
  if (fb) {
    if (fb.overlay) showCmdOverlay(fb.label);
    else if (fb.toast) showToast(fb.toast);
  }
  sendSlashCmd(cmd);
}

function sendSlashCmd(text) {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  S.ws.send(JSON.stringify({ type: 'input', data: '\x1b' }));
  setTimeout(() => {
    if (S.ws?.readyState === WebSocket.OPEN)
      S.ws.send(JSON.stringify({ type: 'chat', text }));
  }, 100);
}

// ============================================================
//  Command Overlay (blocking spinner for /compact etc.)
// ============================================================
function showCmdOverlay(label) {
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

function hideCmdOverlay() {
  const ov = $('cmd-overlay');
  if (ov) ov.classList.remove('visible');
}

function showModelPicker() {
  const list = $('model-list');
  list.innerHTML = MODELS.map(m =>
    `<div class="model-item" data-num="${m.num}">
      <span class="mi-num">${m.num}</span>
      <div class="mi-info">
        <span class="mi-name">${m.label}</span>
        <span class="mi-desc">${m.desc}</span>
      </div>
    </div>`
  ).join('');

  list.querySelectorAll('.model-item').forEach(el => {
    el.addEventListener('click', () => {
      const picked = MODELS.find(m => m.num === el.dataset.num);
      hideModelPicker();
      if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
      showToast('Switching to ' + (picked ? picked.label : 'model') + '...');
      S.ws.send(JSON.stringify({ type: 'input', data: '\x1b' }));
      setTimeout(() => {
        if (S.ws?.readyState === WebSocket.OPEN)
          S.ws.send(JSON.stringify({ type: 'chat', text: '/model' }));
      }, 300);
      setTimeout(() => {
        if (S.ws?.readyState === WebSocket.OPEN)
          S.ws.send(JSON.stringify({ type: 'chat', text: el.dataset.num }));
      }, 2000);
    });
  });

  $('model-picker').classList.add('visible');
}

function hideModelPicker() {
  $('model-picker').classList.remove('visible');
}
$('model-picker').addEventListener('click', e => {
  if (e.target === $('model-picker')) hideModelPicker();
});

// ============================================================
//  Input
// ============================================================
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
$('btn-scroll').addEventListener('click', () => { $chat.scrollTop = $chat.scrollHeight; });

// ============================================================
//  Image Upload
// ============================================================
const MAX_IMAGE_SIZE = 4 * 1024 * 1024; // 4MB limit for base64

$('btn-image').addEventListener('click', () => {
  if (S.waiting) return;
  $('image-file-input').click();
});

$('image-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = ''; // reset so same file can be re-selected

  if (!file.type.startsWith('image/')) {
    showToast('Please select an image file');
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    // dataUrl = "data:image/png;base64,xxxx..."
    const base64 = dataUrl.split(',')[1];
    if (base64.length > MAX_IMAGE_SIZE) {
      showToast('Image too large (max 4MB)');
      return;
    }
    const mediaType = dataUrl.split(';')[0].split(':')[1]; // e.g. "image/png"
    pendingImage = { base64, mediaType, name: file.name };

    // Show preview
    $('image-preview-img').src = dataUrl;
    $('image-preview').classList.remove('hidden');
    updateSendBtn();
  };
  reader.readAsDataURL(file);
});

$('image-preview-remove').addEventListener('click', () => {
  pendingImage = null;
  $('image-preview').classList.add('hidden');
  $('image-preview-img').src = '';
  updateSendBtn();
});

updateSendBtn();

// Back button — disconnect and return to connect screen
$('btn-back').addEventListener('click', () => {
  S.intentionalDisconnect = true;
  if (S.ws) S.ws.close();
  if (S.reconnectTimer) { clearTimeout(S.reconnectTimer); S.reconnectTimer = null; }
  resetAppState();
  showConnectScreen();
});

function resetAppState() {
  S.ws = null;
  S.seenUuids.clear();
  S.messageMap.clear();
  S.toolMap.clear();
  S.currentGroup = null;
  S.currentGroupCount = 0;
  S.isAtBottom = true;
  S.waiting = false;
  S.thinkingEl = null;
  S.cwd = '';
  S.model = '';
  S.mode = 'default';
  S.pendingPerms = [];
  S.waitStartedAt = 0;
  S.replaying = true;
  S.intentionalDisconnect = false;
  // Clear pending image
  pendingImage = null;
  $('image-preview').classList.add('hidden');
  $('image-preview-img').src = '';
  resetTodoState();
  // Reset UI — use id="welcome" so getWelcome() can find it
  $msgs.innerHTML = `<div class="welcome" id="welcome">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/></svg>
    <h2>Claude Remote Control</h2>
    <p>Connected. Send a message below to start.</p>
  </div>`;
  $('input-area').classList.remove('waiting');
  $input.disabled = false;
  $('btn-send').disabled = false;
  $input.placeholder = INPUT_PLACEHOLDER_DEFAULT;
  $input.value = '';
  updateSendBtn();
  updateHeaderInfo();
  setConnBanner(false);
  $('perm-overlay').classList.remove('visible');
}

function send() {
  const t = $input.value.trim();
  const hasImage = !!pendingImage;
  if ((!t && !hasImage) || !S.ws || S.ws.readyState !== WebSocket.OPEN || S.waiting) return;

  // Intercept slash commands typed directly (only when no image)
  if (!hasImage && /^\/[a-z]+$/i.test(t)) {
    execCmd(t);
    return;
  }

  removeWelcome(); closeGroup();

  // Show user message bubble (with image thumbnail if present)
  const el = document.createElement('div');
  el.className = 'user-msg'; el.dataset.optimistic = '1';
  let html = '';
  if (hasImage) {
    html += `<img src="data:${pendingImage.mediaType};base64,${pendingImage.base64}" style="max-width:200px;max-height:120px;border-radius:8px;display:block;margin-bottom:${t ? '6px' : '0'}">`;
  }
  if (t) html += esc(t).replace(/\n/g, '<br>');
  el.innerHTML = html;
  $msgs.appendChild(el);
  S.isAtBottom = true; scrollEnd();

  // Send image first, then text
  if (hasImage) {
    S.ws.send(JSON.stringify({
      type: 'image_upload',
      base64: pendingImage.base64,
      mediaType: pendingImage.mediaType,
      name: pendingImage.name,
      text: t || '',
    }));
    pendingImage = null;
    $('image-preview').classList.add('hidden');
    $('image-preview-img').src = '';
  } else {
    S.ws.send(JSON.stringify({ type: 'chat', text: t }));
  }

  $input.value = ''; $input.style.height = 'auto';
  setWaiting(true);
}

// ============================================================
//  WebSocket
// ============================================================
function connect() {
  const wsUrl = `ws://${serverAddr}`;
  let ws;
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    $('connect-error').textContent = 'Invalid address';
    $('btn-connect').classList.remove('connecting');
    $('btn-connect').querySelector('span').textContent = 'Connect';
    return;
  }
  S.ws = ws;

  const connectTimeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      ws.close();
      $('connect-error').textContent = 'Connection timed out';
      $('btn-connect').classList.remove('connecting');
      $('btn-connect').querySelector('span').textContent = 'Connect';
    }
  }, 8000);

  ws.onopen = () => {
    clearTimeout(connectTimeout);
    setStatus('connected');
    setConnBanner(false);
    showApp();
    // Sync approval mode to server
    ws.send(JSON.stringify({ type: 'set_approval_mode', mode: approvalMode }));
  };

  ws.onmessage = e => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    try {
      if (m.type === 'pty_output') { /* ignored — no terminal panel */ }
      else if (m.type === 'log_event') processEvent(m.event);
      else if (m.type === 'transcript_ready') { setStatus('connected'); }
      else if (m.type === 'replay_done') { S.replaying = false; }
      else if (m.type === 'status') {
        setStatus(m.status === 'running' ? 'connected' : 'starting');
        if (m.cwd) { S.cwd = m.cwd; updateHeaderInfo(); }
      }
      else if (m.type === 'pty_exit') { setStatus('disconnected'); if (S.waiting) setWaiting(false); }
      else if (m.type === 'permission_request') showPermission(m);
      else if (m.type === 'clear_permissions') {
        S.pendingPerms = [];
        $('perm-overlay').classList.remove('visible');
      }
      else if (m.type === 'mode') {
        S.mode = m.mode; updateHeaderInfo();
      }
    } catch (err) {
      console.error('[ws.onmessage]', err);
    }
  };

  ws.onclose = () => {
    clearTimeout(connectTimeout);
    setStatus('disconnected');
    if (S.intentionalDisconnect) return;

    if (!$('app').classList.contains('hidden')) {
      setConnBanner(true, true);
      S.reconnectTimer = setTimeout(connect, 2000);
    } else {
      $('connect-error').textContent = 'Connection failed \u2014 check the address and server';
      $('btn-connect').classList.remove('connecting');
      $('btn-connect').querySelector('span').textContent = 'Connect';
    }
  };

  ws.onerror = () => {};
}

function setStatus(s) {
  $('status-dot').className = 'status-dot ' + s;
}

function setConnBanner(show, reconnecting) {
  const el = $('conn-banner');
  el.classList.toggle('visible', show);
  el.classList.toggle('reconnecting', !!reconnecting);
  $('conn-text').textContent = reconnecting ? 'Reconnecting...' : 'Disconnected';
}

// ============================================================
//  Permission Dialog
// ============================================================
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

function showPermission(m) {
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
  if (S.pendingPerms.length === 0 || !S.ws) return;
  const p = S.pendingPerms.shift();
  S.ws.send(JSON.stringify({
    type: 'permission_response',
    id: p.id,
    decision,
  }));
  showNextPerm();
}

$('perm-allow').addEventListener('click', () => resolvePermission('allow'));
$('perm-deny').addEventListener('click', () => resolvePermission('deny'));

// ============================================================
//  AskUserQuestion — interactive question overlay
// ============================================================
let questionQueue = [];
let currentQuestions = null;
let currentQuestionIdx = 0;

function showQuestion(questions) {
  questionQueue.push(questions);
  if (questionQueue.length === 1) showNextQuestion();
}

function showNextQuestion() {
  if (questionQueue.length === 0) {
    $('question-overlay').classList.remove('visible');
    currentQuestions = null;
    return;
  }
  currentQuestions = questionQueue[0];
  currentQuestionIdx = 0;
  renderCurrentQuestion();
}

function renderCurrentQuestion() {
  if (!currentQuestions || currentQuestionIdx >= currentQuestions.length) {
    questionQueue.shift();
    showNextQuestion();
    return;
  }
  const q = currentQuestions[currentQuestionIdx];
  $('question-header-text').textContent = q.header || 'Question';
  $('question-text').textContent = q.question || '';

  const optionsEl = $('question-options');
  const options = q.options || [];
  optionsEl.innerHTML = options.map((opt, i) => `
    <button class="question-opt" data-idx="${i + 1}">
      <span class="question-opt-num">${i + 1}</span>
      <div class="question-opt-body">
        <div class="question-opt-label">${esc(opt.label)}</div>
        ${opt.description ? `<div class="question-opt-desc">${esc(opt.description)}</div>` : ''}
      </div>
    </button>
  `).join('');

  optionsEl.querySelectorAll('.question-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = btn.dataset.idx;
      sendQuestionAnswer(idx);
    });
  });

  $('question-other-input').value = '';
  $('question-overlay').classList.add('visible');
}

function sendQuestionAnswer(numKey) {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  S.ws.send(JSON.stringify({ type: 'input', data: String(numKey) }));
  $('question-overlay').classList.remove('visible');
  currentQuestionIdx++;
  if (currentQuestions && currentQuestionIdx < currentQuestions.length) {
    setTimeout(renderCurrentQuestion, 500);
  } else {
    questionQueue.shift();
    if (questionQueue.length > 0) setTimeout(showNextQuestion, 500);
    else currentQuestions = null;
  }
}

function sendQuestionOther() {
  const text = $('question-other-input').value.trim();
  if (!text || !S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  const options = currentQuestions?.[currentQuestionIdx]?.options || [];
  const otherNum = String(options.length + 1);
  S.ws.send(JSON.stringify({ type: 'input', data: otherNum }));
  setTimeout(() => {
    if (S.ws?.readyState === WebSocket.OPEN) {
      S.ws.send(JSON.stringify({ type: 'chat', text }));
    }
  }, 500);
  $('question-overlay').classList.remove('visible');
  currentQuestionIdx++;
  if (currentQuestions && currentQuestionIdx < currentQuestions.length) {
    setTimeout(renderCurrentQuestion, 1000);
  } else {
    questionQueue.shift();
    if (questionQueue.length > 0) setTimeout(showNextQuestion, 1000);
    else currentQuestions = null;
  }
}

$('question-other-btn').addEventListener('click', sendQuestionOther);
$('question-other-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); sendQuestionOther(); }
});

// ============================================================
//  ExitPlanMode — plan approval overlay (4 fixed options)
// ============================================================
const PLAN_OPTIONS = [
  { num: '1', label: 'Yes, clear context and auto-accept edits', desc: 'Clear context + shift+tab' },
  { num: '2', label: 'Yes, auto-accept edits', desc: 'Auto-accept edits mode' },
  { num: '3', label: 'Yes, manually approve edits', desc: 'Review each edit' },
];

function showPlanApproval(input) {
  const plan = input?.plan || '';
  const contentEl = $('plan-content');
  if (plan) {
    contentEl.style.display = '';
    contentEl.innerHTML = renderMd(plan);
  } else {
    contentEl.style.display = 'none';
  }

  const optionsEl = $('plan-options');
  optionsEl.innerHTML = PLAN_OPTIONS.map(opt => `
    <button class="question-opt" data-num="${opt.num}">
      <span class="question-opt-num">${opt.num}</span>
      <div class="question-opt-body">
        <div class="question-opt-label">${esc(opt.label)}</div>
        <div class="question-opt-desc">${esc(opt.desc)}</div>
      </div>
    </button>
  `).join('');

  optionsEl.querySelectorAll('.question-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!S.ws || S.ws.readyState !== WebSocket.OPEN) return;
      S.ws.send(JSON.stringify({ type: 'input', data: btn.dataset.num }));
      $('plan-overlay').classList.remove('visible');
    });
  });

  $('plan-other-input').value = '';
  $('plan-overlay').classList.add('visible');
}

function sendPlanOther() {
  const text = $('plan-other-input').value.trim();
  if (!text || !S.ws || S.ws.readyState !== WebSocket.OPEN) return;
  S.ws.send(JSON.stringify({ type: 'input', data: '4' }));
  setTimeout(() => {
    if (S.ws?.readyState === WebSocket.OPEN) {
      S.ws.send(JSON.stringify({ type: 'chat', text }));
    }
  }, 500);
  $('plan-overlay').classList.remove('visible');
}

$('plan-other-btn').addEventListener('click', sendPlanOther);
$('plan-other-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); sendPlanOther(); }
});

// ============================================================
//  Todo Panel — state management + rendering
// ============================================================
const todoState = {
  tasks: new Map(),       // taskId -> { subject, description, status, activeForm, blockedBy, blocks }
  pendingCreates: new Map(), // tool_use_id -> input (waiting for tool_result to get taskId)
  panelOpen: false,
};

function handleTodoToolUse(b) {
  const { name, id, input } = b;
  if (name === 'TaskCreate') {
    // Claude's task panel starts a fresh batch after all tasks are done.
    const hasOpenTasks = Array.from(todoState.tasks.values()).some(t => t.status !== 'completed');
    if (todoState.tasks.size > 0 && !hasOpenTasks) {
      todoState.tasks.clear();
      renderTodoPanel();
    }
    todoState.pendingCreates.set(id, input);
  } else if (name === 'TaskUpdate' && input.taskId) {
    const task = todoState.tasks.get(input.taskId);
    if (task) {
      if (input.status) task.status = input.status;
      if (input.subject) task.subject = input.subject;
      if (input.description) task.description = input.description;
      if (input.activeForm) task.activeForm = input.activeForm;
      renderTodoPanel();
    }
  }
}

function handleTodoToolResult(b, evt) {
  const { tool_use_id, content } = b;
  const text = typeof content === 'string' ? content :
    Array.isArray(content) ? content.map(c => c.text || '').join('') : '';
  const toolUseResult = (evt && typeof evt.toolUseResult === 'object' && evt.toolUseResult) ? evt.toolUseResult : null;

  // TaskCreate result: "Task #1 created successfully: subject"
  const createInput = todoState.pendingCreates.get(tool_use_id);
  if (createInput) {
    todoState.pendingCreates.delete(tool_use_id);
    const metaTaskId = toolUseResult?.task?.id;
    const m = text.match(/Task #(\d+) created/i);
    const taskId = metaTaskId ? String(metaTaskId) : (m ? m[1] : '');
    if (taskId) {
      const metaSubject = toolUseResult?.task?.subject;
      todoState.tasks.set(taskId, {
        subject: metaSubject || createInput.subject || '',
        description: createInput.description || '',
        status: 'pending',
        activeForm: createInput.activeForm || '',
        blockedBy: [],
        blocks: [],
      });
      renderTodoPanel();
    }
    return;
  }

  if (toolUseResult?.taskId) {
    const taskId = String(toolUseResult.taskId);
    let task = todoState.tasks.get(taskId);
    if (!task) {
      task = {
        subject: `Task #${taskId}`,
        description: '',
        status: 'pending',
        activeForm: '',
        blockedBy: [],
        blocks: [],
      };
      todoState.tasks.set(taskId, task);
    }
    if (toolUseResult.statusChange?.to) {
      task.status = toolUseResult.statusChange.to;
    }
    renderTodoPanel();
    return;
  }

  // TaskList result: parse task listing
  if (text.includes('Task #') && (text.includes('[pending]') || text.includes('[in_progress]') || text.includes('[completed]'))) {
    const lines = text.split('\n');
    for (const line of lines) {
      const tm = line.match(/#(\d+)\.\s*\[(\w+)]\s*(.*)/);
      if (tm) {
        const [, taskId, status, subject] = tm;
        const existing = todoState.tasks.get(taskId);
        if (existing) {
          existing.status = status;
          if (subject.trim()) existing.subject = subject.trim();
        } else {
          todoState.tasks.set(taskId, {
            subject: subject.trim(),
            description: '',
            status,
            activeForm: '',
            blockedBy: [],
            blocks: [],
          });
        }
      }
    }
    renderTodoPanel();
    return;
  }

  // TaskUpdate result: "Updated task #1 status"
  const um = text.match(/Updated task #(\d+)/i);
  if (um) {
    renderTodoPanel();
  }
}

function isTodoTool(name) {
  return name === 'TaskCreate' || name === 'TaskUpdate' || name === 'TaskList' || name === 'TaskGet';
}

function renderTodoPanel() {
  const panel = $('todo-panel');
  const list = $('todo-list');
  const tasks = Array.from(todoState.tasks.entries()).sort(([aId], [bId]) => {
    const aNum = Number.parseInt(aId, 10);
    const bNum = Number.parseInt(bId, 10);
    const aOk = Number.isFinite(aNum);
    const bOk = Number.isFinite(bNum);
    if (aOk && bOk) return aNum - bNum;
    if (aOk) return -1;
    if (bOk) return 1;
    return String(aId).localeCompare(String(bId), undefined, { numeric: true });
  });

  if (tasks.length === 0) {
    panel.classList.remove('has-tasks');
    return;
  }

  panel.classList.add('has-tasks');

  const total = tasks.length;
  const completed = tasks.filter(([, t]) => t.status === 'completed').length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Update badge
  const badge = $('todo-badge');
  const remaining = total - completed;
  badge.textContent = remaining > 0 ? remaining : '\u2713';
  badge.classList.toggle('done', remaining === 0);

  // Update progress bar
  const bar = $('todo-progress-bar');
  bar.style.width = pct + '%';
  bar.classList.toggle('all-done', pct === 100);

  // Update summary
  $('todo-summary').textContent = `${completed}/${total}`;

  // Render task list
  const STATUS_ICON = {
    pending: '\u25CB',
    in_progress: '\u25D4',
    completed: '\u2713',
  };
  const STATUS_LABEL = {
    pending: 'Pending',
    in_progress: 'Running',
    completed: 'Done',
  };

  list.innerHTML = tasks.map(([id, t]) => {
    const status = t.status || 'pending';
    const showActive = status === 'in_progress' && t.activeForm;
    return `<div class="todo-item ${status}">
      <div class="todo-icon">${STATUS_ICON[status] || '\u25CB'}</div>
      <div class="todo-body">
        <div class="todo-subject">${esc(t.subject || 'Task #' + id)}</div>
        ${showActive ? `<div class="todo-active-form">${esc(t.activeForm)}</div>` : ''}
      </div>
      <span class="todo-status-tag">${STATUS_LABEL[status] || status}</span>
    </div>`;
  }).join('');

  // Auto-open on first task
  if (!todoState.panelOpen && tasks.length > 0) {
    todoState.panelOpen = true;
    panel.classList.add('open');
  }

  scrollEnd();
}

function toggleTodoPanel() {
  const panel = $('todo-panel');
  todoState.panelOpen = !todoState.panelOpen;
  panel.classList.toggle('open', todoState.panelOpen);
}

function resetTodoState() {
  todoState.tasks.clear();
  todoState.pendingCreates.clear();
  todoState.panelOpen = false;
  $('todo-panel').classList.remove('has-tasks', 'open');
  $('todo-list').innerHTML = '';
}

// ============================================================
//  Settings — approval mode
// ============================================================
let approvalMode = localStorage.getItem('approvalMode') || 'default';
let confirmResolve = null;

function initSettings() {
  const radio = document.querySelector(`input[name="approval-mode"][value="${approvalMode}"]`);
  if (radio) radio.checked = true;
  updateSettingsActive();
}

function updateSettingsActive() {
  document.querySelectorAll('.settings-opt').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === approvalMode);
  });
}

function openSettings() {
  initSettings();
  $('settings-overlay').classList.add('visible');
}

function closeSettings() {
  $('settings-overlay').classList.remove('visible');
}

function setApprovalMode(mode) {
  approvalMode = mode;
  localStorage.setItem('approvalMode', mode);
  updateSettingsActive();
  if (S.ws && S.ws.readyState === WebSocket.OPEN) {
    S.ws.send(JSON.stringify({ type: 'set_approval_mode', mode }));
  }
}

function showConfirm(text) {
  return new Promise(resolve => {
    $('confirm-text').textContent = text;
    $('confirm-overlay').classList.add('visible');
    confirmResolve = resolve;
  });
}

$('btn-settings').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', closeSettings);
$('settings-overlay').addEventListener('click', e => {
  if (e.target === $('settings-overlay')) closeSettings();
});

document.querySelectorAll('input[name="approval-mode"]').forEach(radio => {
  radio.addEventListener('change', async (e) => {
    const mode = e.target.value;
    if (mode === 'all') {
      const ok = await showConfirm(
        '全部自动审批将允许所有命令（包括 Bash、系统命令）无需确认直接执行，这可能存在风险。确定要开启吗？'
      );
      if (!ok) {
        const prev = document.querySelector(`input[name="approval-mode"][value="${approvalMode}"]`);
        if (prev) prev.checked = true;
        return;
      }
    } else if (mode === 'partial') {
      const ok = await showConfirm(
        '部分自动审批将自动放行 Read、Write、Edit、Glob、Grep 命令，无需手动确认。确定要开启吗？'
      );
      if (!ok) {
        const prev = document.querySelector(`input[name="approval-mode"][value="${approvalMode}"]`);
        if (prev) prev.checked = true;
        return;
      }
    }
    setApprovalMode(mode);
  });
});

$('confirm-ok').addEventListener('click', () => {
  $('confirm-overlay').classList.remove('visible');
  if (confirmResolve) { confirmResolve(true); confirmResolve = null; }
});
$('confirm-cancel').addEventListener('click', () => {
  $('confirm-overlay').classList.remove('visible');
  if (confirmResolve) { confirmResolve(false); confirmResolve = null; }
});

// ============================================================
//  Keyboard handling for Android virtual keyboard
// ============================================================
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', () => {
    if (S.isAtBottom) {
      requestAnimationFrame(() => { $chat.scrollTop = $chat.scrollHeight; });
    }
  });
}

// ============================================================
//  External links — open in system browser, not in WebView
// ============================================================
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href]');
  if (!a) return;
  const href = a.getAttribute('href');
  if (!href) return;
  // Only intercept external http/https links
  if (/^https?:\/\//i.test(href)) {
    e.preventDefault();
    e.stopPropagation();
    window.open(href, '_blank');
  }
});
