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
  replaying: true,           // true during history replay, false after replay_done
  reconnectTimer: null,
  intentionalDisconnect: false,
};

const $msgs = $('messages'), $chat = $('chat-area'), $input = $('input');

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
  const empty = !$input.value.trim();
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
  updateModeButton();
}

function updateModeButton() {}

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
      // ALWAYS clear thinking first, before any rendering that might throw
      if (S.waiting) setWaiting(false);
      renderAssistant(evt);
    }
    scrollEnd();
  } catch (e) {
    console.error('[processEvent]', e);
    // Safety: always clear thinking even if rendering fails
    if (S.waiting) setWaiting(false);
  }
}

// --- User ---
function renderUser(evt) {
  const c = evt.message.content;
  if (Array.isArray(c)) {
    for (const b of c) { if (b.type === 'tool_result') attachResult(b); }
    return;
  }
  if (typeof c === 'string' && c.trim()) {
    closeGroup();
    const opt = $msgs.querySelector('[data-optimistic]');
    if (opt) { opt.removeAttribute('data-optimistic'); return; }
    const el = document.createElement('div');
    el.className = 'user-msg';
    el.innerHTML = renderMd(c);
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
        if (b.name === 'AskUserQuestion' && b.input && b.input.questions) {
          if (!S.replaying) showQuestion(b.input.questions);
        } else if (b.name === 'ExitPlanMode') {
          if (!S.replaying) showPlanApproval(b.input);
        } else {
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
  detail.innerHTML = `
    <div class="detail-input">${esc(inputFull)}</div>
    <div class="detail-result" id="result-${b.id}"></div>
  `;

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
  S.replaying = true;
  S.intentionalDisconnect = false;
  // Reset UI — use id="welcome" so getWelcome() can find it
  $msgs.innerHTML = `<div class="welcome" id="welcome">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="12" cy="12" r="10"/><path d="M8 12h8M12 8v8"/></svg>
    <h2>Claude Remote Control</h2>
    <p>Connected. Send a message below to start.</p>
  </div>`;
  $('input-area').classList.remove('waiting');
  $input.value = '';
  updateSendBtn();
  updateHeaderInfo();
  setConnBanner(false);
  $('perm-overlay').classList.remove('visible');
}

function send() {
  const t = $input.value.trim();
  if (!t || !S.ws || S.ws.readyState !== WebSocket.OPEN || S.waiting) return;

  // Intercept slash commands typed directly
  if (/^\/[a-z]+$/i.test(t)) {
    execCmd(t);
    return;
  }

  removeWelcome(); closeGroup();
  const el = document.createElement('div');
  el.className = 'user-msg'; el.dataset.optimistic = '1';
  el.innerHTML = renderMd(t);
  $msgs.appendChild(el);
  S.isAtBottom = true; scrollEnd();
  S.ws.send(JSON.stringify({ type: 'chat', text: t }));
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
      // Safety: clear thinking on any error
      if (S.waiting && m.type === 'log_event') setWaiting(false);
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
        'Full auto-approve will allow ALL commands (including Bash, system commands) without confirmation. This could be dangerous. Are you sure?'
      );
      if (!ok) {
        const prev = document.querySelector(`input[name="approval-mode"][value="${approvalMode}"]`);
        if (prev) prev.checked = true;
        return;
      }
    } else if (mode === 'partial') {
      const ok = await showConfirm(
        'Partial auto-approve will automatically allow Read, Write, Edit, Glob, and Grep commands without confirmation. Continue?'
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
