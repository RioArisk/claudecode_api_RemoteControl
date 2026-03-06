'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { state, ALWAYS_AUTO_ALLOW, PARTIAL_AUTO_ALLOW } = require('./state');
const { log, broadcast, isAuthenticatedClient, setTurnState, recomputeEffectiveApprovalMode } = require('./logger');
const { maybeAttachHookSession, markExpectingSwitch } = require('./transcript');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function createHttpServer() {
  return http.createServer((req, res) => {
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
        const effectiveApprovalMode = recomputeEffectiveApprovalMode('pre-tool-use');

        if (ALWAYS_AUTO_ALLOW.has(data.tool_name)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ decision: 'allow' }));
          log(`Permission auto-allowed (always): ${data.tool_name}`);
          return;
        }

        if (effectiveApprovalMode === 'all') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ decision: 'allow' }));
          log(`Permission auto-allowed (mode=all): ${data.tool_name}`);
          return;
        }
        if (effectiveApprovalMode === 'partial' && PARTIAL_AUTO_ALLOW.has(data.tool_name)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ decision: 'allow' }));
          log(`Permission auto-allowed (mode=partial): ${data.tool_name}`);
          return;
        }

        const clients = [...state.wss.clients].filter(isAuthenticatedClient);
        if (clients.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ decision: 'ask' }));
          return;
        }

        const id = String(++state.approvalSeq);
        log(`Permission #${id}: ${data.tool_name} → ${clients.length} WebUI client(s)`);

        broadcast({
          type: 'permission_request',
          id,
          toolName: data.tool_name,
          toolInput: data.tool_input,
          permissionMode: data.permission_mode,
        });

        const timer = setTimeout(() => {
          state.pendingApprovals.delete(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ decision: 'ask' }));
          log(`Permission #${id}: timeout → ask`);
          broadcast({
            type: 'permission_resolved',
            id,
            decision: 'ask',
            reason: 'timeout',
          });
        }, 90000);

        state.pendingApprovals.set(id, { res, timer });
      });
      return;
    }

    // --- API: Session start hook endpoint ---
    if (req.method === 'POST' && url === '/hook/session-start') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          log(`/hook/session-start received (source=${data.source || 'unknown'}, session_id=${data.session_id || 'none'})`);
          maybeAttachHookSession(data, 'session-start');
        } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      return;
    }

    // --- API: Session end hook endpoint ---
    if (req.method === 'POST' && url === '/hook/session-end') {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        let data = {};
        try { data = JSON.parse(body); } catch {}
        const reason = data.reason || 'unknown';
        log(`/hook/session-end received (reason=${reason})`);
        if (reason === 'clear') {
          markExpectingSwitch();
        }
        setTurnState('idle', { reason: `session-end:${reason}` });
        broadcast({ type: 'session_end', reason });
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
        setTurnState('idle', { reason: 'stop-hook' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
      return;
    }

    // --- Static files ---
    if (!state.ENABLE_WEB) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Web UI disabled. Start with ENABLE_WEB=1 to enable.');
      return;
    }
    const filePath = path.join(__dirname, '..', 'web', url === '/' ? 'index.html' : url);
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
}

module.exports = { createHttpServer };
