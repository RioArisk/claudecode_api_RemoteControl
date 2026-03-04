'use strict';

const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { state, CLAUDE_STATE_FILE, isTTY } = require('./state');
const { log, broadcast, setTurnState, latestEventSeq, emitInterrupt, formatTtyInputChunk } = require('./logger');
const { stopTailing } = require('./transcript');
const { setupHooks } = require('./hooks');

function attachTtyForwarders() {
  if (!isTTY || state.ttyInputForwarderAttached) return;

  state.ttyInputHandler = (chunk) => {
    if (state.DEBUG_TTY_INPUT) {
      try {
        log(`TTY input ${formatTtyInputChunk(chunk)}`);
      } catch (err) {
        log(`TTY input log error: ${err.message}`);
      }
    }
    if (state.claudeProc) state.claudeProc.write(chunk);
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.includes(0x03) && state.turnState.phase === 'running') {
      log('Terminal Ctrl+C detected — injecting interrupt event');
      emitInterrupt('terminal');
    }
  };
  state.ttyResizeHandler = () => {
    if (state.claudeProc) state.claudeProc.resize(process.stdout.columns, process.stdout.rows);
  };

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', state.ttyInputHandler);
  process.stdout.on('resize', state.ttyResizeHandler);
  state.ttyInputForwarderAttached = true;
}

function trustProjectCwd(cwd) {
  const resolved = path.resolve(String(cwd || ''));
  if (!resolved) return;

  let stateData = {};
  try {
    stateData = JSON.parse(fs.readFileSync(CLAUDE_STATE_FILE, 'utf8'));
  } catch {}

  stateData.projects = stateData.projects && typeof stateData.projects === 'object' ? stateData.projects : {};
  const keyVariants = process.platform === 'win32'
    ? [resolved, resolved.replace(/\\/g, '/')]
    : [resolved];

  for (const projectKey of keyVariants) {
    const existing = stateData.projects[projectKey];
    stateData.projects[projectKey] = {
      ...(existing && typeof existing === 'object' ? existing : {}),
      hasTrustDialogAccepted: true,
      projectOnboardingSeenCount: Number.isInteger(existing?.projectOnboardingSeenCount)
        ? existing.projectOnboardingSeenCount
        : 0,
    };
  }

  fs.writeFileSync(CLAUDE_STATE_FILE, JSON.stringify(stateData, null, 2));
  log(`Trusted Claude project cwd: ${resolved}`);
}

function spawnClaude() {
  const isWin = process.platform === 'win32';
  const shell = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash');
  const claudeCmd = state.CLAUDE_EXTRA_ARGS.length > 0
    ? `claude ${state.CLAUDE_EXTRA_ARGS.join(' ')}`
    : 'claude';
  const args = isWin
    ? ['-NoLogo', '-NoProfile', '-Command', claudeCmd]
    : ['-c', claudeCmd];

  const cols = isTTY ? process.stdout.columns : 120;
  const rows = isTTY ? process.stdout.rows : 40;

  const proc = state.claudeProc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: state.CWD,
    env: { ...process.env, FORCE_COLOR: '1', BRIDGE_PORT: String(state.PORT) },
  });

  log(`Claude spawned (pid ${state.claudeProc.pid}) — ${cols}x${rows} cmd="${claudeCmd}"`);
  setTurnState('idle', { sessionId: state.currentSessionId, reason: 'claude_spawned' });
  broadcast({
    type: 'status',
    status: 'running',
    pid: proc.pid,
    cwd: state.CWD,
    sessionId: state.currentSessionId,
    lastSeq: latestEventSeq(),
  });

  proc.onData((data) => {
    if (isTTY) process.stdout.write(data);
    broadcast({ type: 'pty_output', data });
  });

  attachTtyForwarders();

  proc.onExit(({ exitCode, signal }) => {
    if (state.claudeProc !== proc) {
      log(`Ignoring stale Claude exit (pid ${proc.pid}, code=${exitCode}, signal=${signal})`);
      return;
    }
    log(`Claude exited (code=${exitCode}, signal=${signal})`);
    setTurnState('idle', { sessionId: state.currentSessionId, reason: 'pty_exit' });
    broadcast({ type: 'pty_exit', exitCode, signal });
    state.claudeProc = null;

    if (isTTY) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }
    stopTailing();
    log('Bridge shutting down.');
    setTimeout(() => process.exit(exitCode || 0), 300);
  });
}

function restartClaude(newCwd) {
  log(`Restarting Claude with new CWD: ${newCwd}`);
  state.CWD = newCwd;
  try {
    trustProjectCwd(state.CWD);
  } catch (err) {
    log(`Failed to trust Claude project cwd "${state.CWD}": ${err.message}`);
  }

  stopTailing();

  state.currentSessionId = null;
  state.transcriptPath = null;
  state.transcriptOffset = 0;
  state.eventBuffer = [];
  state.eventSeq = 0;
  state.tailCatchingUp = false;
  setTurnState('idle', { sessionId: null, reason: 'restart_claude' });

  const procToRestart = state.claudeProc;
  state.claudeProc = null;
  if (procToRestart) {
    procToRestart.kill();
  }

  setupHooks();
  broadcast({ type: 'cwd_changed', cwd: state.CWD, sessionId: null, lastSeq: 0 });
  spawnClaude();
}

module.exports = {
  spawnClaude,
  restartClaude,
  attachTtyForwarders,
};
