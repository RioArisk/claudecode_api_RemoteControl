const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const pty = require('node-pty');
const { WebSocketServer, WebSocket } = require('ws');
const { execSync } = require('child_process');

// --- Config ---
const PORT = parseInt(process.env.PORT || '3100', 10);
const CWD = process.argv[2] || process.cwd();
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');

// --- State ---
let claudeProc = null;
let transcriptPath = null;
let currentSessionId = null;
let transcriptOffset = 0;
let eventBuffer = [];
let eventSeq = 0;
const EVENT_BUFFER_MAX = 5000;
let tailTimer = null;
let discoveryTimer = null;
let switchWatcher = null;
let expectingSwitch = false;
let expectingSwitchTimer = null;
let preExistingFiles = new Set();
let preExistingFileSizes = new Map();
let tailRemainder = Buffer.alloc(0);
const isTTY = process.stdin.isTTY && process.stdout.isTTY;
const LEGACY_REPLAY_DELAY_MS = 1500;
const IMAGE_UPLOAD_TTL_MS = 15 * 60 * 1000;

// --- Permission approval state ---
let approvalSeq = 0;
const pendingApprovals = new Map();  // id → { res, timer }
const pendingImageUploads = new Map();
let currentMode = 'default';
let approvalMode = 'default';  // 'default' | 'partial' | 'all'
const ALWAYS_AUTO_ALLOW = new Set(['TaskCreate', 'TaskUpdate']);
const PARTIAL_AUTO_ALLOW = new Set(['Read', 'Glob', 'Grep', 'Write', 'Edit']);

// --- Logging → file only (never pollute the terminal) ---
const LOG_FILE = path.join(os.homedir(), '.claude', 'bridge.log');
fs.writeFileSync(LOG_FILE, `--- Bridge started ${new Date().toISOString()} ---\n`);
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
}

// ============================================================
//  1. Static file server
// ============================================================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];

  // --- API: Hook approval endpoint ---
  if (req.method === 'POST' && url === '/hook/pre-tool-use') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      let data;
      try { data = JSON.parse(body); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ decision: 'ask' }));
        return;
      }

      // Track mode from hook payload
      if (data.permission_mode && data.permission_mode !== currentMode) {
        currentMode = data.permission_mode;
        broadcast({ type: 'mode', mode: currentMode });
      }

      if (ALWAYS_AUTO_ALLOW.has(data.tool_name)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ decision: 'allow' }));
        log(`Permission auto-allowed (always): ${data.tool_name}`);
        return;
      }

      // Auto-approve based on approvalMode setting
      if (approvalMode === 'all') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ decision: 'allow' }));
        log(`Permission auto-allowed (mode=all): ${data.tool_name}`);
        return;
      }
      if (approvalMode === 'partial' && PARTIAL_AUTO_ALLOW.has(data.tool_name)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ decision: 'allow' }));
        log(`Permission auto-allowed (mode=partial): ${data.tool_name}`);
        return;
      }

      // No WebUI clients → fall back to terminal prompt
      const clients = [...wss.clients].filter(c => c.readyState === WebSocket.OPEN);
      if (clients.length === 0) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ decision: 'ask' }));
        return;
      }

      const id = String(++approvalSeq);
      log(`Permission #${id}: ${data.tool_name} → ${clients.length} WebUI client(s)`);

      broadcast({
        type: 'permission_request',
        id,
        toolName: data.tool_name,
        toolInput: data.tool_input,
        permissionMode: data.permission_mode,
      });

      // Hold HTTP response open until WebUI user decides or timeout
      const timer = setTimeout(() => {
        pendingApprovals.delete(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ decision: 'ask' }));
        log(`Permission #${id}: timeout → ask`);
      }, 90000);

      pendingApprovals.set(id, { res, timer });
    });
    return;
  }

  // --- API: Stop hook endpoint ---
  if (req.method === 'POST' && url === '/hook/stop') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      log('/hook/stop received — broadcasting turn_complete');
      broadcast({ type: 'turn_complete' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    return;
  }

  // --- Static files ---
  const filePath = path.join(__dirname, 'web', url === '/' ? 'index.html' : url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ============================================================
//  2. WebSocket server
// ============================================================
const wss = new WebSocketServer({ server });

function broadcast(msg) {
  const raw = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(raw);
  }
}

function latestEventSeq() {
  return eventBuffer.length > 0 ? eventBuffer[eventBuffer.length - 1].seq : 0;
}

function sendReplay(ws, lastSeq = null) {
  const normalizedLastSeq = Number.isInteger(lastSeq) && lastSeq >= 0 ? lastSeq : null;
  const replayFrom = normalizedLastSeq == null ? 0 : normalizedLastSeq;
  const records = replayFrom > 0
    ? eventBuffer.filter(record => record.seq > replayFrom)
    : eventBuffer;

  for (const record of records) {
    ws.send(JSON.stringify({
      type: 'log_event',
      seq: record.seq,
      event: record.event,
    }));
  }

  ws.send(JSON.stringify({
    type: 'replay_done',
    sessionId: currentSessionId,
    lastSeq: latestEventSeq(),
    resumed: normalizedLastSeq != null,
  }));
}

function sendUploadStatus(ws, uploadId, status, extra = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    type: 'image_upload_status',
    uploadId,
    status,
    ...extra,
  }));
}

function cleanupImageUpload(uploadId) {
  const upload = pendingImageUploads.get(uploadId);
  if (!upload) return;
  if (upload.tmpFile) {
    try { fs.unlinkSync(upload.tmpFile); } catch {}
  }
  pendingImageUploads.delete(uploadId);
}

function cleanupClientUploads(ws) {
  for (const [uploadId, upload] of pendingImageUploads) {
    if (upload.owner === ws) cleanupImageUpload(uploadId);
  }
}

function createTempImageFile(buffer, mediaType, uploadId) {
  const tmpDir = process.env.CLAUDE_CODE_TMPDIR || os.tmpdir();
  const type = String(mediaType || 'image/png').toLowerCase();
  const ext = type.includes('jpeg') || type.includes('jpg') ? '.jpg' : '.png';
  const tmpFile = path.join(tmpDir, `bridge_upload_${uploadId}_${Date.now()}${ext}`);
  fs.writeFileSync(tmpFile, buffer);
  return tmpFile;
}

setInterval(() => {
  const now = Date.now();
  for (const [uploadId, upload] of pendingImageUploads) {
    if ((upload.updatedAt || 0) < (now - IMAGE_UPLOAD_TTL_MS)) {
      cleanupImageUpload(uploadId);
    }
  }
}, 60 * 1000).unref();

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'status',
    status: claudeProc ? 'running' : 'starting',
    hasTranscript: !!transcriptPath,
    cwd: CWD,
    sessionId: currentSessionId,
    lastSeq: latestEventSeq(),
  }));

  if (currentSessionId) {
    ws.send(JSON.stringify({
      type: 'transcript_ready',
      transcript: transcriptPath,
      sessionId: currentSessionId,
      lastSeq: latestEventSeq(),
    }));
  }

  // New clients should explicitly request a resume window. Keep a delayed
  // full replay fallback so older clients still work.
  ws._resumeHandled = false;
  ws._legacyReplayTimer = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN || ws._resumeHandled) return;
    ws._resumeHandled = true;
    sendReplay(ws, null);
  }, LEGACY_REPLAY_DELAY_MS);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'resume': {
        ws._resumeHandled = true;
        if (ws._legacyReplayTimer) {
          clearTimeout(ws._legacyReplayTimer);
          ws._legacyReplayTimer = null;
        }

        if (!currentSessionId) {
          ws.send(JSON.stringify({
            type: 'replay_done',
            sessionId: null,
            lastSeq: 0,
            resumed: false,
          }));
          break;
        }

        const clientServerLastSeq = Number.isInteger(msg.serverLastSeq) && msg.serverLastSeq >= 0
          ? msg.serverLastSeq
          : null;
        const canResume = (
          msg.sessionId &&
          msg.sessionId === currentSessionId &&
          Number.isInteger(msg.lastSeq) &&
          msg.lastSeq >= 0 &&
          msg.lastSeq <= latestEventSeq() &&
          (clientServerLastSeq == null || msg.lastSeq <= clientServerLastSeq)
        );

        sendReplay(ws, canResume ? msg.lastSeq : null);
        break;
      }
      case 'input':
        // Raw terminal keystrokes from xterm.js in WebUI
        if (claudeProc) claudeProc.write(msg.data);
        break;
      case 'expect_clear':
        // Plan mode option 1 triggers /clear inside Claude Code;
        // client notifies us so we can detect the session switch.
        markExpectingSwitch();
        break;
      case 'chat':
        // Chat message from WebUI → write to PTY as user input
        // Must send text first, then Enter after a delay so Claude's
        // TUI (Ink) has time to process the typed characters
        if (claudeProc) {
          const text = msg.text;
          log(`Chat input → PTY: "${text.substring(0, 80)}"`);
          if (/^\/clear\s*$/i.test(text.trim())) {
            markExpectingSwitch();
          }
          broadcast({ type: 'working_started' });
          claudeProc.write(text);
          setTimeout(() => {
            if (claudeProc) claudeProc.write('\r');
          }, 150);
        }
        break;
      case 'resize':
        // Only resize if no local TTY is controlling size
        if (claudeProc && msg.cols && msg.rows && !isTTY) {
          claudeProc.resize(msg.cols, msg.rows);
        }
        break;
      case 'permission_response': {
        const approval = pendingApprovals.get(msg.id);
        if (approval) {
          clearTimeout(approval.timer);
          pendingApprovals.delete(msg.id);
          approval.res.writeHead(200, { 'Content-Type': 'application/json' });
          approval.res.end(JSON.stringify({
            decision: msg.decision,
            reason: msg.reason || '',
          }));
          log(`Permission #${msg.id}: ${msg.decision}`);
        }
        break;
      }
      case 'set_approval_mode': {
        const valid = ['default', 'partial', 'all'];
        if (valid.includes(msg.mode)) {
          approvalMode = msg.mode;
          log(`Approval mode changed to: ${approvalMode}`);
          // If switching to 'all' or 'partial', auto-resolve queued permissions
          if (approvalMode === 'all') {
            for (const [id, approval] of pendingApprovals) {
              clearTimeout(approval.timer);
              approval.res.writeHead(200, { 'Content-Type': 'application/json' });
              approval.res.end(JSON.stringify({ decision: 'allow' }));
              log(`Permission #${id}: auto-allowed (mode switched to all)`);
            }
            pendingApprovals.clear();
            broadcast({ type: 'clear_permissions' });
          }
        }
        break;
      }
      case 'image_upload_init': {
        const uploadId = String(msg.uploadId || '');
        if (!uploadId) {
          sendUploadStatus(ws, '', 'error', { message: 'Missing uploadId' });
          break;
        }
        cleanupImageUpload(uploadId);
        pendingImageUploads.set(uploadId, {
          id: uploadId,
          owner: ws,
          mediaType: msg.mediaType || 'image/png',
          name: msg.name || 'image',
          totalBytes: Number.isFinite(msg.totalBytes) ? msg.totalBytes : 0,
          totalChunks: Number.isFinite(msg.totalChunks) ? msg.totalChunks : 0,
          nextChunkIndex: 0,
          receivedBytes: 0,
          chunks: [],
          tmpFile: null,
          updatedAt: Date.now(),
        });
        sendUploadStatus(ws, uploadId, 'ready_for_chunks', { receivedBytes: 0, totalBytes: msg.totalBytes || 0 });
        break;
      }
      case 'image_upload_chunk': {
        const uploadId = String(msg.uploadId || '');
        const upload = pendingImageUploads.get(uploadId);
        if (!upload) {
          sendUploadStatus(ws, uploadId, 'error', { message: 'Upload session not found' });
          break;
        }
        if (upload.owner !== ws) {
          sendUploadStatus(ws, uploadId, 'error', { message: 'Upload owner mismatch' });
          break;
        }
        if (msg.index !== upload.nextChunkIndex) {
          sendUploadStatus(ws, uploadId, 'error', {
            message: `Unexpected chunk index ${msg.index}, expected ${upload.nextChunkIndex}`,
          });
          break;
        }
        if (!msg.base64) {
          sendUploadStatus(ws, uploadId, 'error', { message: 'Missing chunk payload' });
          break;
        }

        try {
          const chunk = Buffer.from(msg.base64, 'base64');
          upload.chunks.push(chunk);
          upload.receivedBytes += chunk.length;
          upload.nextChunkIndex += 1;
          upload.updatedAt = Date.now();
          sendUploadStatus(ws, uploadId, 'uploading', {
            chunkIndex: msg.index,
            receivedBytes: upload.receivedBytes,
            totalBytes: upload.totalBytes,
          });
        } catch (err) {
          sendUploadStatus(ws, uploadId, 'error', { message: err.message });
        }
        break;
      }
      case 'image_upload_complete': {
        const uploadId = String(msg.uploadId || '');
        const upload = pendingImageUploads.get(uploadId);
        if (!upload) {
          sendUploadStatus(ws, uploadId, 'error', { message: 'Upload session not found' });
          break;
        }
        if (upload.owner !== ws) {
          sendUploadStatus(ws, uploadId, 'error', { message: 'Upload owner mismatch' });
          break;
        }
        if (upload.nextChunkIndex !== upload.totalChunks) {
          sendUploadStatus(ws, uploadId, 'error', {
            message: `Upload incomplete (${upload.nextChunkIndex}/${upload.totalChunks})`,
          });
          break;
        }

        try {
          const buffer = Buffer.concat(upload.chunks);
          upload.tmpFile = createTempImageFile(buffer, upload.mediaType, uploadId);
          upload.chunks = [];
          upload.updatedAt = Date.now();
          log(`Image pre-upload complete: ${upload.tmpFile} (${buffer.length} bytes)`);
          sendUploadStatus(ws, uploadId, 'uploaded', {
            receivedBytes: upload.receivedBytes,
            totalBytes: upload.totalBytes,
          });
        } catch (err) {
          sendUploadStatus(ws, uploadId, 'error', { message: err.message });
          cleanupImageUpload(uploadId);
        }
        break;
      }
      case 'image_upload_abort': {
        const uploadId = String(msg.uploadId || '');
        if (uploadId) cleanupImageUpload(uploadId);
        sendUploadStatus(ws, uploadId, 'aborted');
        break;
      }
      case 'image_submit': {
        const uploadId = String(msg.uploadId || '');
        const upload = pendingImageUploads.get(uploadId);
        if (!upload || !upload.tmpFile) {
          sendUploadStatus(ws, uploadId, 'error', { message: 'Upload not ready' });
          break;
        }
        try {
          handlePreparedImageUpload({
            tmpFile: upload.tmpFile,
            mediaType: upload.mediaType,
            text: msg.text || '',
            logLabel: upload.name || uploadId,
            onCleanup: () => cleanupImageUpload(uploadId),
          });
          sendUploadStatus(ws, uploadId, 'submitted');
        } catch (err) {
          sendUploadStatus(ws, uploadId, 'error', { message: err.message });
          cleanupImageUpload(uploadId);
        }
        break;
      }
      case 'image_upload': {
        handleImageUpload(msg);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (ws._legacyReplayTimer) {
      clearTimeout(ws._legacyReplayTimer);
      ws._legacyReplayTimer = null;
    }
    cleanupClientUploads(ws);
  });
});

// ============================================================
//  3. PTY Mode Detection (ANSI side-channel parsing)
// ============================================================
let ptyTextBuf = '';

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B(?:\[[\x20-\x3f]*[0-9;]*[A-Za-z]|\].*?(?:\x07|\x1B\\)|\([B0])/g, '');
}

function detectModeFromPTY(data) {
  // Ink (Claude Code's TUI framework) redraws by sending cursor-up
  // sequences (\x1B[<n>A) followed by new content.  When we detect a
  // redraw we MUST clear the accumulated text buffer, otherwise stale
  // mode keywords from previous renders linger and cause false matches.
  if (/\x1B\[\d*A/.test(data)) {
    ptyTextBuf = '';
  }

  ptyTextBuf += stripAnsi(data);
  if (ptyTextBuf.length > 4000) ptyTextBuf = ptyTextBuf.slice(-2000);

  const tail = ptyTextBuf.slice(-500);
  const lc = tail.toLowerCase();

  let detected = null;

  // The status bar always contains "for shortcuts".
  // (Older versions: "shift+tab to cycle", newer: "? for shortcuts")
  const anchorIdx = Math.max(lc.lastIndexOf('for shortcuts'), lc.lastIndexOf('shift+tab'));

  if (anchorIdx >= 0) {
    // Inspect ~80 chars BEFORE and AFTER the anchor.
    // The mode label can appear on either side depending on status bar layout:
    //   "⏸ plan mode on  ? for shortcuts"   ← mode BEFORE anchor
    //   "? for shortcuts  ⏵⏵ accept edits"  ← mode AFTER anchor
    const before = lc.slice(Math.max(0, anchorIdx - 80), anchorIdx);
    const after  = lc.slice(anchorIdx, Math.min(lc.length, anchorIdx + 80));
    const win = before + after;
    log(`Mode window: [${win}]`);

    if (win.includes('plan')) {
      detected = 'plan';
    } else if (win.includes('accept')) {
      detected = 'acceptEdits';
    } else if (win.includes('bypass')) {
      detected = 'bypassPermissions';
    } else {
      // Status bar present but no mode keyword → default
      detected = 'default';
    }
  } else {
    // No status-bar anchor — check for explicit toggle messages
    // that Claude prints when mode changes (e.g. "⏸ plan mode on")
    if (/plan mode on/i.test(lc) || /\u23F8\s*plan/i.test(tail)) {
      detected = 'plan';
    } else if (/accept edits on/i.test(lc) || /\u23F5\u23F5\s*accept/i.test(tail)) {
      detected = 'acceptEdits';
    } else if (/bypass.*on/i.test(lc)) {
      detected = 'bypassPermissions';
    }
    // Check if buffer has status-bar content but anchor was mangled
    // If we see mode indicators like ⏸ or ⏵⏵ without explicit text
    else if (tail.includes('\u23F8')) {
      detected = 'plan';
    } else if (tail.includes('\u23F5\u23F5')) {
      detected = 'acceptEdits';
    }
  }

  if (detected && detected !== currentMode) {
    currentMode = detected;
    broadcast({ type: 'mode', mode: currentMode });
    log(`Mode detected from PTY: ${currentMode}`);
    ptyTextBuf = '';  // reset after detection
  }
}

// ============================================================
//  4. PTY Manager — local terminal passthrough
// ============================================================
function spawnClaude() {
  snapshotExistingFiles();

  const isWin = process.platform === 'win32';
  const shell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
  const args = isWin
    ? ['-NoLogo', '-NoProfile', '-Command', 'claude']
    : ['-c', 'claude'];

  // Use local terminal size if available, otherwise default
  const cols = isTTY ? process.stdout.columns : 120;
  const rows = isTTY ? process.stdout.rows : 40;

  claudeProc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: CWD,
    env: { ...process.env, FORCE_COLOR: '1', BRIDGE_PORT: String(PORT) },
  });

  log(`Claude spawned (pid ${claudeProc.pid}) — ${cols}x${rows}`);
  broadcast({ type: 'status', status: 'running', pid: claudeProc.pid });

  // === PTY output → local terminal + WebSocket + mode detection ===
  claudeProc.onData((data) => {
    if (isTTY) process.stdout.write(data);   // show in the terminal you ran the bridge from
    broadcast({ type: 'pty_output', data });  // push to WebUI
    detectModeFromPTY(data);
  });

  // === Local terminal input → PTY ===
  if (isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (chunk) => {
      if (claudeProc) claudeProc.write(chunk);
    });

    // Resize PTY when local terminal resizes
    process.stdout.on('resize', () => {
      if (claudeProc) {
        claudeProc.resize(process.stdout.columns, process.stdout.rows);
      }
    });
  }

  // === PTY exit → cleanup ===
  claudeProc.onExit(({ exitCode, signal }) => {
    log(`Claude exited (code=${exitCode}, signal=${signal})`);
    broadcast({ type: 'pty_exit', exitCode, signal });
    claudeProc = null;

    // Restore terminal and exit bridge
    if (isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    stopTailing();
    log('Bridge shutting down.');
    setTimeout(() => process.exit(exitCode || 0), 300);
  });
}

// ============================================================
//  4. Transcript Discovery & Tailing
// ============================================================
function getProjectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

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
      } catch {
        // ignore malformed lines at file tail
      }
    }
  } catch {}
  return false;
}

function attachTranscript(target, startOffset = 0) {
  transcriptPath = target.full;
  currentSessionId = path.basename(transcriptPath, '.jsonl');
  transcriptOffset = Math.max(0, startOffset);
  tailRemainder = Buffer.alloc(0);
  eventBuffer = [];
  eventSeq = 0;

  log(`Transcript attached: ${currentSessionId} (offset=${transcriptOffset})`);
  broadcast({
    type: 'transcript_ready',
    transcript: transcriptPath,
    sessionId: currentSessionId,
    lastSeq: 0,
  });

  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
  startTailing();
  startSwitchWatcher();
}

function snapshotExistingFiles() {
  const slug = getProjectSlug(CWD);
  const projectDir = path.join(PROJECTS_DIR, slug);
  preExistingFiles.clear();
  preExistingFileSizes.clear();
  try {
    if (fs.existsSync(projectDir)) {
      for (const f of fs.readdirSync(projectDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(projectDir, f);
        const stat = fs.statSync(full);
        preExistingFiles.add(f);
        preExistingFileSizes.set(f, stat.size);
      }
    }
  } catch {}
  log(`Pre-existing transcripts: ${preExistingFiles.size} files`);
}

function startDiscovery() {
  const slug = getProjectSlug(CWD);
  const projectDir = path.join(PROJECTS_DIR, slug);
  log(`Watching for NEW transcript in: ${projectDir}`);

  discoveryTimer = setInterval(() => {
    if (!fs.existsSync(projectDir)) return;

    try {
      const targets = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const full = path.join(projectDir, f);
          const stat = fs.statSync(full);
          return {
            name: f,
            full,
            mtime: stat.mtimeMs,
            size: stat.size,
          };
        })
        .sort((a, b) => b.mtime - a.mtime);

      const newTargets = targets.filter(t => !preExistingFiles.has(t.name));
      const newTranscript = newTargets.find(t => fileLooksLikeTranscript(t.full));
      if (newTranscript) {
        log(`NEW transcript found: ${path.basename(newTranscript.full, '.jsonl')}`);
        attachTranscript(newTranscript, 0);
        return;
      }

      for (const t of newTargets) {
        preExistingFiles.add(t.name);
        preExistingFileSizes.set(t.name, t.size);
      }

      // Fallback: reuse a pre-existing transcript if it keeps growing.
      const grownTargets = targets.filter(t => t.size > (preExistingFileSizes.get(t.name) || 0));
      const grownTranscript = grownTargets.find(t => fileLooksLikeTranscript(t.full));
      if (grownTranscript) {
        const baseOffset = preExistingFileSizes.get(grownTranscript.name) || 0;
        log(`Reusing growing transcript: ${path.basename(grownTranscript.full, '.jsonl')} (from offset ${baseOffset})`);
        attachTranscript(grownTranscript, baseOffset);
        return;
      }
    } catch {}
  }, 500);
}

function markExpectingSwitch() {
  expectingSwitch = true;
  if (expectingSwitchTimer) clearTimeout(expectingSwitchTimer);
  expectingSwitchTimer = setTimeout(() => {
    expectingSwitch = false;
    expectingSwitchTimer = null;
    log('Expecting-switch flag expired (no new transcript found)');
  }, 15000);
  log('Expecting session switch (/clear detected)');
}

function startSwitchWatcher() {
  if (switchWatcher) { clearInterval(switchWatcher); switchWatcher = null; }
  const slug = getProjectSlug(CWD);
  const projectDir = path.join(PROJECTS_DIR, slug);

  switchWatcher = setInterval(() => {
    if (!transcriptPath || !expectingSwitch || !fs.existsSync(projectDir)) return;
    try {
      const currentBasename = path.basename(transcriptPath);
      const candidates = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl') && f !== currentBasename)
        .map(f => {
          const full = path.join(projectDir, f);
          const stat = fs.statSync(full);
          return { name: f, full, mtime: stat.mtimeMs, size: stat.size };
        })
        .filter(t => t.mtime > fs.statSync(transcriptPath).mtimeMs)
        .sort((a, b) => b.mtime - a.mtime);

      const newer = candidates.find(t => fileLooksLikeTranscript(t.full));
      if (newer) {
        log(`Session switch detected → ${path.basename(newer.full, '.jsonl')}`);
        expectingSwitch = false;
        if (expectingSwitchTimer) { clearTimeout(expectingSwitchTimer); expectingSwitchTimer = null; }
        if (tailTimer) { clearInterval(tailTimer); tailTimer = null; }
        if (switchWatcher) { clearInterval(switchWatcher); switchWatcher = null; }
        attachTranscript(newer, 0);
      }
    } catch {}
  }, 500);
}

function startTailing() {
  tailRemainder = Buffer.alloc(0);
  tailTimer = setInterval(() => {
    if (!transcriptPath) return;
    try {
      const stat = fs.statSync(transcriptPath);
      if (stat.size <= transcriptOffset) return;

      const fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(stat.size - transcriptOffset);
      fs.readSync(fd, buf, 0, buf.length, transcriptOffset);
      fs.closeSync(fd);
      transcriptOffset = stat.size;

      const data = tailRemainder.length > 0 ? Buffer.concat([tailRemainder, buf]) : buf;
      let start = 0;
      for (let i = 0; i < data.length; i++) {
        if (data[i] !== 0x0A) continue; // '\n'
        const line = data.slice(start, i).toString('utf8').trim();
        start = i + 1;
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          // Detect /clear from JSONL events (covers terminal direct input)
          if (event.type === 'user' || (event.message && event.message.role === 'user')) {
            const content = event.message && event.message.content;
            if (typeof content === 'string' && /^\/clear\s*$/i.test(content.trim())) {
              markExpectingSwitch();
            }
          }
          const record = { seq: ++eventSeq, event };
          eventBuffer.push(record);
          if (eventBuffer.length > EVENT_BUFFER_MAX) {
            eventBuffer = eventBuffer.slice(-Math.round(EVENT_BUFFER_MAX * 0.8));
          }
          broadcast({ type: 'log_event', seq: record.seq, event });
        } catch {
          // skip malformed lines
        }
      }
      tailRemainder = data.slice(start);
    } catch {
      // file might be temporarily locked
    }
  }, 300);
}

function stopTailing() {
  if (tailTimer) { clearInterval(tailTimer); tailTimer = null; }
  if (discoveryTimer) { clearInterval(discoveryTimer); discoveryTimer = null; }
  if (switchWatcher) { clearInterval(switchWatcher); switchWatcher = null; }
  if (expectingSwitchTimer) { clearTimeout(expectingSwitchTimer); expectingSwitchTimer = null; }
  expectingSwitch = false;
  tailRemainder = Buffer.alloc(0);
}

// ============================================================
//  5. Image Upload → Clipboard Injection
// ============================================================
function handlePreparedImageUpload({ tmpFile, mediaType, text, logLabel = '', onCleanup = null }) {
  if (!claudeProc) throw new Error('Claude not running');
  if (!tmpFile || !fs.existsSync(tmpFile)) throw new Error('Prepared image file missing');

  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  try {
    const stat = fs.statSync(tmpFile);
    log(`Image ready: ${logLabel || path.basename(tmpFile)} (${stat.size} bytes)`);

    if (isWin) {
      const psCmd = `Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; $img = [System.Drawing.Image]::FromFile('${tmpFile.replace(/'/g, "''")}'); [System.Windows.Forms.Clipboard]::SetImage($img); $img.Dispose()`;
      execSync(`powershell -NoProfile -STA -Command "${psCmd}"`, { timeout: 10000 });
    } else if (isMac) {
      execSync(`osascript -e 'set the clipboard to (read POSIX file "${tmpFile}" as 芦class PNGf禄)'`, { timeout: 10000 });
    } else {
      try {
        execSync(`xclip -selection clipboard -t image/png -i < "${tmpFile}"`, { timeout: 10000, shell: true });
      } catch {
        execSync(`wl-copy --type image/png < "${tmpFile}"`, { timeout: 10000, shell: true });
      }
    }
    log('Clipboard set with image');

    if (isWin) claudeProc.write('\x1bv');
    else claudeProc.write('\x16');
    log('Sent image paste keypress to PTY');

    setTimeout(() => {
      if (!claudeProc) return;
      const trimmedText = (text || '').trim();
      if (trimmedText) claudeProc.write(trimmedText);

      setTimeout(() => {
        if (claudeProc) claudeProc.write('\r');
        log('Sent Enter after image paste' + (trimmedText ? ` + text: "${trimmedText.substring(0, 60)}"` : ''));

        setTimeout(() => {
          if (onCleanup) onCleanup();
          else {
            try { fs.unlinkSync(tmpFile); } catch {}
          }
        }, 5000);
      }, 150);
    }, 1000);
  } catch (err) {
    log(`Image upload error: ${err.message}`);
    if (onCleanup) onCleanup();
    else {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
    throw err;
  }
}

function handleImageUpload(msg) {
  if (!claudeProc) {
    log('Image upload ignored: Claude not running');
    return;
  }
  if (!msg.base64) {
    log('Image upload ignored: no base64 data');
    return;
  }

  const buf = Buffer.from(msg.base64, 'base64');
  const tmpFile = createTempImageFile(buf, msg.mediaType, `legacy_${Date.now()}`);

  try {
    log(`Image saved: ${tmpFile} (${buf.length} bytes)`);
    handlePreparedImageUpload({
      tmpFile,
      mediaType: msg.mediaType,
      text: msg.text || '',
    });
  } catch (err) {
    log(`Image upload error: ${err.message}`);
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ============================================================
//  6. Hook Auto-Setup

// ============================================================
function setupHooks() {
  const claudeDir = path.join(CWD, '.claude');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });

  const settingsPath = path.join(claudeDir, 'settings.local.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}

  const hookScript = path.resolve(__dirname, 'hooks', 'bridge-approval.js').replace(/\\/g, '/');
  const hookCmd = `node "${hookScript}"`;

  // Merge bridge hook into PreToolUse (preserve user's other hooks)
  const existing = settings.hooks?.PreToolUse || [];
  const bridgeIdx = existing.findIndex(e =>
    e.hooks?.some(h => h.command?.includes('bridge-approval'))
  );
  const bridgeEntry = {
    matcher: '',
    hooks: [{ type: 'command', command: hookCmd, timeout: 120 }],
  };

  if (bridgeIdx >= 0) {
    existing[bridgeIdx] = bridgeEntry;
  } else {
    existing.push(bridgeEntry);
  }

  settings.hooks = settings.hooks || {};
  settings.hooks.PreToolUse = existing;

  // Merge bridge hook into Stop (notify WebUI when Claude's turn ends)
  const stopScript = path.resolve(__dirname, 'hooks', 'bridge-stop.js').replace(/\\/g, '/');
  const stopCmd = `node "${stopScript}"`;
  const existingStop = settings.hooks.Stop || [];
  const stopBridgeIdx = existingStop.findIndex(e =>
    e.hooks?.some(h => h.command?.includes('bridge-stop'))
  );
  const stopEntry = {
    hooks: [{ type: 'command', command: stopCmd, timeout: 10 }],
  };
  if (stopBridgeIdx >= 0) {
    existingStop[stopBridgeIdx] = stopEntry;
  } else {
    existingStop.push(stopEntry);
  }
  settings.hooks.Stop = existingStop;

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  log(`Hooks configured: ${settingsPath}`);
}

// ============================================================
//  7. Startup
// ============================================================
server.listen(PORT, '0.0.0.0', () => {
  const ifaces = os.networkInterfaces();
  let lanIp = 'localhost';
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        lanIp = iface.address;
        break;
      }
    }
  }
  const local = `http://localhost:${PORT}`;
  const lan = `http://${lanIp}:${PORT}`;

  // Print banner to stdout BEFORE PTY takes over
  process.stdout.write(`
  Claude Remote Control Bridge
  ─────────────────────────────
  Local:  ${local}
  LAN:    ${lan}
  CWD:    ${CWD}
  Log:    ${LOG_FILE}

  Phone:  ${lan}
  ─────────────────────────────

`);
  setupHooks();
  spawnClaude();
  startDiscovery();
});
