'use strict';
// Wangshi (往事) MCP server: newline-delimited JSON-RPC over stdio, zero dependencies.
// Everything stays on this computer: no network access anywhere in this extension.
const readline = require('readline');
const { TOOLS, Wangshi } = require('./tools');
const msg = require('./lib/messages');

const SERVER_INFO = { name: 'wangshi', version: require('../package.json').version };
const FALLBACK_PROTOCOL = '2025-06-18';
const GENERIC_ERROR = '往事这边出了点问题，没能完成这次操作。请稍后再试；如果一直这样，请通过 GitHub Issue 告诉我们。';

const app = new Wangshi();
const handlers = new Map(TOOLS.map((t) => [t.name, (args) => app[t.name](args || {})]));

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function callTool(params) {
  const name = params && params.name;
  const handler = handlers.get(name);
  if (!handler) return { isError: true, content: [{ type: 'text', text: `往事没有叫"${name}"的工具。` }] };
  try {
    const text = await handler(params.arguments);
    return { content: [{ type: 'text', text }] };
  } catch (e) {
    process.stderr.write(`[wangshi] ${name} failed: ${e && e.stack}\n`);
    if (e && e.code === 'no_fts5') return { isError: true, content: [{ type: 'text', text: msg.noFts5() }] };
    return { isError: true, content: [{ type: 'text', text: GENERIC_ERROR }] };
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notifications need no answer
  switch (method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: (params && params.protocolVersion) || FALLBACK_PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      });
    case 'ping':
      return send({ jsonrpc: '2.0', id, result: {} });
    case 'tools/list':
      return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    case 'tools/call':
      return send({ jsonrpc: '2.0', id, result: await callTool(params) });
    default:
      return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  handle(msg).catch((e) => {
    process.stderr.write(`[wangshi] ${e && e.stack}\n`);
    send({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: 'Internal error' } });
  });
});
rl.on('close', () => {
  app.close();
  process.exit(0);
});
