const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const pty = require('node-pty');
const { WebSocketServer, WebSocket } = require('ws');
const { execSync } = require('child_process');

// --- CLI argument parsing ---
// Separate bridge args (CWD positional) from claude passthrough flags.
// Usage: claude-remote [cwd] [--claude-flags...]
// Example: claude-remote --resume xxx
//          claude-remote /path/to/project --resume xxx -c
const BLOCKED_FLAGS = new Set([
  '--print', '-p',                   // non-interactive mode, breaks PTY bridge
  '--output-format',                 // requires --print
  '--input-format',                  // requires --print
  '--include-partial-messages',      // requires --print
  '--json-schema',                   // requires --print
  '--no-session-persistence',        // requires --print
  '--max-budget-usd',               // requires --print
  '--max-turns',                     // requires --print
  '--fallback-model',               // requires --print
  '--permission-prompt-tool',        // conflicts with bridge approval hooks
  '--version', '-v',                 // exits immediately
  '--help', '-h',                    // exits immediately
  '--init-only',                     // exits immediately
  '--maintenance',                   // exits immediately
]);

// Flags that consume the next argument as a value
const FLAGS_WITH_VALUE = new Set([
  '--resume', '-r', '--session-id', '--from-pr', '--model',
  '--system-prompt', '--system-prompt-file',
  '--append-system-prompt', '--append-system-prompt-file',
  '--permission-mode', '--add-dir', '--worktree', '-w',
  '--mcp-config', '--settings', '--setting-sources',
  '--agent', '--agents', '--teammate-mode',
  '--allowedTools', '--disallowedTools', '--tools',
  '--betas', '--debug', '--plugin-dir',
  // blocked but still need to consume their values when filtering
  '--output-format', '--input-format', '--json-schema',
  '--max-budget-usd', '--max-turns', '--fallback-model',
  '--permission-prompt-tool',
]);

function parseCliArgs(argv) {
  const rawArgs = argv.slice(2);
  let cwd = null;
  const claudeArgs = [];
  const blocked = [];

  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];

    if (arg === '--') {
      // Everything after -- is passed to claude
      claudeArgs.push(...rawArgs.slice(i + 1));
      break;
    }

    if (!arg.startsWith('-')) {
      // Positional arg → treat first one as CWD (backward compatible)
      if (!cwd) {
        cwd = arg;
      } else {
        claudeArgs.push(arg);
      }
      i++;
      continue;
    }

    // Handle --flag=value syntax
    const eqIdx = arg.indexOf('=');
    const flagName = eqIdx > 0 ? arg.substring(0, eqIdx) : arg;

    if (BLOCKED_FLAGS.has(flagName)) {
      blocked.push(flagName);
      if (eqIdx > 0) {
        // --flag=value, already consumed
      } else if (FLAGS_WITH_VALUE.has(flagName) && i + 1 < rawArgs.length) {
        i++; // skip the value too
      }
      i++;
      continue;
    }

    // Pass through to claude
    claudeArgs.push(arg);
    // If this flag takes a value and it's not in --flag=value form, grab next arg
    if (eqIdx < 0 && FLAGS_WITH_VALUE.has(flagName) && i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('-')) {
      i++;
      claudeArgs.push(rawArgs[i]);
    }
    i++;
  }

  return { cwd: cwd || process.cwd(), claudeArgs, blocked };
}

const { cwd: _parsedCwd, claudeArgs: CLAUDE_EXTRA_ARGS, blocked: _blockedArgs } = parseCliArgs(process.argv);

// --- Config ---
const PORT = parseInt(process.env.PORT || '3100', 10);
const CWD = _parsedCwd;
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
let nextWsId = 0;
let tailTimer = null;
let switchWatcher = null;
let expectingSwitch = false;
let expectingSwitchTimer = null;
let pendingSwitchTarget = null;
let tailRemainder = Buffer.alloc(0);
let tailCatchingUp = false; // true while reading historical transcript content
const isTTY = process.stdin.isTTY && process.stdout.isTTY;
const LEGACY_REPLAY_DELAY_MS = 1500;
const IMAGE_UPLOAD_TTL_MS = 15 * 60 * 1000;

// --- Permission approval state ---
let approvalSeq = 0;
const pendingApprovals = new Map();  // id → { res, timer }
const pendingImageUploads = new Map();
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

function wsLabel(ws) {
  const clientId = ws && ws._clientInstanceId ? ` client=${ws._clientInstanceId}` : '';
  return `ws#${ws && ws._bridgeId ? ws._bridgeId : '?'}${clientId}`;
}

function sendWs(ws, msg, context = '') {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(msg));
  if (msg.type === 'status' || msg.type === 'transcript_ready' || msg.type === 'replay_done') {
    const extra = [];
    if (msg.sessionId !== undefined) extra.push(`session=${msg.sessionId ?? 'null'}`);
    if (msg.lastSeq !== undefined) extra.push(`lastSeq=${msg.lastSeq}`);
    if (msg.resumed !== undefined) extra.push(`resumed=${msg.resumed}`);
    log(`Send ${msg.type}${context ? ` (${context})` : ''} -> ${wsLabel(ws)}${extra.length ? ` ${extra.join(' ')}` : ''}`);
  }
  return true;
}

function normalizeFsPath(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function projectTranscriptDir() {
  return path.join(PROJECTS_DIR, getProjectSlug(CWD));
}

function resolveHookTranscript(data) {
  if (!data || typeof data !== 'object') return null;

  const hookCwd = data.cwd ? path.resolve(String(data.cwd)) : '';
  if (hookCwd && normalizeFsPath(hookCwd) !== normalizeFsPath(CWD)) return null;

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

  // Already attached to this exact session — no-op
  if (currentSessionId === target.sessionId && transcriptPath &&
      normalizeFsPath(transcriptPath) === normalizeFsPath(target.full)) {
    return;
  }

  const targetHasContent = fileLooksLikeTranscript(target.full);

  if (source === 'session-start') {
    // session-start is unreliable for --resume (fires twice, one is a
    // snapshot-only session). Only accept when:
    // 1. No session bound yet (first attach), OR
    // 2. Expecting a switch (/clear), OR
    // 3. Target has conversation content and current doesn't
    if (currentSessionId && !expectingSwitch) {
      const currentHasContent = transcriptPath && fileLooksLikeTranscript(transcriptPath);
      if (!targetHasContent || currentHasContent) {
        if (currentSessionId !== target.sessionId) {
          pendingSwitchTarget = { ...target, seenAt: Date.now(), source };
          log(`Queued pending session-start: ${target.sessionId} (current=${currentSessionId} currentHasContent=${currentHasContent} targetHasContent=${targetHasContent})`);
        }
        log(`Ignored session-start: ${target.sessionId} (current=${currentSessionId} currentHasContent=${currentHasContent} targetHasContent=${targetHasContent})`);
        return;
      }
    }
  } else if (source === 'pre-tool-use') {
    // pre-tool-use is the authoritative source — comes from the actually
    // running Claude process. Always allow it to correct the session,
    // as long as the target transcript has conversation content.
    if (currentSessionId && currentSessionId !== target.sessionId && !targetHasContent) {
      log(`Ignored pre-tool-use: ${target.sessionId} (no conversation content)`);
      return;
    }
  } else {
    // Other sources (e.g. stop) — only accept if matching current or no session
    if (currentSessionId && currentSessionId !== target.sessionId && !expectingSwitch) {
      log(`Ignored hook session from ${source}: ${target.sessionId} (current=${currentSessionId})`);
      return;
    }
  }

  log(`Hook session attached from ${source}: ${target.sessionId}`);
  attachTranscript({ full: target.full }, 0);
}

function maybeAttachPendingSwitchTarget(reason, requireReady = true) {
  if (!pendingSwitchTarget) return false;
  if ((Date.now() - pendingSwitchTarget.seenAt) > 15000) {
    log(`Dropped stale pending switch target: ${pendingSwitchTarget.sessionId}`);
    pendingSwitchTarget = null;
    return false;
  }
  if (pendingSwitchTarget.sessionId === currentSessionId) {
    pendingSwitchTarget = null;
    return false;
  }

  if (requireReady && !fileLooksLikeTranscript(pendingSwitchTarget.full)) {
    return false;
  }

  const target = pendingSwitchTarget;
  pendingSwitchTarget = null;
  log(`Attaching pending switch target from ${reason}: ${target.sessionId}`);
  if (tailTimer) { clearInterval(tailTimer); tailTimer = null; }
  if (switchWatcher) { clearInterval(switchWatcher); switchWatcher = null; }
  attachTranscript({ full: target.full }, 0);
  return true;
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

      maybeAttachHookSession(data, 'pre-tool-use');

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

  // --- API: Session start hook endpoint ---
  if (req.method === 'POST' && url === '/hook/session-start') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      try {
        maybeAttachHookSession(JSON.parse(body), 'session-start');
      } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    return;
  }

  // --- API: Stop hook endpoint ---
  if (req.method === 'POST' && url === '/hook/stop') {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      log('/hook/stop received — broadcasting turn_complete');
      try {
        maybeAttachHookSession(JSON.parse(body), 'stop');
      } catch {}
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
  const recipients = [];
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(raw);
      recipients.push(wsLabel(ws));
    }
  }
  if (msg.type === 'working_started' || msg.type === 'turn_complete' || msg.type === 'status' || msg.type === 'transcript_ready') {
    log(`Broadcast ${msg.type} -> ${recipients.length} client(s)${recipients.length ? ` [${recipients.join(', ')}]` : ''}`);
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

  log(`Replay start -> ${wsLabel(ws)} from=${replayFrom} count=${records.length} currentSession=${currentSessionId ?? 'null'}`);

  for (const record of records) {
    ws.send(JSON.stringify({
      type: 'log_event',
      seq: record.seq,
      event: record.event,
    }));
  }

  sendWs(ws, {
    type: 'replay_done',
    sessionId: currentSessionId,
    lastSeq: latestEventSeq(),
    resumed: normalizedLastSeq != null,
  }, 'sendReplay');
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

wss.on('connection', (ws, req) => {
  ws._bridgeId = ++nextWsId;
  ws._clientInstanceId = '';
  log(`WS connected: ${wsLabel(ws)} remote=${req.socket.remoteAddress || '?'} ua=${JSON.stringify(req.headers['user-agent'] || '')}`);

  sendWs(ws, {
    type: 'status',
    status: claudeProc ? 'running' : 'starting',
    hasTranscript: !!transcriptPath,
    cwd: CWD,
    sessionId: currentSessionId,
    lastSeq: latestEventSeq(),
  }, 'initial');

  if (currentSessionId) {
    sendWs(ws, {
      type: 'transcript_ready',
      transcript: transcriptPath,
      sessionId: currentSessionId,
      lastSeq: latestEventSeq(),
    }, 'initial');
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
      case 'hello':
        ws._clientInstanceId = String(msg.clientInstanceId || ws._clientInstanceId || '');
        log(`WS hello from ${wsLabel(ws)} page=${JSON.stringify(msg.page || '')} ua=${JSON.stringify(msg.userAgent || '')}`);
        break;
      case 'debug_log':
        if (msg.clientInstanceId) ws._clientInstanceId = String(msg.clientInstanceId);
        log(`ClientDebug ${wsLabel(ws)} event=${msg.event || 'unknown'} detail=${JSON.stringify(msg.detail || {})}`);
        break;
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

        log(`Resume request from ${wsLabel(ws)} session=${msg.sessionId ?? 'null'} lastSeq=${msg.lastSeq} serverLastSeq=${clientServerLastSeq ?? 'null'} canResume=${canResume}`);

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
          const slashCommand = extractSlashCommand(text);
          if (slashCommand === '/clear') {
            markExpectingSwitch();
          }
          // Slash commands (e.g. /clear, /help, /compact) are internal CLI
          // commands, not AI turns — the stop hook will never fire, so don't
          // enter the waiting state.
          if (!slashCommand) {
            broadcast({ type: 'working_started' });
          }
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
    log(`WS closed: ${wsLabel(ws)}`);
    cleanupClientUploads(ws);
  });
});

// ============================================================
//  4. PTY Manager — local terminal passthrough
// ============================================================
function spawnClaude() {
  const isWin = process.platform === 'win32';
  const shell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
  const claudeCmd = CLAUDE_EXTRA_ARGS.length > 0
    ? `claude ${CLAUDE_EXTRA_ARGS.join(' ')}`
    : 'claude';
  const args = isWin
    ? ['-NoLogo', '-NoProfile', '-Command', claudeCmd]
    : ['-c', claudeCmd];

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

  log(`Claude spawned (pid ${claudeProc.pid}) — ${cols}x${rows} cmd="${claudeCmd}"`);
  broadcast({ type: 'status', status: 'running', pid: claudeProc.pid });

  // === PTY output → local terminal + WebSocket + mode detection ===
  claudeProc.onData((data) => {
    if (isTTY) process.stdout.write(data);   // show in the terminal you ran the bridge from
    broadcast({ type: 'pty_output', data });  // push to WebUI
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

function isNonAiUserEvent(event, content) {
  if (!event || typeof event !== 'object') return false;
  if (event.isMeta === true) return true;
  if (event.isCompactSummary === true) return true;
  if (event.isVisibleInTranscriptOnly === true) return true;

  const text = flattenUserContent(content).trim();
  if (!text) return false;
  return /<local-command-(?:stdout|stderr|caveat)>/i.test(text);
}

function attachTranscript(target, startOffset = 0) {
  transcriptPath = target.full;
  currentSessionId = path.basename(transcriptPath, '.jsonl');
  if (pendingSwitchTarget && pendingSwitchTarget.sessionId === currentSessionId) {
    pendingSwitchTarget = null;
  }
  transcriptOffset = Math.max(0, startOffset);
  tailRemainder = Buffer.alloc(0);
  eventBuffer = [];
  eventSeq = 0;

  // Clear the expecting-switch state — we've found the new session.
  if (expectingSwitch) {
    expectingSwitch = false;
    if (expectingSwitchTimer) { clearTimeout(expectingSwitchTimer); expectingSwitchTimer = null; }
  }

  // If transcript file already has content, mark as catching up so we don't
  // broadcast working_started for historical user messages.
  try {
    const stat = fs.statSync(transcriptPath);
    tailCatchingUp = stat.size > transcriptOffset;
  } catch {
    tailCatchingUp = false;
  }

  log(`Transcript attached: ${currentSessionId} (offset=${transcriptOffset} catchUp=${tailCatchingUp})`);
  broadcast({
    type: 'transcript_ready',
    transcript: transcriptPath,
    sessionId: currentSessionId,
    lastSeq: 0,
  });
  startTailing();
  startSwitchWatcher();
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
  if (maybeAttachPendingSwitchTarget('markExpectingSwitch')) return;
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
    if (maybeAttachPendingSwitchTarget('tail_pending_target')) return;
    if (!transcriptPath) return;
    try {
      const stat = fs.statSync(transcriptPath);
      if (stat.size <= transcriptOffset) {
        // Caught up to file end — initial catch-up phase is over
        if (tailCatchingUp) {
          tailCatchingUp = false;
          log('Tail catch-up complete, live mode');
        }
        return;
      }

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
            const slashCommand = extractSlashCommand(content);
            const isPassiveUserEvent = isNonAiUserEvent(event, content);
            // Only broadcast working_started for live (new) user messages,
            // not for historical events during catch-up, and not for slash
            // commands (which are CLI commands, not AI turns).
            if (!tailCatchingUp && !slashCommand && !isPassiveUserEvent) {
              broadcast({ type: 'working_started' });
            }
            if (slashCommand === '/clear') {
              markExpectingSwitch();
            }
          }
          // Enrich Edit tool_use blocks with source file start line
          enrichEditStartLines(event);
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

function enrichEditStartLines(event) {
  const content = event.message && event.message.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block.type !== 'tool_use' || block.name !== 'Edit') continue;
    const input = block.input;
    if (!input || !input.file_path || input.old_string === undefined) continue;
    try {
      const filePath = path.resolve(CWD, input.file_path);
      const src = fs.readFileSync(filePath, 'utf8');
      // Search for new_string first (edit likely already applied), fallback to old_string
      const needle = input.new_string || input.old_string;
      const idx = src.indexOf(needle);
      if (idx >= 0) {
        input._startLine = src.substring(0, idx).split('\n').length;
      }
    } catch {
      // file not readable — skip enrichment
    }
  }
}

function stopTailing() {
  if (tailTimer) { clearInterval(tailTimer); tailTimer = null; }
  if (switchWatcher) { clearInterval(switchWatcher); switchWatcher = null; }
  if (expectingSwitchTimer) { clearTimeout(expectingSwitchTimer); expectingSwitchTimer = null; }
  expectingSwitch = false;
  pendingSwitchTarget = null;
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

  const sessionStartScript = path.resolve(__dirname, 'hooks', 'bridge-session-start.js').replace(/\\/g, '/');
  const sessionStartCmd = `node "${sessionStartScript}"`;
  const existingSessionStart = settings.hooks.SessionStart || [];
  const sessionStartBridgeIdx = existingSessionStart.findIndex(e =>
    e.hooks?.some(h => h.command?.includes('bridge-session-start'))
  );
  const sessionStartEntry = {
    hooks: [{ type: 'command', command: sessionStartCmd, timeout: 10 }],
  };
  if (sessionStartBridgeIdx >= 0) {
    existingSessionStart[sessionStartBridgeIdx] = sessionStartEntry;
  } else {
    existingSessionStart.push(sessionStartEntry);
  }
  settings.hooks.SessionStart = existingSessionStart;

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
  let banner = `
  Claude Remote Control Bridge
  ─────────────────────────────
  Local:  ${local}
  LAN:    ${lan}
  CWD:    ${CWD}
  Log:    ${LOG_FILE}
`;
  if (CLAUDE_EXTRA_ARGS.length > 0) {
    banner += `  Args:   claude ${CLAUDE_EXTRA_ARGS.join(' ')}\n`;
  }
  if (_blockedArgs.length > 0) {
    banner += `  Blocked: ${_blockedArgs.join(', ')} (incompatible with bridge)\n`;
  }
  banner += `
  Phone:  ${lan}
  ─────────────────────────────

`;
  process.stdout.write(banner);
  setupHooks();
  spawnClaude();
});
