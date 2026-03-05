'use strict';

const path = require('path');
const os = require('os');

// --- Paths ---
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const CLAUDE_STATE_FILE = path.join(os.homedir(), '.claude.json');
const PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
const LOG_FILE = path.join(CLAUDE_HOME, 'bridge.log');
const TOKEN_FILE = path.join(os.homedir(), '.claude-remote-token');
const IMAGE_UPLOAD_DIR = os.tmpdir();

// --- Constants ---
const AUTH_HELLO_TIMEOUT_MS = 5000;
const WS_CLOSE_AUTH_FAILED = 4001;
const WS_CLOSE_AUTH_TIMEOUT = 4002;
const WS_CLOSE_REASON_AUTH_FAILED = 'auth_failed';
const WS_CLOSE_REASON_AUTH_TIMEOUT = 'auth_timeout';
const EVENT_BUFFER_MAX = 5000;
const LEGACY_REPLAY_DELAY_MS = 1500;
const IMAGE_UPLOAD_TTL_MS = 15 * 60 * 1000;
const LINUX_CLIPBOARD_READY_GRACE_MS = 400;
const LINUX_AT_PROMPT_SUBMIT_DELAY_MS = 450;
const LINUX_AT_IMAGE_CLEANUP_DELAY_MS = 10 * 60 * 1000;

// --- Auto-allow sets ---
const ALWAYS_AUTO_ALLOW = new Set(['TaskCreate', 'TaskUpdate']);
const PARTIAL_AUTO_ALLOW = new Set(['Read', 'Glob', 'Grep', 'Write', 'Edit']);

// --- TTY ---
const isTTY = process.stdin.isTTY && process.stdout.isTTY;

// --- Mutable shared state ---
const state = {
  // Config (set once at startup)
  PORT: 3100,
  CWD: process.cwd(),
  AUTH_TOKEN: null,
  AUTH_DISABLED: false,
  CLAUDE_EXTRA_ARGS: [],
  DEBUG_TTY_INPUT: false,

  // PTY
  claudeProc: null,

  // Transcript
  transcriptPath: null,
  currentSessionId: null,
  transcriptOffset: 0,
  eventBuffer: [],
  eventSeq: 0,
  tailTimer: null,
  tailRemainder: Buffer.alloc(0),
  tailCatchingUp: false,

  // Session switch
  switchWatcher: null,
  switchWatcherDelayTimer: null,
  expectingSwitch: false,
  expectingSwitchTimer: null,
  pendingSwitchTarget: null,
  pendingInitialClearTranscript: null,

  // Turn state
  turnStateVersion: 0,
  turnState: {
    phase: 'idle',
    sessionId: null,
    version: 0,
    updatedAt: Date.now(),
  },

  // WebSocket
  wss: null,
  nextWsId: 0,

  // Permission approval
  approvalSeq: 0,
  pendingApprovals: new Map(),
  pendingImageUploads: new Map(),
  approvalMode: 'default',
  turnApprovalFloorMode: '',

  // TTY forwarders
  ttyInputForwarderAttached: false,
  ttyInputHandler: null,
  ttyResizeHandler: null,

  // Linux clipboard
  activeLinuxClipboardProc: null,
  linuxImagePasteInFlight: false,
};

module.exports = {
  state,
  CLAUDE_HOME,
  CLAUDE_STATE_FILE,
  PROJECTS_DIR,
  LOG_FILE,
  TOKEN_FILE,
  IMAGE_UPLOAD_DIR,
  AUTH_HELLO_TIMEOUT_MS,
  WS_CLOSE_AUTH_FAILED,
  WS_CLOSE_AUTH_TIMEOUT,
  WS_CLOSE_REASON_AUTH_FAILED,
  WS_CLOSE_REASON_AUTH_TIMEOUT,
  EVENT_BUFFER_MAX,
  LEGACY_REPLAY_DELAY_MS,
  IMAGE_UPLOAD_TTL_MS,
  LINUX_CLIPBOARD_READY_GRACE_MS,
  LINUX_AT_PROMPT_SUBMIT_DELAY_MS,
  LINUX_AT_IMAGE_CLEANUP_DELAY_MS,
  ALWAYS_AUTO_ALLOW,
  PARTIAL_AUTO_ALLOW,
  isTTY,
};
