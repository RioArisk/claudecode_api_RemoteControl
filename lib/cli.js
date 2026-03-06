'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { TOKEN_FILE } = require('./state');

// --- CLI argument parsing ---
const BLOCKED_FLAGS = new Set([
  '--print', '-p',
  '--output-format',
  '--input-format',
  '--include-partial-messages',
  '--json-schema',
  '--no-session-persistence',
  '--max-budget-usd',
  '--max-turns',
  '--fallback-model',
  '--permission-prompt-tool',
  '--version', '-v',
  '--help', '-h',
  '--init-only',
  '--maintenance',
  '--token',
  '--no-auth',
]);

const FLAGS_WITH_VALUE = new Set([
  '--resume', '-r', '--session-id', '--from-pr', '--model',
  '--system-prompt', '--system-prompt-file',
  '--append-system-prompt', '--append-system-prompt-file',
  '--permission-mode', '--add-dir', '--worktree', '-w',
  '--mcp-config', '--settings', '--setting-sources',
  '--agent', '--agents', '--teammate-mode',
  '--allowedTools', '--disallowedTools', '--tools',
  '--betas', '--debug', '--plugin-dir',
  '--output-format', '--input-format', '--json-schema',
  '--max-budget-usd', '--max-turns', '--fallback-model',
  '--permission-prompt-tool',
  '--token',
]);

function parseCliArgs(argv) {
  const rawArgs = argv.slice(2);
  let cwd = null;
  const claudeArgs = [];
  const blocked = [];
  let token = null;
  let noAuth = false;

  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];

    if (arg === '--') {
      claudeArgs.push(...rawArgs.slice(i + 1));
      break;
    }

    if (!arg.startsWith('-')) {
      if (!cwd) {
        cwd = arg;
      } else {
        claudeArgs.push(arg);
      }
      i++;
      continue;
    }

    const eqIdx = arg.indexOf('=');
    const flagName = eqIdx > 0 ? arg.substring(0, eqIdx) : arg;

    if (flagName === '--token') {
      if (eqIdx > 0) {
        token = arg.substring(eqIdx + 1);
      } else if (i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('-')) {
        i++;
        token = rawArgs[i];
      } else {
        token = '';
      }
      i++;
      continue;
    }
    if (flagName === '--no-auth') {
      noAuth = true;
      i++;
      continue;
    }

    if (BLOCKED_FLAGS.has(flagName)) {
      blocked.push(flagName);
      if (eqIdx > 0) {
        // --flag=value, already consumed
      } else if (FLAGS_WITH_VALUE.has(flagName) && i + 1 < rawArgs.length) {
        i++;
      }
      i++;
      continue;
    }

    claudeArgs.push(arg);
    if (eqIdx < 0 && FLAGS_WITH_VALUE.has(flagName) && i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith('-')) {
      i++;
      claudeArgs.push(rawArgs[i]);
    }
    i++;
  }

  return { cwd: cwd || process.cwd(), claudeArgs, blocked, token, noAuth };
}

// --- Auth token resolution ---
const AUTH_TOKEN_ENV_VAR = 'CLAUDE_REMOTE_TOKEN';
const LEGACY_AUTH_TOKEN_ENV_VAR = 'TOKEN';

function resolveAuthToken(cliToken, authDisabled) {
  if (authDisabled) return null;
  if (cliToken) return cliToken;
  if (process.env[AUTH_TOKEN_ENV_VAR]) return process.env[AUTH_TOKEN_ENV_VAR];
  try {
    const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch {}
  const generated = crypto.randomBytes(24).toString('base64url');
  try { fs.writeFileSync(TOKEN_FILE, generated + '\n', { mode: 0o600 }); } catch {}
  return generated;
}

function initConfig() {
  const parsed = parseCliArgs(process.argv);
  const authDisabled = parsed.noAuth || process.env.NO_AUTH === '1';
  const authToken = resolveAuthToken(parsed.token, authDisabled);
  const unusedLegacyTokenEnv = !!process.env[LEGACY_AUTH_TOKEN_ENV_VAR] && !process.env[AUTH_TOKEN_ENV_VAR];

  return {
    PORT: parseInt(process.env.PORT || '3100', 10),
    CWD: parsed.cwd,
    AUTH_TOKEN: authToken,
    AUTH_DISABLED: authDisabled,
    ENABLE_WEB: process.env.ENABLE_WEB === '1',
    CLAUDE_EXTRA_ARGS: parsed.claudeArgs,
    DEBUG_TTY_INPUT: process.env.CLAUDE_REMOTE_DEBUG_TTY_INPUT === '1',
    blockedArgs: parsed.blocked,
    unusedLegacyTokenEnv,
    LEGACY_AUTH_TOKEN_ENV_VAR,
    AUTH_TOKEN_ENV_VAR,
  };
}

module.exports = {
  parseCliArgs,
  resolveAuthToken,
  initConfig,
};
