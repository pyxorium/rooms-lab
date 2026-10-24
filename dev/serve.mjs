// dev/serve.mjs: the Rooms lab on this computer, `npm run dev` in C:\thunderbird-cafe\rooms-lab.
//
// Starts the real relay (relay/server.js, the same code Fly runs) at ws://127.0.0.1:8787/, letting in only
// this dev page, and serves the lab's files at http://127.0.0.1:5190/. Open http://127.0.0.1:5190/ in two
// windows (or two browsers) to try a room on one computer. Needs `npm install` once in relay\ (for `ws`).
//
// Tiles opened for everyone need the official tile loader: after `npm install` in this folder (it adds
// @dasl/tile-loader and esbuild, for development only), dev/tile-host.js is bundled at start and served as
// /dev/tile-host.bundle.js. Without them the page still runs, and its strip says it can't open tiles.
//
// Only files under this folder's src\, dev\ and tiles\ are served, and only to this computer. The house tile
// (tiles\house\) runs in a sealed frame (no origin of its own), so its files are served to any page
// (Access-Control-Allow-Origin: *), as the tile loading server does for tiles.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createRelayServer } from '../relay/server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

// The tile loader for the dev page, bundled once (null when the packages aren't installed).
export async function bundleTileHost() {
  try {
    const require = createRequire(path.join(ROOT, 'package.json'));
    require.resolve('@dasl/tile-loader');
    const esbuild = await import(pathToFileURL(require.resolve('esbuild')).href);
    const out = await esbuild.build({ entryPoints: [path.join(ROOT, 'dev', 'tile-host.js')], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' });
    return out.outputFiles[0].text;
  } catch { return null; }
}

export async function startDev({ port = 5190, relayPort = 8787, host = '127.0.0.1', quiet = false, tileHost = undefined } = {}) {
  const tileHostJs = tileHost === undefined ? await bundleTileHost() : tileHost;
  const files = http.createServer(async (req, res) => {
    const p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/dev/tile-host.bundle.js') {
      // Without the packages: a module saying so (makeTileHost is null), so the page starts without errors.
      res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
      res.end(tileHostJs || '// No tile loader: run npm install in C:\\thunderbird-cafe\\rooms-lab\nexport const makeTileHost = null;\n');
      return;
    }
    const rel = p === '/' ? 'dev/index.html' : p.replace(/^\/+/, '');
    const full = path.resolve(ROOT, rel);
    const inside = ['src', 'dev', 'tiles'].some((d) => full.startsWith(path.join(ROOT, d) + path.sep));
    const tile = full.startsWith(path.join(ROOT, 'tiles') + path.sep);
    if (req.method !== 'GET' || !inside || full.endsWith('.mjs')) { res.writeHead(404); res.end('not found'); return; }
    try {
      const body = await readFile(full);
      res.writeHead(200, { 'content-type': TYPES[path.extname(full)] || 'application/octet-stream', 'cache-control': 'no-store', ...(tile ? { 'access-control-allow-origin': '*' } : {}) });
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
    tileLoader: !!tileHostJs,
    relayUrl: `ws://${host}:${actualRelayPort}/`,
    async close() { await relay.close(); await new Promise((r) => { files.close(() => r()); files.closeAllConnections?.(); }); },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const d = await startDev();
  console.log(`Rooms lab: ${d.url}  (relay ${d.relayUrl}). Open it in two windows. Ctrl+C stops.`);
  if (!d.tileLoader) console.log('No tile loader yet: run npm install in this folder to open tiles for everyone on this page.');
  const stop = async () => { await d.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
