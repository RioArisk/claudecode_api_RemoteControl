#!/usr/bin/env node
// Bridge session-end hook — notifies WebUI that a Claude session has ended.
// Fire-and-forget: POST stdin JSON to bridge server, don't wait for response.

const http = require('http');

if (!process.env.BRIDGE_PORT) process.exit(0);

const PORT = process.env.BRIDGE_PORT;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
  const body = input || '{}';
  const req = http.request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/hook/session-end',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  }, () => {
    process.exit(0);
  });

  req.on('error', () => process.exit(0));
  req.setTimeout(10000, () => { req.destroy(); process.exit(0); });
  req.write(body);
  req.end();
});
