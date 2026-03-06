// ============================================================
//  Constants
// ============================================================
export const STORAGE_KEY = 'claude_remote_servers';
export const LAST_KEY = 'claude_remote_last';
export const SERVERS_MAX = 20;
export const HUB_PROBE_INTERVAL_MS = 15000;
export const HUB_PROBE_TIMEOUT_MS = 3000;
export const HUB_PROBE_FAST_RETRY_MS = 1200;
export const HUB_PROBE_FAILS_TO_OFFLINE = 2;
export const CHAT_CACHE_DB = 'claude_remote_chat_cache';
export const CHAT_CACHE_STORE = 'sessions';
export const CHAT_CACHE_MAX_SESSIONS = 8;
export const CHAT_CACHE_MAX_TOTAL_BYTES = 12 * 1024 * 1024;
export const CHAT_CACHE_MAX_SESSION_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const IMAGE_CHUNK_BYTES = 96 * 1024;
export const WS_CLOSE_AUTH_FAILED = 4001;
export const WS_CLOSE_AUTH_TIMEOUT = 4002;
export const WS_CLOSE_REASON_AUTH_FAILED = 'auth_failed';
export const WS_CLOSE_REASON_AUTH_TIMEOUT = 'auth_timeout';
export const FOREGROUND_PROBE_TIMEOUT_MS = 2000;
export const FOREGROUND_RECOVER_DEBOUNCE_MS = 1200;
export const TODO_AUTO_CLEAR_DELAY_MS = 1800;
export const CLIENT_INSTANCE_KEY = 'claude_remote_client_instance_id';

export const COMMANDS = [
  { name: '/model', desc: 'Switch model', icon: '\u2699' },
  { name: '/cost', desc: 'Show token costs', icon: '$' },
  { name: '/compact', desc: 'Compact context', icon: '\u229E' },
  { name: '/clear', desc: 'Clear conversation', icon: '\u2715' },
  { name: '/help', desc: 'Show help', icon: '?' },
];

export const MODELS = [
  { num: '1', id: 'default', label: 'Default (Sonnet 4.6)', desc: 'Recommended' },
  { num: '2', id: 'sonnet-1m', label: 'Sonnet (1M context)', desc: 'Long sessions' },
  { num: '3', id: 'opus', label: 'Opus', desc: 'Most capable' },
  { num: '4', id: 'opus-1m', label: 'Opus (1M context)', desc: 'Long sessions' },
  { num: '5', id: 'haiku', label: 'Haiku', desc: 'Fast answers' },
];

export const PLAN_OPTIONS = [
  { num: '1', label: 'Yes, clear context and auto-accept edits', desc: 'Clear context + shift+tab' },
  { num: '2', label: 'Yes, auto-accept edits', desc: 'Auto-accept edits mode' },
  { num: '3', label: 'Yes, manually approve edits', desc: 'Review each edit' },
];

export const JUNK_PATTERNS = [
  /^Caveat:/i,
  /^<local-command/,
  /^<command-name>/,
  /^<command-message>/,
  /^<command-args>/,
  /^<local-command-stdout>/,
  /^<\/local-command/,
];

export const HIDDEN_STEP_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'AskUserQuestion', 'ExitPlanMode']);
