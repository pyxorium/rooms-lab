// The Rooms lab relay on Fly.io (thunderbird-rooms-relay, wss://relay.rooms.thunderbird.cafe/): the network
// around rooms.js. Modelled on Daisy's relay (C:\thunderbird-cafe\daisy-relay\server.js), without the lounge.
// Rooms are "anyone with the link" (a room code); people type a name, or sign in to show a verified handle
// (step 8, below).
//
// rooms.js holds the rules (rooms, the host and its grace period, passing messages, limits). This file only
// does the WebSockets, with the `ws` package, and the limits that matter on the open internet.
//
// The relay passes messages and stores nothing: nothing on disk, no recording. Voice and screens go directly
// between the computers when they can; the relay only carries the messages that introduce them. A restart (a
// deploy, or the machine waking from sleep) empties every room; the host's page makes its room again with its
// host key.
//
// TURN (step 7, turn.js): a page that has joined a room may ask { t: "ice" } and gets { t: "ice", servers, ttl }
// (Cloudflare TURN credentials for 4 hours) or { t: "ice", none: "off" | "unavailable" }. Only joined
// connections, at most once every 10 minutes each and a few times in all, and a cap for the whole relay: the
// credentials are worth money. The key stays here (Fly secrets TURN_KEY_ID, TURN_KEY_API_TOKEN).
//
// Optional sign-in (step 8, signin.js): a join may carry a pass (a one-minute service-auth token from the
// person's own server, for cafe.thunderbird.rooms.join at did:web:relay.rooms.thunderbird.cafe#rooms_relay).
// This file checks it before rooms.js sees the join (atproto-signin.js: Bluesky's verifyJwt and identity
// lookups, loaded the first time someone joins signed in), then hands rooms.js { did, handle }. A pass that
// isn't accepted gets { t: "error", why: "sign-in", detail } (detail: "pass", "handle", "lookup",
// "unavailable", "too many" or "refused"; never the account). Without the packages, sign-in is unavailable
// and rooms carry on with typed names. The relay serves its own DID document at /.well-known/did.json.
//
// It never logs messages, room codes, names, accounts or addresses: only a startup line and, now and then, counts.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createRooms, LIMITS } from './rooms.js';
import { createTurn } from './turn.js';
import { didDocument, RELAY_HOST, signInDetail } from './signin.js';

export const DEFAULTS = Object.freeze({
  port: 8080,
  host: '0.0.0.0',
  // Pages from other sites are turned away. Browsers always send Origin with a WebSocket; a client that
  // isn't a browser sends none and is let in (an origin check is a courtesy, not a lock).
  allowedOrigins: ['https://raku.lexicographer.space'],   // rooms live in Raku (the lab page retired Oct 29 2026)
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
  iceEveryMs: 10 * 60_000,            // one connection may ask for TURN credentials this often…
  iceMaxPerConn: 6,                   // …and this many times in all (the first, then a refresh every 3 hours)
  icePerMinute: 60,                   // the whole relay: at most this many asks to Cloudflare a minute
  signInPerConn: 6,                   // sign-in checks one connection may ask for (each reconnect brings a fresh pass)…
  signInPerMinute: 120,               // …and the whole relay a minute (each check looks the account up)
  maxBacklog: 50,                     // messages held while a connection's sign-in is being checked
  publicHost: RELAY_HOST,             // the relay's own name: its identity is did:web:<publicHost>
});

const originAllowed = (cfg, origin) => cfg.allowedOrigins.includes('*') || cfg.allowedOrigins.includes(origin);

export function createRelayServer(userConfig = {}) {
  const cfg = { ...DEFAULTS, ...userConfig };
  const rooms = createRooms({ ...(cfg.now ? { now: cfg.now } : {}), ...(cfg.limits ? { limits: cfg.limits } : {}) });
  const turn = cfg.turn || createTurn({});
  const now = cfg.now || (() => Date.now());
  let iceMinute = { at: 0, n: 0 };
  let signInMinute = { at: 0, n: 0 };
  // The sign-in check: Bluesky's packages, loaded the first time a pass arrives, or one handed in (the tests).
  let signIn = cfg.signIn ? Promise.resolve(cfg.signIn) : null;
  const getSignIn = () => (signIn ||= import('./atproto-signin.js').then((m) => m.atprotoSignIn()).catch(() => { signIn = null; return null; }));
  const conns = new Map();          // ws → { ip, joined, errors, alive, joinTimer }
  const perIp = new Map();
  const timers = [];
  const log = cfg.log || ((line) => console.log(line));

  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (req.method === 'GET' && path === '/.well-known/did.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(didDocument(cfg.publicHost)));
      return;
    }
    if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('ok');
      return;
    }
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('The Rooms lab relay: it introduces the people in a room to each other and passes their messages. It stores nothing; voice and screens go directly between the computers when they can, otherwise through Cloudflare\'s TURN relay, still encrypted.\nhttps://thunderbird.cafe/webtiles/rooms-lab/\n');
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
    const c = { ip, joined: false, errors: 0, alive: true, joinTimer: null, ice: { n: 0, at: -Infinity }, signIns: 0, busy: false, backlog: [] };
    conns.set(ws, c);
    rooms.open(ws);
    c.joinTimer = setTimeout(() => { if (!c.joined) ws.close(1008, 'join a room first'); }, cfg.joinWithinMs);
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data, isBinary) => {
      c.alive = true;
      if (isBinary) return deliver([{ conn: ws, msg: { t: 'error', why: 'not text' } }]);
      const text = data.toString('utf8');
      if (c.busy) {                       // a sign-in is being checked: keep the order
        if (c.backlog.length >= cfg.maxBacklog) return deliver([{ conn: ws, msg: { t: 'error', why: 'too many' } }]);
        c.backlog.push(text);
        return;
      }
      handleText(ws, c, text);
    });
    ws.on('close', () => onClose(ws, c));
    ws.on('error', () => { /* a close always follows */ });
  }

  function handleText(ws, c, text) {
    if (text.length < 64 && /^\s*\{\s*"t"\s*:\s*"ice"\s*\}\s*$/.test(text)) return askIce(ws, c);
    // A join with a pass: checked first (signin.js), then handed to rooms.js with the account.
    if (text.includes('"pass"') && text.length <= LIMITS.maxBytes) {
      let m = null;
      try { m = JSON.parse(text); } catch { /* rooms.js answers "not JSON" */ }
      if (m && typeof m === 'object' && !Array.isArray(m) && m.t === 'join' && 'pass' in m) {
        c.busy = true;
        return checkJoin(ws, c, text, m).finally(() => {
          c.busy = false;
          while (!c.busy && c.backlog.length && conns.has(ws)) handleText(ws, c, c.backlog.shift());
        });
      }
    }
    deliver(rooms.receive(ws, text));
  }

  async function checkJoin(ws, c, text, m) {
    const refuse = (detail) => deliver([{ conn: ws, msg: { t: 'error', why: 'sign-in', detail } }]);
    if (c.joined) return deliver(rooms.receive(ws, text));          // "already joined"
    if (typeof m.pass !== 'string' || !m.pass) return refuse('pass');
    const t = now();
    if (t - signInMinute.at >= 60_000) signInMinute = { at: t, n: 0 };
    if (c.signIns >= cfg.signInPerConn || signInMinute.n >= cfg.signInPerMinute) return refuse('too many');
    c.signIns += 1; signInMinute.n += 1;
    const check = await getSignIn();
    if (!conns.has(ws)) return;
    if (!check) return refuse('unavailable');
    let who;
    try { who = await check(m.pass); } catch (err) {
      if (!conns.has(ws)) return;
      return refuse(signInDetail(err));
    }
    if (!conns.has(ws)) return;
    deliver(rooms.receive(ws, text, { did: who.did, handle: who.handle }));
  }

  // TURN credentials for a page in a room (turn.js).
  async function askIce(ws, c) {
    const reply = (msg) => deliver([{ conn: ws, msg }]);
    if (!c.joined) return reply({ t: 'error', why: 'join a room first' });
    if (!turn.on) return reply({ t: 'ice', none: 'off' });
    const t = now();
    if (c.ice.n >= cfg.iceMaxPerConn || t - c.ice.at < cfg.iceEveryMs) return reply({ t: 'error', why: 'ice too soon' });
    if (t - iceMinute.at >= 60_000) iceMinute = { at: t, n: 0 };
    if (iceMinute.n >= cfg.icePerMinute) return reply({ t: 'ice', none: 'unavailable' });
    iceMinute.n += 1;
    c.ice = { n: c.ice.n + 1, at: t };
    const got = await turn.get();
    if (!conns.has(ws)) return;
    reply(got ? { t: 'ice', servers: got.iceServers, ttl: got.ttl } : { t: 'ice', none: 'unavailable' });
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
  cfg.turn = createTurn({ keyId: env.TURN_KEY_ID, apiToken: env.TURN_KEY_API_TOKEN });
  const r = createRelayServer(cfg);
  const port = await r.listen();
  const signInState = await import('./atproto-signin.js').then(() => 'ready').catch(() => 'unavailable (run npm install)');
  console.log(`Rooms lab relay listening on :${port}; pages allowed from ${r.cfg.allowedOrigins.join(', ')}; TURN ${cfg.turn.on ? 'on (Cloudflare)' : 'off'}; sign-in ${signInState}`);
  const stop = async () => { await r.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
