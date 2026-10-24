// The Rooms lab relay on Fly.io (thunderbird-rooms-relay, wss://relay.rooms.thunderbird.cafe/): the network
// around rooms.js. Modelled on Daisy's relay (C:\thunderbird-cafe\daisy-relay\server.js), without the lounge
// and without sign-in (the lab uses a room code and typed names; rooms-lab-plan.md, section 3).
//
// rooms.js holds the rules (rooms, the host and its grace period, passing messages, limits). This file only
// does the WebSockets, with the `ws` package, and the limits that matter on the open internet.
//
// The relay passes messages and stores nothing: nothing on disk, no recording. Voice and screens go directly
// between the computers; the relay only carries the messages that introduce them. A restart (a deploy, or
// the machine waking from sleep) empties every room; the host's page makes its room again with its host key.
//
// It never logs messages, room codes, names or addresses: only a startup line and, now and then, counts.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createRooms, LIMITS } from './rooms.js';

export const DEFAULTS = Object.freeze({
  port: 8080,
  host: '0.0.0.0',
  // Pages from other sites are turned away. Browsers always send Origin with a WebSocket; a client that
  // isn't a browser sends none and is let in (an origin check is a courtesy, not a lock).
  allowedOrigins: ['https://thunderbird.cafe'],
  maxConnections: 300,
  maxPerIp: 20,                       // a page opens one connection; a household shares one address
  // A frame bigger than this is refused by `ws` before it's read. rooms.js answers anything over 64 KB (in
  // characters) with "too big"; this leaves room for multi-byte characters up to that.
  maxFrameBytes: 4 * LIMITS.maxBytes,
  joinWithinMs: 30_000,               // a connection must be in a room this soon
  maxErrors: 50,                      // errors answered on one connection before it's closed
  heartbeatMs: 20_000,                // ping each connection; one that doesn't answer is dropped (a host goes "away")
  sweepMs: 5_000,                     // rooms whose host's grace period is over end (rooms.js)
  maxBufferedBytes: 4 * 1024 * 1024,  // a page this far behind is dropped
  statsMs: 60 * 60_000,               // a counts line in the log, at most this often, only when busy
});

const originAllowed = (cfg, origin) => cfg.allowedOrigins.includes('*') || cfg.allowedOrigins.includes(origin);

export function createRelayServer(userConfig = {}) {
  const cfg = { ...DEFAULTS, ...userConfig };
  const rooms = createRooms({ ...(cfg.now ? { now: cfg.now } : {}), ...(cfg.limits ? { limits: cfg.limits } : {}) });
  const conns = new Map();          // ws → { ip, joined, errors, alive, joinTimer }
  const perIp = new Map();
  const timers = [];
  const log = cfg.log || ((line) => console.log(line));

  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('ok');
      return;
    }
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('The Rooms lab relay: it introduces the people in a room to each other and passes their messages. It stores nothing; voice and screens go directly between the computers.\nhttps://thunderbird.cafe/webtiles/rooms-lab/\n');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  // Compression off: nothing to unpack, so no compression bombs, and less work.
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxFrameBytes, perMessageDeflate: false });
  const clientIp = (req) => String(req.headers['fly-client-ip'] || req.socket.remoteAddress || 'unknown');

  server.on('upgrade', (req, socket, head) => {
    const refuse = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const path = (req.url || '').split('?')[0];
    if (path !== '/') return refuse(404, 'Not Found');
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(cfg, origin)) return refuse(403, 'Forbidden');
    if (conns.size >= cfg.maxConnections) return refuse(503, 'Service Unavailable');
    const ip = clientIp(req);
    if ((perIp.get(ip) || 0) >= cfg.maxPerIp) return refuse(429, 'Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => onOpen(ws, ip));
  });

  function deliver(out) {
    for (const { conn, msg, close } of out) {
      const c = conns.get(conn);
      if (!c || conn.readyState !== WebSocket.OPEN) continue;
      if (close) { conn.close(close.code, close.why); continue; }
      if (msg.t === 'joined') { c.joined = true; clearTimeout(c.joinTimer); }
      if (msg.t === 'error' && ++c.errors >= cfg.maxErrors) { conn.close(1008, 'too many errors'); continue; }
      if (conn.bufferedAmount > cfg.maxBufferedBytes) { conn.terminate(); continue; }
      conn.send(JSON.stringify(msg));
    }
  }

  function onOpen(ws, ip) {
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    const c = { ip, joined: false, errors: 0, alive: true, joinTimer: null };
    conns.set(ws, c);
    rooms.open(ws);
    c.joinTimer = setTimeout(() => { if (!c.joined) ws.close(1008, 'join a room first'); }, cfg.joinWithinMs);
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data, isBinary) => {
      c.alive = true;
      if (isBinary) return deliver([{ conn: ws, msg: { t: 'error', why: 'not text' } }]);
      deliver(rooms.receive(ws, data.toString('utf8')));
    });
    ws.on('close', () => onClose(ws, c));
    ws.on('error', () => { /* a close always follows */ });
  }

  function onClose(ws, c) {
    if (!conns.has(ws)) return;
    clearTimeout(c.joinTimer);
    const n = (perIp.get(c.ip) || 1) - 1;
    if (n <= 0) perIp.delete(c.ip); else perIp.set(c.ip, n);
    conns.delete(ws);
    deliver(rooms.close(ws));
  }

  // Dead connections (a laptop shut, wifi gone) are found by the heartbeat; a guest then leaves the room,
  // and a host goes "away" (the others see "Waiting for <host> to come back…").
  timers.push(setInterval(() => {
    for (const [ws, c] of conns) {
      if (!c.alive) { ws.terminate(); continue; }
      c.alive = false;
      try { ws.ping(); } catch { /* closing anyway */ }
    }
  }, cfg.heartbeatMs));
  timers.push(setInterval(() => deliver(rooms.sweep()), cfg.sweepMs));
  let lastStats = '';
  timers.push(setInterval(() => {
    const s = rooms.stats();
    const line = `rooms ${s.rooms}, connections ${conns.size}`;
    if (line !== lastStats && (s.rooms || s.connections || lastStats)) log(line);
    lastStats = s.rooms || s.connections ? line : '';
  }, cfg.statsMs));
  timers.forEach((t) => t.unref());

  return {
    server, cfg,
    stats: () => rooms.stats(),
    listen: () => new Promise((resolve) => server.listen(cfg.port, cfg.host, () => resolve(server.address().port))),
    // Stop: tell every page the relay is going away (1012, "service restart"), so they reconnect at once.
    close: ({ crash = false } = {}) => new Promise((resolve) => {
      timers.forEach(clearInterval);
      for (const ws of conns.keys()) { if (crash) ws.terminate(); else ws.close(1012, 'restarting'); }
      wss.close();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

// ---- Run as a program: `node server.js` (Fly runs it this way) ----
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const env = process.env;
  const cfg = {};
  if (env.PORT) cfg.port = Number(env.PORT);
  if (env.HOST) cfg.host = env.HOST;
  if (env.ALLOWED_ORIGINS) cfg.allowedOrigins = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (env.MAX_CONNECTIONS) cfg.maxConnections = Number(env.MAX_CONNECTIONS);
  if (env.MAX_PER_IP) cfg.maxPerIp = Number(env.MAX_PER_IP);
  const r = createRelayServer(cfg);
  const port = await r.listen();
  console.log(`Rooms lab relay listening on :${port}; pages allowed from ${r.cfg.allowedOrigins.join(', ')}`);
  const stop = async () => { await r.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
