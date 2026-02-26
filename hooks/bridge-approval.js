#!/usr/bin/env node
// Bridge approval hook — routes PreToolUse permission requests to WebUI.
// If bridge server is unreachable or no WebUI clients, falls back to
// normal terminal prompt (decision: "ask").

const http = require('http');
const PORT = process.env.BRIDGE_PORT || 3100;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
  let data;
  try { data = JSON.parse(input); } catch { process.exit(0); }

  const body = JSON.stringify(data);
  const req = http.request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/hook/pre-tool-use',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, res => {
    let resBody = '';
    res.on('data', d => (resBody += d));
    res.on('end', () => {
      try {
        const result = JSON.parse(resBody);
        const decision = result.decision || 'ask';
        const reason = result.reason || '';
        const out = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
          },
        };
        if (reason && decision === 'deny') {
          out.hookSpecificOutput.permissionDecisionReason = reason;
        }
        process.stdout.write(JSON.stringify(out));
      } catch {}
      process.exit(0);
    });
  });

  req.on('error', () => process.exit(0));   // bridge offline → ask
  req.setTimeout(120000, () => { req.destroy(); process.exit(0); });
  req.write(body);
  req.end();
});
