'use strict';

const fs = require('fs');
const path = require('path');
const { state, PROJECTS_DIR, EVENT_BUFFER_MAX } = require('./state');
const { log, broadcast, setTurnState, latestEventSeq } = require('./logger');

// ============================================================
//  Path Utilities
// ============================================================
function normalizeFsPath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function getProjectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function projectTranscriptDir() {
  return path.join(PROJECTS_DIR, getProjectSlug(state.CWD));
}

// ============================================================
//  Content Parsing
// ============================================================
function hasConversationEvent(evt) {
  if (!evt || typeof evt !== 'object') return false;
  if (evt.type === 'user' || evt.type === 'assistant') return true;
  const role = evt.message && typeof evt.message === 'object' ? evt.message.role : null;
  return role === 'user' || role === 'assistant';
}

function fileLooksLikeTranscript(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= 0) return false;
    const readSize = Math.min(stat.size, 64 * 1024);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readSize);
    fs.readSync(fd, buf, 0, readSize, stat.size - readSize);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (hasConversationEvent(evt)) return true;
      } catch {}
    }
  } catch {}
  return false;
}

function flattenUserContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (!block || typeof block !== 'object') return '';
    if (typeof block.text === 'string') return block.text;
    if (typeof block.content === 'string') return block.content;
    return '';
  }).filter(Boolean).join('\n');
}

function extractSlashCommand(content) {
  const text = flattenUserContent(content).trim();
  if (!text) return '';
  const commandTagMatch = text.match(/<command-name>\s*(\/[^\s<]+)\s*<\/command-name>/i);
  if (commandTagMatch) return commandTagMatch[1].trim().toLowerCase();
  const inlineMatch = text.match(/^(\/\S+)/);
  return inlineMatch ? inlineMatch[1].trim().toLowerCase() : '';
}

function isUserInterruptEvent(content) {
  const text = flattenUserContent(content)
    .replace(/\x1B\[[0-9;]*m/g, '')
    .trim();
  if (!text) return false;
  return /(?:^|\n)\[Request interrupted by user(?: for tool use)?\](?:\r?\n|$)/i.test(text);
}

function isNonAiUserEvent(event, content) {
  if (!event || typeof event !== 'object') return false;
  if (event.isMeta === true) return true;
  if (event.isCompactSummary === true) return true;
  if (event.isVisibleInTranscriptOnly === true) return true;
  if (isUserInterruptEvent(content)) return true;
  const text = flattenUserContent(content).trim();
  if (!text) return false;
  return /<local-command-(?:stdout|stderr|caveat)>/i.test(text);
}

function extractSessionPrompt(event) {
  if (!event || event.type !== 'user') return '';
  const message = event.message;
  const content = typeof message === 'string'
    ? message
    : (message && typeof message === 'object' ? message.content : '');
  const text = flattenUserContent(content).trim();
  if (!text) return '';
  if (isNonAiUserEvent(event, content)) return '';
  if (extractSlashCommand(content)) return '';
  return text.replace(/\s+/g, ' ').trim().substring(0, 120);
}

function enrichEditStartLines(event) {
  const content = event.message && event.message.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type !== 'tool_use' || block.name !== 'Edit') continue;
    const input = block.input;
    if (!input || !input.file_path || input.old_string === undefined) continue;
    try {
      const filePath = path.resolve(state.CWD, input.file_path);
      const src = fs.readFileSync(filePath, 'utf8');
      const needle = input.new_string || input.old_string;
      const idx = src.indexOf(needle);
      if (idx >= 0) {
        input._startLine = src.substring(0, idx).split('\n').length;
      }
    } catch {}
  }
}

// ============================================================
//  Hook Session Resolution
// ============================================================
function resolveHookTranscript(data) {
  if (!data || typeof data !== 'object') return null;
  const hookCwd = data.cwd ? path.resolve(String(data.cwd)) : '';
  if (hookCwd && normalizeFsPath(hookCwd) !== normalizeFsPath(state.CWD)) return null;
  const sessionId = data.session_id ? String(data.session_id) : '';
  const expectedDir = projectTranscriptDir();
  const transcriptPath = data.transcript_path ? path.resolve(String(data.transcript_path)) : '';
  if (transcriptPath) {
    const transcriptDir = path.dirname(transcriptPath);
    const transcriptSessionId = path.basename(transcriptPath, '.jsonl');
    const dirMatches = normalizeFsPath(transcriptDir) === normalizeFsPath(expectedDir);
    const idMatches = !sessionId || transcriptSessionId === sessionId;
    if (dirMatches && idMatches) {
      return { full: transcriptPath, sessionId: transcriptSessionId };
    }
  }
  if (!sessionId) return null;
  return { full: path.join(expectedDir, `${sessionId}.jsonl`), sessionId };
}

function maybeAttachHookSession(data, source) {
  const target = resolveHookTranscript(data);
  if (!target) return;
  let hookSource = null;

  if (state.currentSessionId === target.sessionId && state.transcriptPath &&
      normalizeFsPath(state.transcriptPath) === normalizeFsPath(target.full)) {
    return;
  }

  const targetHasContent = fileLooksLikeTranscript(target.full);

  if (source === 'session-start') {
    hookSource = data.source;
    if (hookSource === 'clear' || hookSource === 'resume') {
      log(`Deterministic session-start (hookSource=${hookSource}): ${target.sessionId}`);
    } else {
      if (state.currentSessionId && !state.expectingSwitch) {
        const currentHasContent = state.transcriptPath && fileLooksLikeTranscript(state.transcriptPath);
        if (!targetHasContent || currentHasContent) {
          if (state.currentSessionId !== target.sessionId) {
            state.pendingSwitchTarget = { ...target, seenAt: Date.now(), source };
            log(`Queued pending session-start: ${target.sessionId} (current=${state.currentSessionId} currentHasContent=${currentHasContent} targetHasContent=${targetHasContent})`);
          }
          log(`Ignored session-start: ${target.sessionId} (current=${state.currentSessionId} currentHasContent=${currentHasContent} targetHasContent=${targetHasContent})`);
          return;
        }
      }
    }
  } else if (source === 'pre-tool-use') {
    if (state.currentSessionId && state.currentSessionId !== target.sessionId && !targetHasContent) {
      log(`Ignored pre-tool-use: ${target.sessionId} (no conversation content)`);
      return;
    }
  } else {
    if (state.currentSessionId && state.currentSessionId !== target.sessionId && !state.expectingSwitch) {
      log(`Ignored hook session from ${source}: ${target.sessionId} (current=${state.currentSessionId})`);
      return;
    }
  }

  log(`Hook session attached from ${source}: ${target.sessionId}`);
  attachTranscript({
    full: target.full,
    ignoreInitialClearCommand: source === 'session-start' && hookSource === 'clear',
  }, 0);
}

function maybeAttachPendingSwitchTarget(reason, requireReady = true) {
  if (!state.pendingSwitchTarget) return false;
  if ((Date.now() - state.pendingSwitchTarget.seenAt) > 15000) {
    log(`Dropped stale pending switch target: ${state.pendingSwitchTarget.sessionId}`);
    state.pendingSwitchTarget = null;
    return false;
  }
  if (state.pendingSwitchTarget.sessionId === state.currentSessionId) {
    state.pendingSwitchTarget = null;
    return false;
  }
  if (requireReady && !fileLooksLikeTranscript(state.pendingSwitchTarget.full)) {
    return false;
  }
  const target = state.pendingSwitchTarget;
  state.pendingSwitchTarget = null;
  log(`Attaching pending switch target from ${reason}: ${target.sessionId}`);
  if (state.tailTimer) { clearInterval(state.tailTimer); state.tailTimer = null; }
  if (state.switchWatcher) { clearInterval(state.switchWatcher); state.switchWatcher = null; }
  attachTranscript({ full: target.full }, 0);
  return true;
}

// ============================================================
//  Transcript Attachment & Tailing
// ============================================================
function attachTranscript(target, startOffset = 0) {
  state.transcriptPath = target.full;
  state.currentSessionId = path.basename(state.transcriptPath, '.jsonl');
  setTurnState('idle', { sessionId: state.currentSessionId, reason: 'transcript_attached' });
  state.pendingInitialClearTranscript = target.ignoreInitialClearCommand
    ? { sessionId: state.currentSessionId }
    : null;
  if (state.pendingSwitchTarget && state.pendingSwitchTarget.sessionId === state.currentSessionId) {
    state.pendingSwitchTarget = null;
  }
  state.transcriptOffset = Math.max(0, startOffset);
  state.tailRemainder = Buffer.alloc(0);
  state.eventBuffer = [];
  state.eventSeq = 0;

  if (state.expectingSwitch) {
    state.expectingSwitch = false;
    if (state.expectingSwitchTimer) { clearTimeout(state.expectingSwitchTimer); state.expectingSwitchTimer = null; }
  }
  if (state.switchWatcherDelayTimer) { clearTimeout(state.switchWatcherDelayTimer); state.switchWatcherDelayTimer = null; }

  try {
    const stat = fs.statSync(state.transcriptPath);
    state.tailCatchingUp = stat.size > state.transcriptOffset;
  } catch {
    state.tailCatchingUp = false;
  }

  log(`Transcript attached: ${state.currentSessionId} (offset=${state.transcriptOffset} catchUp=${state.tailCatchingUp})`);
  broadcast({
    type: 'transcript_ready',
    transcript: state.transcriptPath,
    sessionId: state.currentSessionId,
    lastSeq: 0,
  });
  startTailing();
}

function markExpectingSwitch() {
  state.expectingSwitch = true;
  if (state.expectingSwitchTimer) clearTimeout(state.expectingSwitchTimer);
  state.expectingSwitchTimer = setTimeout(() => {
    state.expectingSwitch = false;
    state.expectingSwitchTimer = null;
    log('Expecting-switch flag expired (no new transcript found)');
  }, 15000);
  log('Expecting session switch (/clear detected)');
  if (maybeAttachPendingSwitchTarget('markExpectingSwitch')) return;

  if (state.switchWatcher) { clearInterval(state.switchWatcher); state.switchWatcher = null; }
  if (state.switchWatcherDelayTimer) { clearTimeout(state.switchWatcherDelayTimer); state.switchWatcherDelayTimer = null; }
  state.switchWatcherDelayTimer = setTimeout(() => {
    state.switchWatcherDelayTimer = null;
    if (state.expectingSwitch && !state.switchWatcher) {
      log('Hook did not bind within 5s, starting switchWatcher fallback');
      startSwitchWatcher();
    }
  }, 5000);
}

function startSwitchWatcher() {
  if (state.switchWatcher) { clearInterval(state.switchWatcher); state.switchWatcher = null; }
  const slug = getProjectSlug(state.CWD);
  const projectDir = path.join(PROJECTS_DIR, slug);

  state.switchWatcher = setInterval(() => {
    if (!state.transcriptPath || !state.expectingSwitch || !fs.existsSync(projectDir)) return;
    try {
      const currentBasename = path.basename(state.transcriptPath);
      const candidates = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl') && f !== currentBasename)
        .map(f => {
          const full = path.join(projectDir, f);
          const stat = fs.statSync(full);
          return { name: f, full, mtime: stat.mtimeMs, size: stat.size };
        })
        .filter(t => t.mtime > fs.statSync(state.transcriptPath).mtimeMs)
        .sort((a, b) => b.mtime - a.mtime);

      const newer = candidates.find(t => fileLooksLikeTranscript(t.full));
      if (newer) {
        log(`Session switch detected → ${path.basename(newer.full, '.jsonl')}`);
        state.expectingSwitch = false;
        if (state.expectingSwitchTimer) { clearTimeout(state.expectingSwitchTimer); state.expectingSwitchTimer = null; }
        if (state.tailTimer) { clearInterval(state.tailTimer); state.tailTimer = null; }
        if (state.switchWatcher) { clearInterval(state.switchWatcher); state.switchWatcher = null; }
        attachTranscript(newer, 0);
      }
    } catch {}
  }, 500);
}

function startTailing() {
  state.tailRemainder = Buffer.alloc(0);
  state.tailTimer = setInterval(() => {
    if (maybeAttachPendingSwitchTarget('tail_pending_target')) return;
    if (!state.transcriptPath) return;
    try {
      const stat = fs.statSync(state.transcriptPath);
      if (stat.size <= state.transcriptOffset) {
        if (state.tailCatchingUp) {
          state.tailCatchingUp = false;
          log('Tail catch-up complete, live mode');
        }
        return;
      }

      const fd = fs.openSync(state.transcriptPath, 'r');
      const buf = Buffer.alloc(stat.size - state.transcriptOffset);
      fs.readSync(fd, buf, 0, buf.length, state.transcriptOffset);
      fs.closeSync(fd);
      state.transcriptOffset = stat.size;

      const data = state.tailRemainder.length > 0 ? Buffer.concat([state.tailRemainder, buf]) : buf;
      let start = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 0x0A) continue;
        const line = data.slice(start, i).toString('utf8').trim();
        start = i + 1;
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'user' || (event.message && event.message.role === 'user')) {
            const content = event.message && event.message.content;
            const slashCommand = extractSlashCommand(content);
            const isInterruptedUserEvent = isUserInterruptEvent(content);
            const isPassiveUserEvent = isNonAiUserEvent(event, content);
            const ignoreInitialClear = (
              slashCommand === '/clear' &&
              state.pendingInitialClearTranscript &&
              state.pendingInitialClearTranscript.sessionId === state.currentSessionId
            );
            if (!state.tailCatchingUp && isInterruptedUserEvent) {
              setTurnState('idle', { sessionId: state.currentSessionId, reason: 'transcript_user_interrupt' });
            }
            if (!state.tailCatchingUp && !slashCommand && !isPassiveUserEvent) {
              setTurnState('running', { sessionId: state.currentSessionId, reason: 'transcript_user_event' });
            }
            if (slashCommand === '/clear') {
              if (ignoreInitialClear) {
                state.pendingInitialClearTranscript = null;
                log(`Ignored bootstrap /clear transcript event for session ${state.currentSessionId}`);
              } else {
                markExpectingSwitch();
              }
            } else if (
              state.pendingInitialClearTranscript &&
              state.pendingInitialClearTranscript.sessionId === state.currentSessionId &&
              !isPassiveUserEvent &&
              !event.isMeta &&
              !event.isCompactSummary &&
              !event.isVisibleInTranscriptOnly
            ) {
              state.pendingInitialClearTranscript = null;
            }
          } else if (state.pendingInitialClearTranscript && state.pendingInitialClearTranscript.sessionId === state.currentSessionId &&
                     event.type === 'assistant') {
            state.pendingInitialClearTranscript = null;
          }
          enrichEditStartLines(event);
          const record = { seq: ++state.eventSeq, event };
          state.eventBuffer.push(record);
          if (state.eventBuffer.length > EVENT_BUFFER_MAX) {
            state.eventBuffer = state.eventBuffer.slice(-Math.round(EVENT_BUFFER_MAX * 0.8));
          }
          broadcast({ type: 'log_event', seq: record.seq, event });
        } catch {}
      }
      state.tailRemainder = data.slice(start);
    } catch {}
  }, 300);
}

function stopTailing() {
  if (state.tailTimer) { clearInterval(state.tailTimer); state.tailTimer = null; }
  if (state.switchWatcher) { clearInterval(state.switchWatcher); state.switchWatcher = null; }
  if (state.switchWatcherDelayTimer) { clearTimeout(state.switchWatcherDelayTimer); state.switchWatcherDelayTimer = null; }
  if (state.expectingSwitchTimer) { clearTimeout(state.expectingSwitchTimer); state.expectingSwitchTimer = null; }
  state.expectingSwitch = false;
  state.pendingSwitchTarget = null;
  state.pendingInitialClearTranscript = null;
  state.tailRemainder = Buffer.alloc(0);
}

// ============================================================
//  Session Scanner
// ============================================================
function scanSessions(cwd, limit = 20) {
  const dir = path.join(PROJECTS_DIR, getProjectSlug(cwd));
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const entries = [];
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const stat = fs.statSync(full);
      entries.push({ file: f, full, mtime: stat.mtimeMs, size: stat.size });
    } catch {}
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  const top = entries.slice(0, limit);

  const sessions = [];
  for (const entry of top) {
    const sessionId = path.basename(entry.file, '.jsonl');
    const info = {
      sessionId,
      summary: '',
      firstPrompt: '',
      lastModified: Math.round(entry.mtime),
      fileSize: entry.size,
      cwd: cwd,
    };

    try {
      const fd = fs.openSync(entry.full, 'r');
      const buf = Buffer.alloc(Math.min(entry.size, 64 * 1024));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const evt = JSON.parse(line);
          if (!info.firstPrompt) {
            info.firstPrompt = extractSessionPrompt(evt);
          }
          if (!info.model && evt.model) {
            info.model = evt.model;
          }
        } catch {}
      }
    } catch {}

    info.summary = info.firstPrompt || 'Untitled';
    sessions.push(info);
  }
  return sessions;
}

// ============================================================
//  Directory Browsing
// ============================================================
function getDirectoryRoots() {
  if (process.platform === 'win32') {
    const roots = [];
    for (let code = 65; code <= 90; code++) {
      const drive = String.fromCharCode(code) + ':\\';
      try {
        if (fs.existsSync(drive)) roots.push(drive);
      } catch {}
    }
    return roots;
  }
  return ['/'];
}

function assertDirectoryPath(target) {
  const resolved = path.resolve(String(target || ''));
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error('Directory not found');
  }
  if (!stat.isDirectory()) throw new Error('Path is not a directory');
  return resolved;
}

function listDirectories(target) {
  const cwd = assertDirectoryPath(target);
  const roots = getDirectoryRoots();
  const parentDir = path.dirname(cwd);
  const parent = normalizeFsPath(parentDir) === normalizeFsPath(cwd) ? null : parentDir;

  const entries = fs.readdirSync(cwd, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      name: entry.name,
      path: path.join(cwd, entry.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  return { cwd, parent, roots, entries };
}

module.exports = {
  normalizeFsPath,
  getProjectSlug,
  projectTranscriptDir,
  flattenUserContent,
  extractSlashCommand,
  isNonAiUserEvent,
  hasConversationEvent,
  extractSessionPrompt,
  fileLooksLikeTranscript,
  enrichEditStartLines,
  resolveHookTranscript,
  maybeAttachHookSession,
  maybeAttachPendingSwitchTarget,
  attachTranscript,
  startTailing,
  stopTailing,
  markExpectingSwitch,
  startSwitchWatcher,
  scanSessions,
  getDirectoryRoots,
  assertDirectoryPath,
  listDirectories,
};
