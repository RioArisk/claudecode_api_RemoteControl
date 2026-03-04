'use strict';

const fs = require('fs');
const path = require('path');
const { state } = require('./state');
const { log } = require('./logger');

function setupHooks() {
  const claudeDir = path.join(state.CWD, '.claude');
  if (!fs.existsSync(claudeDir)) fs.mkdirSync(claudeDir, { recursive: true });

  const settingsPath = path.join(claudeDir, 'settings.local.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}

  const hookScript = path.resolve(__dirname, '..', 'hooks', 'bridge-approval.js').replace(/\\/g, '/');
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

  // Merge bridge hook into Stop
  const stopScript = path.resolve(__dirname, '..', 'hooks', 'bridge-stop.js').replace(/\\/g, '/');
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

  // SessionStart
  const sessionStartScript = path.resolve(__dirname, '..', 'hooks', 'bridge-session-start.js').replace(/\\/g, '/');
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

  // SessionEnd
  const sessionEndScript = path.resolve(__dirname, '..', 'hooks', 'bridge-session-end.js').replace(/\\/g, '/');
  const sessionEndCmd = `node "${sessionEndScript}"`;
  const existingSessionEnd = settings.hooks.SessionEnd || [];
  const sessionEndBridgeIdx = existingSessionEnd.findIndex(e =>
    e.hooks?.some(h => h.command?.includes('bridge-session-end'))
  );
  const sessionEndEntry = {
    hooks: [{ type: 'command', command: sessionEndCmd, timeout: 10 }],
  };
  if (sessionEndBridgeIdx >= 0) {
    existingSessionEnd[sessionEndBridgeIdx] = sessionEndEntry;
  } else {
    existingSessionEnd.push(sessionEndEntry);
  }
  settings.hooks.SessionEnd = existingSessionEnd;

  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  log(`Hooks configured: ${settingsPath}`);
}

module.exports = { setupHooks };
