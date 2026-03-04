'use strict';

const os = require('os');
const { state, LOG_FILE } = require('./lib/state');
const { initConfig } = require('./lib/cli');
const { log } = require('./lib/logger');
const { createHttpServer } = require('./lib/http-server');
const { setupWebSocketServer } = require('./lib/ws-server');
const { spawnClaude } = require('./lib/pty-manager');
const { setupHooks } = require('./lib/hooks');
const { startUploadCleanup } = require('./lib/image-upload');

// --- Initialize config from CLI args + env ---
const config = initConfig();
state.PORT = config.PORT;
state.CWD = config.CWD;
state.AUTH_TOKEN = config.AUTH_TOKEN;
state.AUTH_DISABLED = config.AUTH_DISABLED;
state.CLAUDE_EXTRA_ARGS = config.CLAUDE_EXTRA_ARGS;
state.DEBUG_TTY_INPUT = config.DEBUG_TTY_INPUT;

// --- Create servers ---
const server = createHttpServer();
setupWebSocketServer(server);

// --- Start periodic cleanup ---
startUploadCleanup();

// --- Listen ---
server.listen(state.PORT, '0.0.0.0', () => {
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
  const local = `http://localhost:${state.PORT}`;
  const lan = `http://${lanIp}:${state.PORT}`;

  let banner = `
  Claude Remote Control Bridge
  ─────────────────────────────
  Local:  ${local}
  LAN:    ${lan}
  CWD:    ${state.CWD}
  Log:    ${LOG_FILE}
`;
  if (config.AUTH_DISABLED) {
    banner += `  Auth:   DISABLED (no authentication)\n`;
  } else {
    banner += `  Token:  ${config.AUTH_TOKEN}\n`;
  }
  if (config.unusedLegacyTokenEnv) {
    banner += `  Note:   Ignoring legacy ${config.LEGACY_AUTH_TOKEN_ENV_VAR}; use ${config.AUTH_TOKEN_ENV_VAR} instead\n`;
  }
  if (config.CLAUDE_EXTRA_ARGS.length > 0) {
    banner += `  Args:   claude ${config.CLAUDE_EXTRA_ARGS.join(' ')}\n`;
  }
  if (config.blockedArgs.length > 0) {
    banner += `  Blocked: ${config.blockedArgs.join(', ')} (incompatible with bridge)\n`;
  }
  banner += `
  Phone:  ${lan}
  ─────────────────────────────

`;
  process.stdout.write(banner);
  setupHooks();
  spawnClaude();
});
