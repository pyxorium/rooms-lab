// dev/serve.mjs: the Rooms lab on this computer, `npm run dev` in C:\thunderbird-cafe\rooms-lab.
//
// Starts the real relay (relay/server.js, the same code Fly runs) at ws://127.0.0.1:8787/, letting in only
// this dev page, and serves the lab's files at http://127.0.0.1:5190/. Open http://127.0.0.1:5190/ in two
// windows (or two browsers) to try a room on one computer. Needs `npm install` once in relay\ (for `ws`).
//
// Only files under this folder's src\ and dev\ are served, and only to this computer.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRelayServer } from '../relay/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

export async function startDev({ port = 5190, relayPort = 8787, host = '127.0.0.1', quiet = false } = {}) {
  const files = http.createServer(async (req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = p === '/' ? 'dev/index.html' : p.replace(/^\/+/, '');
    const full = path.resolve(ROOT, rel);
    const inside = ['src', 'dev'].some((d) => full.startsWith(path.join(ROOT, d) + path.sep));
    if (req.method !== 'GET' || !inside || full.endsWith('.mjs')) { res.writeHead(404); res.end('not found'); return; }
    try {
      const body = await readFile(full);
      res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404); res.end('not found'); }
  });
  await new Promise((resolve) => files.listen(port, host, resolve));
  const actualPort = files.address().port;
  // The relay lets in this dev page only (its real address, once the port is known).
  const relay = createRelayServer({ port: relayPort, host, allowedOrigins: [`http://${host}:${actualPort}`], log: quiet ? () => {} : undefined });
  const actualRelayPort = await relay.listen();
  return {
    url: `http://${host}:${actualPort}/`,
    relayUrl: `ws://${host}:${actualRelayPort}/`,
    async close() { await relay.close(); await new Promise((r) => { files.close(() => r()); files.closeAllConnections?.(); }); },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const d = await startDev();
  console.log(`Rooms lab: ${d.url}  (relay ${d.relayUrl}). Open it in two windows. Ctrl+C stops.`);
  const stop = async () => { await d.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
