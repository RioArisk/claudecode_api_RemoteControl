'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const {
  state,
  IMAGE_UPLOAD_TTL_MS,
  LINUX_CLIPBOARD_READY_GRACE_MS,
  LINUX_AT_PROMPT_SUBMIT_DELAY_MS,
  LINUX_AT_IMAGE_CLEANUP_DELAY_MS,
} = require('./state');
const { log, setTurnState } = require('./logger');

// ============================================================
//  Temp File Management
// ============================================================
function createTempImageFile(buffer, mediaType, uploadId) {
  const isLinux = process.platform !== 'win32' && process.platform !== 'darwin';
  const tmpDir = isLinux
    ? path.join(state.CWD, 'tmp')
    : (process.env.CLAUDE_CODE_TMPDIR || os.tmpdir());
  const type = String(mediaType || 'image/png').toLowerCase();
  const ext = type.includes('jpeg') || type.includes('jpg') ? '.jpg' : '.png';
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `bridge_upload_${uploadId}_${Date.now()}${ext}`);
  fs.writeFileSync(tmpFile, buffer);
  return tmpFile;
}

function cleanupImageUpload(uploadId) {
  const upload = state.pendingImageUploads.get(uploadId);
  if (!upload) return;
  if (upload.tmpFile) {
    try { fs.unlinkSync(upload.tmpFile); } catch {}
  }
  state.pendingImageUploads.delete(uploadId);
}

function cleanupClientUploads(ws) {
  for (const [uploadId, upload] of state.pendingImageUploads) {
    if (upload.owner === ws && !upload.submitted) cleanupImageUpload(uploadId);
  }
}

function sendUploadStatus(ws, uploadId, status, extra = {}) {
  if (!ws || ws.readyState !== 1 /* WebSocket.OPEN */) return;
  ws.send(JSON.stringify({
    type: 'image_upload_status',
    uploadId,
    status,
    ...extra,
  }));
}

// ============================================================
//  Linux Clipboard Utilities
// ============================================================
function toClaudeAtPath(filePath) {
  const normalized = path.normalize(String(filePath || ''));
  const rel = path.relative(state.CWD, normalized);
  const inProject = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  const target = inProject ? rel : normalized;
  return target.split(path.sep).join('/');
}

function buildLinuxImagePrompt(text, tmpFile) {
  const trimmedText = String(text || '').trim();
  const atPath = `@${toClaudeAtPath(tmpFile)}`;
  return trimmedText ? `${trimmedText} ${atPath}` : atPath;
}

function isLinuxClipboardToolInstalled(tool) {
  try {
    execSync(`command -v ${tool} >/dev/null 2>&1`, {
      stdio: 'ignore',
      shell: '/bin/sh',
      timeout: 2000,
    });
    return true;
  } catch {
    return false;
  }
}

function setLinuxImagePasteInFlight(active, reason = '') {
  state.linuxImagePasteInFlight = !!active;
  if (reason) log(`Linux image paste lock=${state.linuxImagePasteInFlight ? 'on' : 'off'} reason=${reason}`);
}

function normalizeLinuxEnvVar(value) {
  const text = String(value || '').trim();
  return text || null;
}

function parseLinuxProcStatusUid(statusText) {
  const match = String(statusText || '').match(/^Uid:\s+(\d+)/m);
  return match ? Number(match[1]) : null;
}

function readLinuxProcGuiEnv(pid) {
  try {
    const statusPath = `/proc/${pid}/status`;
    const environPath = `/proc/${pid}/environ`;
    const statusText = fs.readFileSync(statusPath, 'utf8');
    const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (currentUid != null) {
      const procUid = parseLinuxProcStatusUid(statusText);
      if (procUid == null || procUid !== currentUid) return null;
    }
    const envRaw = fs.readFileSync(environPath, 'utf8');
    if (!envRaw) return null;
    let waylandDisplay = null;
    let display = null;
    let runtimeDir = null;
    let xAuthority = null;

    for (const entry of envRaw.split('\0')) {
      if (!entry) continue;
      if (entry.startsWith('WAYLAND_DISPLAY=')) waylandDisplay = normalizeLinuxEnvVar(entry.slice('WAYLAND_DISPLAY='.length));
      else if (entry.startsWith('DISPLAY=')) display = normalizeLinuxEnvVar(entry.slice('DISPLAY='.length));
      else if (entry.startsWith('XDG_RUNTIME_DIR=')) runtimeDir = normalizeLinuxEnvVar(entry.slice('XDG_RUNTIME_DIR='.length));
      else if (entry.startsWith('XAUTHORITY=')) xAuthority = normalizeLinuxEnvVar(entry.slice('XAUTHORITY='.length));
    }

    if (!waylandDisplay && !display) return null;
    return { waylandDisplay, display, runtimeDir, xAuthority };
  } catch {
    return null;
  }
}

function discoverLinuxGuiEnvFromProc() {
  if (process.platform === 'win32' || process.platform === 'darwin') return null;
  let entries = [];
  try {
    entries = fs.readdirSync('/proc', { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!/^\d+$/.test(entry.name)) continue;
    if (Number(entry.name) === process.pid) continue;
    const discovered = readLinuxProcGuiEnv(entry.name);
    if (discovered) return discovered;
  }
  return null;
}

function discoverLinuxGuiEnvFromSocket() {
  if (process.platform === 'win32' || process.platform === 'darwin') return null;
  const discovered = {
    waylandDisplay: null,
    display: null,
    runtimeDir: null,
    xAuthority: null,
  };

  const currentUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const runtimeDir = currentUid != null ? `/run/user/${currentUid}` : null;
  if (runtimeDir && fs.existsSync(runtimeDir)) {
    discovered.runtimeDir = runtimeDir;
    try {
      const entries = fs.readdirSync(runtimeDir);
      const waylandSockets = entries.filter(name => /^wayland-\d+$/.test(name)).sort();
      if (waylandSockets.length > 0) discovered.waylandDisplay = waylandSockets[0];
    } catch {}
  }

  try {
    const xEntries = fs.readdirSync('/tmp/.X11-unix');
    const displaySockets = xEntries
      .map(name => {
        const match = /^X(\d+)$/.exec(name);
        return match ? Number(match[1]) : null;
      })
      .filter(num => Number.isInteger(num))
      .sort((a, b) => a - b);
    if (displaySockets.length > 0) discovered.display = `:${displaySockets[0]}`;
  } catch {}

  if (!discovered.waylandDisplay && !discovered.display) return null;
  return discovered;
}

function getLinuxClipboardEnv() {
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return { env: process.env, source: 'not_linux' };
  }

  const overlay = {
    WAYLAND_DISPLAY: normalizeLinuxEnvVar(process.env.CLAUDE_REMOTE_WAYLAND_DISPLAY) || normalizeLinuxEnvVar(process.env.WAYLAND_DISPLAY),
    DISPLAY: normalizeLinuxEnvVar(process.env.CLAUDE_REMOTE_DISPLAY) || normalizeLinuxEnvVar(process.env.DISPLAY),
    XDG_RUNTIME_DIR: normalizeLinuxEnvVar(process.env.CLAUDE_REMOTE_XDG_RUNTIME_DIR) || normalizeLinuxEnvVar(process.env.XDG_RUNTIME_DIR),
    XAUTHORITY: normalizeLinuxEnvVar(process.env.CLAUDE_REMOTE_XAUTHORITY) || normalizeLinuxEnvVar(process.env.XAUTHORITY),
  };

  let source = 'process_env';
  const needsSocketDiscovery =
    (!overlay.WAYLAND_DISPLAY && !overlay.DISPLAY) ||
    (!!overlay.WAYLAND_DISPLAY && !overlay.XDG_RUNTIME_DIR);
  if (needsSocketDiscovery) {
    const before = {
      waylandDisplay: overlay.WAYLAND_DISPLAY,
      display: overlay.DISPLAY,
      runtimeDir: overlay.XDG_RUNTIME_DIR,
      xAuthority: overlay.XAUTHORITY,
    };
    const fromSocket = discoverLinuxGuiEnvFromSocket();
    if (fromSocket) {
      if (!overlay.WAYLAND_DISPLAY && fromSocket.waylandDisplay) overlay.WAYLAND_DISPLAY = fromSocket.waylandDisplay;
      if (!overlay.DISPLAY && fromSocket.display) overlay.DISPLAY = fromSocket.display;
      if (!overlay.XDG_RUNTIME_DIR && fromSocket.runtimeDir) overlay.XDG_RUNTIME_DIR = fromSocket.runtimeDir;
      if (!overlay.XAUTHORITY && fromSocket.xAuthority) overlay.XAUTHORITY = fromSocket.xAuthority;
      const changed =
        before.waylandDisplay !== overlay.WAYLAND_DISPLAY ||
        before.display !== overlay.DISPLAY ||
        before.runtimeDir !== overlay.XDG_RUNTIME_DIR ||
        before.xAuthority !== overlay.XAUTHORITY;
      if (changed) source = 'socket_discovery';
    }
  }

  const needsProcDiscovery =
    (!overlay.WAYLAND_DISPLAY && !overlay.DISPLAY) ||
    (!!overlay.DISPLAY && !overlay.XAUTHORITY) ||
    (!!overlay.WAYLAND_DISPLAY && !overlay.XDG_RUNTIME_DIR);
  if (needsProcDiscovery) {
    const before = {
      waylandDisplay: overlay.WAYLAND_DISPLAY,
      display: overlay.DISPLAY,
      runtimeDir: overlay.XDG_RUNTIME_DIR,
      xAuthority: overlay.XAUTHORITY,
    };
    const fromProc = discoverLinuxGuiEnvFromProc();
    if (fromProc) {
      if (!overlay.WAYLAND_DISPLAY && fromProc.waylandDisplay) overlay.WAYLAND_DISPLAY = fromProc.waylandDisplay;
      if (!overlay.DISPLAY && fromProc.display) overlay.DISPLAY = fromProc.display;
      if (!overlay.XDG_RUNTIME_DIR && fromProc.runtimeDir) overlay.XDG_RUNTIME_DIR = fromProc.runtimeDir;
      if (!overlay.XAUTHORITY && fromProc.xAuthority) overlay.XAUTHORITY = fromProc.xAuthority;
      const changed =
        before.waylandDisplay !== overlay.WAYLAND_DISPLAY ||
        before.display !== overlay.DISPLAY ||
        before.runtimeDir !== overlay.XDG_RUNTIME_DIR ||
        before.xAuthority !== overlay.XAUTHORITY;
      if (changed) {
        source = source === 'socket_discovery' ? 'socket+proc_discovery' : 'proc_discovery';
      }
    }
  }

  const env = { ...process.env };
  if (overlay.WAYLAND_DISPLAY) env.WAYLAND_DISPLAY = overlay.WAYLAND_DISPLAY;
  if (overlay.DISPLAY) env.DISPLAY = overlay.DISPLAY;
  if (overlay.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = overlay.XDG_RUNTIME_DIR;
  if (overlay.XAUTHORITY) env.XAUTHORITY = overlay.XAUTHORITY;

  return {
    env,
    source,
    waylandDisplay: overlay.WAYLAND_DISPLAY || null,
    display: overlay.DISPLAY || null,
    runtimeDir: overlay.XDG_RUNTIME_DIR || null,
    xAuthority: overlay.XAUTHORITY || null,
  };
}

function getLinuxClipboardToolCandidates(clipboardEnv = process.env) {
  if (process.platform === 'win32' || process.platform === 'darwin') return [];
  const preferred = [];
  if (clipboardEnv.WAYLAND_DISPLAY) preferred.push('wl-copy');
  if (clipboardEnv.DISPLAY) preferred.push('xclip');
  return preferred;
}

function assertLinuxClipboardAvailable() {
  const gui = getLinuxClipboardEnv();
  const candidates = getLinuxClipboardToolCandidates(gui.env);
  const available = candidates.filter(isLinuxClipboardToolInstalled);
  if (available.length > 0) {
    return {
      tools: available,
      env: gui.env,
      source: gui.source,
      waylandDisplay: gui.waylandDisplay,
      display: gui.display,
      runtimeDir: gui.runtimeDir,
      xAuthority: gui.xAuthority,
    };
  }
  if (!gui.waylandDisplay && !gui.display) {
    throw new Error('Linux image paste requires a graphical session. Could not detect WAYLAND_DISPLAY or DISPLAY (common in pm2/systemd). Set CLAUDE_REMOTE_DISPLAY or CLAUDE_REMOTE_WAYLAND_DISPLAY and retry.');
  }
  throw new Error('Linux image paste requires wl-copy or xclip on the server. Install a matching clipboard tool and try again.');
}

function clearActiveLinuxClipboardProc(reason = '') {
  if (!state.activeLinuxClipboardProc) return;
  const { child, tool } = state.activeLinuxClipboardProc;
  state.activeLinuxClipboardProc = null;
  try {
    child.kill('SIGTERM');
    log(`Linux clipboard process terminated (${tool}) reason=${reason || 'cleanup'}`);
  } catch (err) {
    log(`Linux clipboard process terminate error (${tool}): ${err.message}`);
  }
}

function formatLinuxClipboardEnvLog(info) {
  if (!info) return '';
  const parts = [];
  if (info.waylandDisplay) parts.push(`WAYLAND_DISPLAY=${info.waylandDisplay}`);
  if (info.display) parts.push(`DISPLAY=${info.display}`);
  if (info.runtimeDir) parts.push(`XDG_RUNTIME_DIR=${info.runtimeDir}`);
  if (info.xAuthority) parts.push(`XAUTHORITY=${info.xAuthority}`);
  return parts.length ? ` env[${parts.join(', ')}]` : '';
}

function spawnLinuxClipboardTool(tool, imageBuffer, type, clipboardEnv) {
  return new Promise((resolve, reject) => {
    const args = tool === 'xclip'
      ? ['-quiet', '-selection', 'clipboard', '-t', type, '-i']
      : ['--type', type];
    const child = spawn(tool, args, {
      detached: true,
      stdio: ['pipe', 'ignore', 'pipe'],
      env: clipboardEnv || process.env,
    });
    let settled = false;
    let stderr = '';
    let readyTimer = null;

    const settleFailure = (message) => {
      if (settled) return;
      settled = true;
      if (readyTimer) clearTimeout(readyTimer);
      if (child.exitCode == null && child.signalCode == null) {
        try { child.kill('SIGTERM'); } catch {}
      }
      reject(new Error(message));
    };

    const settleSuccess = (trackProcess = true) => {
      if (settled) return;
      settled = true;
      if (readyTimer) clearTimeout(readyTimer);
      if (trackProcess && child.exitCode == null && child.signalCode == null) {
        state.activeLinuxClipboardProc = { child, tool };
        child.unref();
      }
      resolve(tool);
    };

    child.on('error', (err) => {
      log(`Linux clipboard process error (${tool}): ${err.message}`);
      settleFailure(`Linux clipboard tool ${tool} failed: ${err.message}`);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 2000) stderr = stderr.slice(-2000);
    });
    child.on('exit', (code, signal) => {
      if (state.activeLinuxClipboardProc && state.activeLinuxClipboardProc.child === child) state.activeLinuxClipboardProc = null;
      const extra = stderr.trim() ? ` stderr=${JSON.stringify(stderr.trim())}` : '';
      log(`Linux clipboard process exited (${tool}) code=${code ?? 'null'} signal=${signal ?? 'null'}${extra}`);
      if (!settled) {
        if (tool === 'xclip' && code === 0 && !signal && !stderr.trim()) {
          log('Linux clipboard xclip exited cleanly without stderr; treating clipboard arm as successful');
          settleSuccess(false);
          return;
        }
        const detail = stderr.trim() || `exit code ${code ?? 'null'} signal ${signal ?? 'null'}`;
        settleFailure(`Linux clipboard tool ${tool} exited before paste: ${detail}`);
      }
    });
    child.stdin.on('error', (err) => {
      if (err.code === 'EPIPE') {
        settleFailure(`Linux clipboard tool ${tool} closed its input early`);
        return;
      }
      log(`Linux clipboard stdin error (${tool}): ${err.message}`);
      settleFailure(`Linux clipboard tool ${tool} stdin failed: ${err.message}`);
    });

    child.stdin.end(imageBuffer);
    log(`Linux clipboard process started (${tool}) pid=${child.pid ?? 'null'} type=${type} bytes=${imageBuffer.length}`);
    readyTimer = setTimeout(() => settleSuccess(), LINUX_CLIPBOARD_READY_GRACE_MS);
  });
}

async function startLinuxClipboardImage(tmpFile, mediaType, clipboardInfo = null) {
  const type = String(mediaType || 'image/png').toLowerCase();
  const imageBuffer = fs.readFileSync(tmpFile);
  const resolved = clipboardInfo || assertLinuxClipboardAvailable();
  const availableTools = resolved.tools;
  clearActiveLinuxClipboardProc('replace');

  let lastErr = null;
  for (const tool of availableTools) {
    try {
      return await spawnLinuxClipboardTool(tool, imageBuffer, type, resolved.env);
    } catch (err) {
      lastErr = err;
      log(`Linux clipboard arm failed (${tool}): ${err.message}`);
    }
  }

  throw lastErr || new Error('Linux clipboard could not be initialized');
}

// ============================================================
//  Image Upload Handlers
// ============================================================
async function handlePreparedImageUpload({ tmpFile, mediaType, text, logLabel = '', onCleanup = null }) {
  if (!state.claudeProc) throw new Error('Claude not running');
  if (!tmpFile || !fs.existsSync(tmpFile)) throw new Error('Prepared image file missing');

  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const isLinux = !isWin && !isMac;
  try {
    const stat = fs.statSync(tmpFile);
    log(`Image ready: ${logLabel || path.basename(tmpFile)} (${stat.size} bytes)`);
    if (isLinux) {
      const linuxPrompt = buildLinuxImagePrompt(text, tmpFile);
      await new Promise((resolve, reject) => {
        if (!state.claudeProc) {
          reject(new Error('Claude stopped before Linux image submit'));
          return;
        }
        state.claudeProc.write(linuxPrompt);
        setTimeout(() => {
          if (!state.claudeProc) {
            reject(new Error('Claude stopped before Linux image submit'));
            return;
          }
          state.claudeProc.write('\r');
          log(`Sent Linux image prompt via @ref: "${linuxPrompt.substring(0, 120)}"`);
          setTimeout(() => {
            if (onCleanup) onCleanup();
            else {
              try { fs.unlinkSync(tmpFile); } catch {}
            }
          }, LINUX_AT_IMAGE_CLEANUP_DELAY_MS);
          resolve();
        }, LINUX_AT_PROMPT_SUBMIT_DELAY_MS);
      });
      return;
    }

    if (isWin) {
      const psCmd = `Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; $img = [System.Drawing.Image]::FromFile('${tmpFile.replace(/'/g, "''")}'); [System.Windows.Forms.Clipboard]::SetImage($img); $img.Dispose()`;
      execSync(`powershell -NoProfile -STA -Command "${psCmd}"`, { timeout: 10000 });
    } else if (isMac) {
      execSync(`osascript -e 'set the clipboard to (read POSIX file "${tmpFile}" as \u00ABclass PNGf\u00BB)'`, { timeout: 10000 });
    }
    log('Clipboard set with image');

    const pasteDelayMs = isWin || isMac ? 0 : 150;
    await new Promise((resolve, reject) => {
      setTimeout(() => {
        if (!state.claudeProc) {
          reject(new Error('Claude stopped before image paste'));
          return;
        }
        if (isWin) state.claudeProc.write('\x1bv');
        else state.claudeProc.write('\x16');
        log('Sent image paste keypress to PTY');

        setTimeout(() => {
          if (!state.claudeProc) {
            reject(new Error('Claude stopped before image prompt'));
            return;
          }
          const trimmedText = (text || '').trim();
          if (trimmedText) state.claudeProc.write(trimmedText);

          setTimeout(() => {
            if (!state.claudeProc) {
              reject(new Error('Claude stopped before image submit'));
              return;
            }
            state.claudeProc.write('\r');
            log('Sent Enter after image paste' + (trimmedText ? ` + text: "${trimmedText.substring(0, 60)}"` : ''));

            setTimeout(() => {
              if (onCleanup) onCleanup();
              else {
                try { fs.unlinkSync(tmpFile); } catch {}
              }
            }, 5000);
            resolve();
          }, 150);
        }, 1000);
      }, pasteDelayMs);
    });
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
  if (!state.claudeProc) {
    log('Image upload ignored: Claude not running');
    return;
  }
  if (!msg.base64) {
    log('Image upload ignored: no base64 data');
    return;
  }
  let tmpFile = null;

  try {
    const buf = Buffer.from(msg.base64, 'base64');
    tmpFile = createTempImageFile(buf, msg.mediaType, `legacy_${Date.now()}`);
    log(`Image saved: ${tmpFile} (${buf.length} bytes)`);
    handlePreparedImageUpload({
      tmpFile,
      mediaType: msg.mediaType,
      text: msg.text || '',
    }).then(() => {
      setTurnState('running', { reason: 'legacy_image_upload' });
    }).catch((err) => {
      log(`Image upload error: ${err.message}`);
    });
  } catch (err) {
    log(`Image upload error: ${err.message}`);
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

function startUploadCleanup() {
  setInterval(() => {
    const now = Date.now();
    for (const [uploadId, upload] of state.pendingImageUploads) {
      if ((upload.updatedAt || 0) < (now - IMAGE_UPLOAD_TTL_MS)) {
        cleanupImageUpload(uploadId);
      }
    }
  }, 60 * 1000).unref();
}

module.exports = {
  createTempImageFile,
  cleanupImageUpload,
  cleanupClientUploads,
  sendUploadStatus,
  handlePreparedImageUpload,
  handleImageUpload,
  startUploadCleanup,
  clearActiveLinuxClipboardProc,
};
