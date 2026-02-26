const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const pty = require('node-pty');
const { WebSocketServer, WebSocket } = require('ws');

// --- Config ---
const PORT = parseInt(process.env.PORT || '3100', 10);
const CWD = process.argv[2] || process.cwd();
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');

// --- State ---
let claudeProc = null;
let transcriptPath = null;
let transcriptOffset = 0;
let eventBuffer = [];
let tailTimer = null;
let discoveryTimer = null;
let preExistingFiles = new Set();
const isTTY = process.stdin.isTTY && process.stdout.isTTY;

// --- Permission approval state ---
let approvalSeq = 0;
const pendingApprovals = new Map();  // id → { res, timer }
let currentMode = 'default';

// --- Logging → file only (never pollute the terminal) ---
const LOG_FILE = path.join(__dirname, 'bridge.log');
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

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({
    type: 'status',
    status: claudeProc ? 'running' : 'starting',
    hasTranscript: !!transcriptPath,
    cwd: CWD,
  }));

  // Replay buffered JSONL events
  for (const evt of eventBuffer) {
    ws.send(JSON.stringify({ type: 'log_event', event: evt }));
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'input':
        // Raw terminal keystrokes from xterm.js in WebUI
        if (claudeProc) claudeProc.write(msg.data);
        break;
      case 'chat':
        // Chat message from WebUI → write to PTY as user input
        // Must send text first, then Enter after a delay so Claude's
        // TUI (Ink) has time to process the typed characters
        if (claudeProc) {
          const text = msg.text;
          log(`Chat input → PTY: "${text.substring(0, 80)}"`);
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
    }
  });
});

// ============================================================
//  3. PTY Manager — local terminal passthrough
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

  // === PTY output → local terminal + WebSocket ===
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
  return cwd.replace(/[:\\/]/g, '-');
}

function snapshotExistingFiles() {
  const slug = getProjectSlug(CWD);
  const projectDir = path.join(PROJECTS_DIR, slug);
  preExistingFiles.clear();
  try {
    if (fs.existsSync(projectDir)) {
      for (const f of fs.readdirSync(projectDir)) {
        if (f.endsWith('.jsonl')) preExistingFiles.add(f);
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
      const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
      const newFiles = files.filter(f => !preExistingFiles.has(f));

      if (newFiles.length > 0) {
        const target = newFiles
          .map(f => ({
            name: f,
            full: path.join(projectDir, f),
            mtime: fs.statSync(path.join(projectDir, f)).mtimeMs,
          }))
          .sort((a, b) => b.mtime - a.mtime)[0];

        transcriptPath = target.full;
        transcriptOffset = 0;
        eventBuffer = [];
        const sessionId = path.basename(transcriptPath, '.jsonl');
        log(`NEW transcript found: ${sessionId}`);
        broadcast({
          type: 'transcript_ready',
          transcript: transcriptPath,
          sessionId,
        });
        clearInterval(discoveryTimer);
        discoveryTimer = null;
        startTailing();
      }
    } catch {}
  }, 500);
}

function startTailing() {
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

      const chunk = buf.toString('utf8');
      const lines = chunk.split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          eventBuffer.push(event);
          broadcast({ type: 'log_event', event });
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // file might be temporarily locked
    }
  }, 300);
}

function stopTailing() {
  if (tailTimer) { clearInterval(tailTimer); tailTimer = null; }
  if (discoveryTimer) { clearInterval(discoveryTimer); discoveryTimer = null; }
}

// ============================================================
//  5. Hook Auto-Setup
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
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  log(`Hooks configured: ${settingsPath}`);
}

// ============================================================
//  6. Startup
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
