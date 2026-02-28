#!/usr/bin/env node
// Bridge stop hook — notifies WebUI that Claude's turn has ended.
// Fire-and-forget: POST stdin JSON to bridge server, don't wait for response.

const http = require('http');

if (!process.env.BRIDGE_PORT) process.exit(0);

const PORT = process.env.BRIDGE_PORT;

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
    path: '/hook/stop',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, () => {
    // Fire-and-forget — don't care about response
    process.exit(0);
  });

  req.on('error', () => process.exit(0));
  req.setTimeout(10000, () => { req.destroy(); process.exit(0); });
  req.write(body);
  req.end();
});
