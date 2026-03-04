'use strict';

const assert = require('assert');
const fs = require('fs');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log('  \u2713 ' + name);
    passed++;
  } catch (e) {
    console.log('  \u2717 ' + name);
    console.log('    ' + e.message);
    failed++;
  }
}

// ============================================================
console.log('\n=== lib/state.js ===');
const { state, ALWAYS_AUTO_ALLOW, PARTIAL_AUTO_ALLOW, EVENT_BUFFER_MAX } = require('../lib/state');

test('state object exists with default values', () => {
  assert.strictEqual(state.claudeProc, null);
  assert.strictEqual(state.currentSessionId, null);
  assert.deepStrictEqual(state.eventBuffer, []);
  assert.strictEqual(state.approvalMode, 'default');
  assert.strictEqual(state.turnState.phase, 'idle');
});

test('state is mutable (shared reference)', () => {
  state.PORT = 9999;
  assert.strictEqual(state.PORT, 9999);
  state.PORT = 3100;
});

test('ALWAYS_AUTO_ALLOW has expected tools', () => {
  assert.ok(ALWAYS_AUTO_ALLOW.has('TaskCreate'));
  assert.ok(ALWAYS_AUTO_ALLOW.has('TaskUpdate'));
  assert.ok(!ALWAYS_AUTO_ALLOW.has('Bash'));
});

test('PARTIAL_AUTO_ALLOW has expected tools', () => {
  assert.ok(PARTIAL_AUTO_ALLOW.has('Read'));
  assert.ok(PARTIAL_AUTO_ALLOW.has('Edit'));
  assert.ok(!PARTIAL_AUTO_ALLOW.has('Bash'));
});

test('EVENT_BUFFER_MAX is 5000', () => {
  assert.strictEqual(EVENT_BUFFER_MAX, 5000);
});

// ============================================================
console.log('\n=== lib/cli.js ===');
const { parseCliArgs, initConfig } = require('../lib/cli');

test('parseCliArgs: no args returns cwd', () => {
  const result = parseCliArgs(['node', 'server.js']);
  assert.strictEqual(result.cwd, process.cwd());
  assert.deepStrictEqual(result.claudeArgs, []);
  assert.deepStrictEqual(result.blocked, []);
});

test('parseCliArgs: positional CWD', () => {
  const result = parseCliArgs(['node', 'server.js', '/tmp/mydir']);
  assert.strictEqual(result.cwd, '/tmp/mydir');
});

test('parseCliArgs: blocked flags filtered', () => {
  const result = parseCliArgs(['node', 'server.js', '--print', '--model', 'opus']);
  assert.deepStrictEqual(result.blocked, ['--print']);
  assert.deepStrictEqual(result.claudeArgs, ['--model', 'opus']);
});

test('parseCliArgs: --token extracted', () => {
  const result = parseCliArgs(['node', 'server.js', '--token', 'mytoken123']);
  assert.strictEqual(result.token, 'mytoken123');
  assert.deepStrictEqual(result.claudeArgs, []);
});

test('parseCliArgs: --token=value syntax', () => {
  const result = parseCliArgs(['node', 'server.js', '--token=abc']);
  assert.strictEqual(result.token, 'abc');
});

test('parseCliArgs: --no-auth flag', () => {
  const result = parseCliArgs(['node', 'server.js', '--no-auth']);
  assert.strictEqual(result.noAuth, true);
});

test('parseCliArgs: -- separator passes everything', () => {
  const result = parseCliArgs(['node', 'server.js', '--', '--print', '--help']);
  assert.deepStrictEqual(result.claudeArgs, ['--print', '--help']);
  assert.deepStrictEqual(result.blocked, []);
});

test('parseCliArgs: --resume with value passed through', () => {
  const result = parseCliArgs(['node', 'server.js', '--resume', 'abc-123']);
  assert.deepStrictEqual(result.claudeArgs, ['--resume', 'abc-123']);
});

test('parseCliArgs: blocked flag with value skips both', () => {
  const result = parseCliArgs(['node', 'server.js', '--output-format', 'json', '--model', 'opus']);
  assert.deepStrictEqual(result.blocked, ['--output-format']);
  assert.deepStrictEqual(result.claudeArgs, ['--model', 'opus']);
});

test('initConfig returns complete config', () => {
  const config = initConfig();
  assert.ok('PORT' in config);
  assert.ok('CWD' in config);
  assert.ok('AUTH_TOKEN' in config);
  assert.ok('AUTH_DISABLED' in config);
  assert.ok('CLAUDE_EXTRA_ARGS' in config);
  assert.ok('blockedArgs' in config);
  assert.ok('unusedLegacyTokenEnv' in config);
});

// ============================================================
console.log('\n=== lib/logger.js ===');
const {
  log, wsLabel, isAuthenticatedClient, setTurnState,
  getTurnStatePayload, latestEventSeq, emitInterrupt,
} = require('../lib/logger');

test('wsLabel formats correctly', () => {
  assert.strictEqual(wsLabel({ _bridgeId: 5, _clientInstanceId: 'abc' }), 'ws#5 client=abc');
});

test('wsLabel handles null/empty', () => {
  assert.strictEqual(wsLabel(null), 'ws#?');
  assert.strictEqual(wsLabel({}), 'ws#?');
});

test('isAuthenticatedClient: null -> false', () => {
  assert.strictEqual(isAuthenticatedClient(null), false);
});

test('isAuthenticatedClient: unauthenticated -> false', () => {
  assert.strictEqual(isAuthenticatedClient({ readyState: 1, _authenticated: false }), false);
});

test('setTurnState changes phase correctly', () => {
  state.currentSessionId = 'test-session';
  const changed = setTurnState('running', { reason: 'test' });
  assert.strictEqual(changed, true);
  assert.strictEqual(state.turnState.phase, 'running');
  assert.strictEqual(state.turnState.reason, 'test');
  assert.strictEqual(state.turnState.sessionId, 'test-session');
  assert.ok(state.turnState.version > 0);
});

test('setTurnState normalizes unknown phase to idle', () => {
  setTurnState('whatever', { reason: 'normalize' });
  assert.strictEqual(state.turnState.phase, 'idle');
});

test('setTurnState returns false when no change', () => {
  setTurnState('idle', { reason: 'first' });
  const changed = setTurnState('idle', { reason: 'second' });
  assert.strictEqual(changed, false);
});

test('setTurnState force=true always updates', () => {
  setTurnState('idle', { reason: 'base' });
  const v1 = state.turnState.version;
  const changed = setTurnState('idle', { reason: 'forced', force: true });
  assert.strictEqual(changed, true);
  assert.ok(state.turnState.version > v1);
});

test('getTurnStatePayload has correct shape', () => {
  const payload = getTurnStatePayload();
  assert.strictEqual(payload.type, 'turn_state');
  assert.ok('phase' in payload);
  assert.ok('sessionId' in payload);
  assert.ok('version' in payload);
  assert.ok('updatedAt' in payload);
  assert.ok('reason' in payload);
});

test('latestEventSeq: empty buffer -> 0', () => {
  state.eventBuffer = [];
  assert.strictEqual(latestEventSeq(), 0);
});

test('latestEventSeq: returns last seq', () => {
  state.eventBuffer = [{ seq: 1 }, { seq: 5 }, { seq: 10 }];
  assert.strictEqual(latestEventSeq(), 10);
  state.eventBuffer = [];
});

test('emitInterrupt adds event and sets idle', () => {
  state.eventBuffer = [];
  state.eventSeq = 0;
  setTurnState('running', { reason: 'pre-interrupt', force: true });
  emitInterrupt('test');
  assert.strictEqual(state.eventBuffer.length, 1);
  assert.strictEqual(state.eventBuffer[0].event.type, 'interrupt');
  assert.strictEqual(state.eventBuffer[0].event.source, 'test');
  assert.ok(state.eventBuffer[0].event.uuid);
  assert.ok(state.eventBuffer[0].event.timestamp > 0);
  assert.strictEqual(state.turnState.phase, 'idle');
  state.eventBuffer = [];
  state.eventSeq = 0;
});

// ============================================================
console.log('\n=== lib/transcript.js ===');
const {
  normalizeFsPath, getProjectSlug, extractSlashCommand,
  flattenUserContent, isNonAiUserEvent, extractSessionPrompt,
  hasConversationEvent,
} = require('../lib/transcript');

test('getProjectSlug replaces non-alphanumeric', () => {
  assert.strictEqual(getProjectSlug('/home/user/my-project'), '-home-user-my-project');
  assert.strictEqual(getProjectSlug('C:\\Users\\test'), 'C--Users-test');
});

test('normalizeFsPath resolves path', () => {
  const result = normalizeFsPath('/tmp/test');
  assert.ok(typeof result === 'string');
  assert.ok(result.length > 0);
});

test('extractSlashCommand: /clear', () => {
  assert.strictEqual(extractSlashCommand('/clear'), '/clear');
});

test('extractSlashCommand: /model opus -> /model', () => {
  assert.strictEqual(extractSlashCommand('/model opus'), '/model');
});

test('extractSlashCommand: normal text -> empty', () => {
  assert.strictEqual(extractSlashCommand('hello world'), '');
});

test('extractSlashCommand: command tag', () => {
  assert.strictEqual(extractSlashCommand('<command-name>/compact</command-name>'), '/compact');
});

test('extractSlashCommand: empty/null -> empty', () => {
  assert.strictEqual(extractSlashCommand(''), '');
  assert.strictEqual(extractSlashCommand(null), '');
});

test('flattenUserContent: string passthrough', () => {
  assert.strictEqual(flattenUserContent('hello'), 'hello');
});

test('flattenUserContent: array of blocks', () => {
  assert.strictEqual(flattenUserContent([{ text: 'hello' }, { text: 'world' }]), 'hello\nworld');
});

test('flattenUserContent: null -> empty', () => {
  assert.strictEqual(flattenUserContent(null), '');
});

test('flattenUserContent: content field in blocks', () => {
  assert.strictEqual(flattenUserContent([{ content: 'abc' }]), 'abc');
});

test('hasConversationEvent: user/assistant', () => {
  assert.ok(hasConversationEvent({ type: 'user' }));
  assert.ok(hasConversationEvent({ type: 'assistant' }));
  assert.ok(hasConversationEvent({ message: { role: 'user' } }));
  assert.ok(!hasConversationEvent({ type: 'system' }));
  assert.ok(!hasConversationEvent(null));
  assert.ok(!hasConversationEvent({}));
});

test('isNonAiUserEvent: meta/compact/interrupt', () => {
  assert.ok(isNonAiUserEvent({ isMeta: true }, ''));
  assert.ok(isNonAiUserEvent({ isCompactSummary: true }, ''));
  assert.ok(isNonAiUserEvent({ isVisibleInTranscriptOnly: true }, ''));
  assert.ok(isNonAiUserEvent({}, '[Request interrupted by user]'));
  assert.ok(!isNonAiUserEvent({}, 'hello world'));
});

test('isNonAiUserEvent: local-command tags', () => {
  assert.ok(isNonAiUserEvent({}, '<local-command-stdout>output</local-command-stdout>'));
  assert.ok(isNonAiUserEvent({}, '<local-command-stderr>err</local-command-stderr>'));
});

test('extractSessionPrompt: normal user event', () => {
  assert.strictEqual(extractSessionPrompt({ type: 'user', message: { content: 'fix the bug' } }), 'fix the bug');
});

test('extractSessionPrompt: slash command -> empty', () => {
  assert.strictEqual(extractSessionPrompt({ type: 'user', message: { content: '/clear' } }), '');
});

test('extractSessionPrompt: non-user -> empty', () => {
  assert.strictEqual(extractSessionPrompt({ type: 'assistant' }), '');
  assert.strictEqual(extractSessionPrompt(null), '');
});

test('extractSessionPrompt: truncates at 120 chars', () => {
  const evt = { type: 'user', message: { content: 'a'.repeat(200) } };
  assert.strictEqual(extractSessionPrompt(evt).length, 120);
});

test('extractSessionPrompt: collapses whitespace', () => {
  const evt = { type: 'user', message: { content: 'hello   world\n\nfoo' } };
  assert.strictEqual(extractSessionPrompt(evt), 'hello world foo');
});

// ============================================================
console.log('\n=== lib/image-upload.js ===');
const { createTempImageFile, cleanupImageUpload, sendUploadStatus } = require('../lib/image-upload');

test('createTempImageFile: creates .png file', () => {
  const buf = Buffer.from('fake-png');
  const tmpFile = createTempImageFile(buf, 'image/png', 'test-png');
  assert.ok(fs.existsSync(tmpFile));
  assert.ok(tmpFile.endsWith('.png'));
  assert.deepStrictEqual(fs.readFileSync(tmpFile), buf);
  fs.unlinkSync(tmpFile);
});

test('createTempImageFile: creates .jpg for jpeg', () => {
  const buf = Buffer.from('fake-jpeg');
  const tmpFile = createTempImageFile(buf, 'image/jpeg', 'test-jpg');
  assert.ok(tmpFile.endsWith('.jpg'));
  fs.unlinkSync(tmpFile);
});

test('cleanupImageUpload: removes file and map entry', () => {
  const buf = Buffer.from('test');
  const tmpFile = createTempImageFile(buf, 'image/png', 'cleanup-test');
  state.pendingImageUploads.set('cleanup-test', { tmpFile });
  cleanupImageUpload('cleanup-test');
  assert.ok(!fs.existsSync(tmpFile));
  assert.ok(!state.pendingImageUploads.has('cleanup-test'));
});

test('cleanupImageUpload: non-existent is no-op', () => {
  cleanupImageUpload('non-existent'); // should not throw
});

test('sendUploadStatus: null ws is no-op', () => {
  sendUploadStatus(null, 'test', 'error'); // should not throw
});

// ============================================================
console.log('\n=== Cross-module integration ===');

test('state mutations visible across modules', () => {
  state.currentSessionId = 'integration-test';
  setTurnState('running', { reason: 'integration' });
  assert.strictEqual(state.turnState.sessionId, 'integration-test');
  assert.strictEqual(state.turnState.phase, 'running');
});

test('EVENT_BUFFER_MAX trimming logic', () => {
  state.eventBuffer = [];
  state.eventSeq = 0;
  for (let i = 0; i < 5010; i++) {
    state.eventBuffer.push({ seq: ++state.eventSeq, event: { type: 'test' } });
  }
  if (state.eventBuffer.length > EVENT_BUFFER_MAX) {
    state.eventBuffer = state.eventBuffer.slice(-Math.round(EVENT_BUFFER_MAX * 0.8));
  }
  assert.strictEqual(state.eventBuffer.length, 4000);
  assert.strictEqual(state.eventBuffer[0].seq, 1011); // 5010 - 4000 + 1
  state.eventBuffer = [];
  state.eventSeq = 0;
});

test('log function writes to file', () => {
  const { LOG_FILE } = require('../lib/state');
  const before = fs.readFileSync(LOG_FILE, 'utf8');
  log('test-marker-12345');
  const after = fs.readFileSync(LOG_FILE, 'utf8');
  assert.ok(after.includes('test-marker-12345'));
  assert.ok(after.length > before.length);
});

// ============================================================
console.log('\n\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');
console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
