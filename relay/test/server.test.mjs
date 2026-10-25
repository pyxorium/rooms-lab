// The relay's network layer (server.js) over real WebSockets: health, origins, limits, a room of three,
// the host's grace period, dead connections, restarts, and the Fly files.
// (The room rules themselves are tested in rooms.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { createRelayServer } from '../server.js';
import { LIMITS } from '../rooms.js';

const ROOM = 'k7q3m2xw9aZ4';
const SITE = 'https://thunderbird.cafe';
const quiet = { log: () => {} };

// The pages fly.toml lets in (what the live relay runs with).
const FLY_ORIGINS = readFileSync(new URL('../fly.toml', import.meta.url), 'utf8').match(/^\s*ALLOWED_ORIGINS = '([^']*)'$/m)[1].split(',');

async function start(cfg = {}) {
  const r = createRelayServer({ port: 0, host: '127.0.0.1', allowedOrigins: FLY_ORIGINS, ...quiet, ...cfg });
  const port = await r.listen();
  return { r, port, url: `ws://127.0.0.1:${port}/` };
}

// A page's connection: opens (or fails with the HTTP status), collects messages, `next()` waits for one,
// `until(t)` skips to the next message of type t.
function page(url, { origin = SITE, headers = {} } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { origin, headers });
    const inbox = [];
    let wake = null, closed = null;
    ws.on('message', (d) => { inbox.push(JSON.parse(d.toString())); if (wake) { wake(); wake = null; } });
    ws.on('close', (code) => { closed = code; if (wake) { wake(); wake = null; } });
    ws.on('unexpected-response', (req, res) => resolve({ refused: res.statusCode }));
    ws.on('error', () => {});
    const p = {
      ws,
      send: (x) => ws.send(typeof x === 'string' ? x : JSON.stringify(x)),
      async next(ms = 3000) {
        const until = Date.now() + ms;
        while (!inbox.length) {
          if (closed !== null) return { closed };
          if (Date.now() > until) throw new Error('nothing arrived');
          await new Promise((r) => { wake = r; setTimeout(r, 50); });
        }
        return inbox.shift();
      },
      async until(t, ms = 3000) {
        for (;;) { const m = await p.next(ms); if (m.t === t || m.closed !== undefined) return m; }
      },
    };
    ws.on('open', () => resolve(p));
  });
}

const join = (p, peer, name, extra = {}) => p.send({ t: 'join', room: ROOM, peer, name, ...extra });

test('health and a plain page for the address; other paths not found', async () => {
  const { r, port } = await start();
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`).then(async (res) => [res.status, await res.text()]);
  assert.deepEqual(await get('/health'), [200, 'ok']);
  const [s, text] = await get('/');
  assert.equal(s, 200);
  assert.match(text, /stores nothing/);
  assert.match(text, /directly between the computers/);
  assert.equal((await get('/anything'))[0], 404);
  assert.equal((await get('/.well-known/did.json'))[0], 404);     // no identity yet: the lab has no sign-in
  await r.close();
});

test('pages from the allowed sites (fly.toml: thunderbird.cafe and the site\'s dev server) get in; other sites, Daisy-only origins and other paths are turned away', async () => {
  const { r, url } = await start();
  const ok = await page(url);
  assert.ok(ok.ws);
  const local = await page(url, { origin: 'http://127.0.0.1:4321' });
  assert.ok(local.ws);
  assert.equal((await page(url, { origin: 'https://raku.lexicographer.space' })).refused, 403);   // added when rooms move to Raku
  assert.equal((await page(url, { origin: 'https://www.thunderbird.cafe' })).refused, 403);
  assert.equal((await page(url, { origin: 'https://example.com' })).refused, 403);
  assert.equal((await page(url, { origin: 'http://localhost:4321' })).refused, 403);
  assert.equal((await page(url.replace(/\/$/, '/lounge'))).refused, 404);
  ok.ws.close(); local.ws.close();
  await r.close();
});

test('a room of three over the real relay: create, join, who\'s here, "to" and "all", remove, end', async () => {
  const { r, url } = await start();
  const host = await page(url), a = await page(url), b = await page(url);
  join(host, 'peer-host-1', 'Nick', { create: true });
  const joined = await host.next();
  assert.equal(joined.t, 'joined');
  assert.equal(joined.host, true);
  assert.match(joined.hostKey, /^[A-Za-z0-9_-]{43}$/);
  await host.until('peers');
  join(a, 'peer-guest-1', 'Robin');
  assert.deepEqual(await a.next(), { t: 'joined', room: ROOM, peer: 'peer-guest-1', host: false });
  assert.equal((await a.next()).list.length, 2);
  assert.equal((await host.next()).list.length, 2);
  join(b, 'peer-guest-2', 'Ted');
  await b.until('peers');
  const three = await host.until('peers');
  assert.deepEqual(three.list.map((p) => [p.name, p.host]), [['Nick', true], ['Robin', false], ['Ted', false]]);
  await a.until('peers');
  // WebRTC setup goes to one person; a tile share to everyone else
  a.send({ t: 'to', peer: 'peer-guest-2', data: { kind: 'offer', sdp: 'v=0' } });
  assert.deepEqual(await b.next(), { t: 'from', peer: 'peer-guest-1', data: { kind: 'offer', sdp: 'v=0' } });
  host.send({ t: 'all', data: { kind: 'tile', uri: 'at://did:plc:x/ing.dasl.masl/3abc', cid: 'bafyreiabc' } });
  const shared = { t: 'from', peer: 'peer-host-1', data: { kind: 'tile', uri: 'at://did:plc:x/ing.dasl.masl/3abc', cid: 'bafyreiabc' }, all: true };
  assert.deepEqual(await a.next(), shared);
  assert.deepEqual(await b.next(), shared);
  // the host removes Ted (closed 4001), then ends the room (everyone closed 4000)
  host.send({ t: 'remove', peer: 'peer-guest-2' });
  assert.deepEqual(await b.next(), { t: 'removed' });
  assert.deepEqual(await b.next(), { closed: 4001 });
  assert.equal((await a.until('peers')).list.length, 2);
  host.send({ t: 'end' });
  for (const p of [host, a]) {
    assert.deepEqual(await p.until('ended'), { t: 'ended', why: 'host' });
    assert.deepEqual(await p.next(), { closed: 4000 });
  }
  assert.equal(r.stats().rooms, 0);
  await r.close();
});

test('the host drops: guests stay and see the host away; the host page comes back with its key (a new peer id) and is host again', async () => {
  const { r, url } = await start();
  const host = await page(url), a = await page(url);
  join(host, 'peer-host-1', 'Nick', { create: true });
  const { hostKey } = await host.next();
  join(a, 'peer-guest-1', 'Robin');
  await a.until('peers');
  host.ws.close();
  const away = await a.until('peers');
  assert.deepEqual(away.list[0], { peer: 'peer-host-1', name: 'Nick', host: true, away: true });
  const back = await page(url);
  join(back, 'peer-host-2', 'Nick', { hostKey });
  assert.deepEqual((await back.next()), { t: 'joined', room: ROOM, peer: 'peer-host-2', host: true, hostKey });
  const again = await a.until('peers');
  assert.deepEqual(again.list.find((p) => p.host), { peer: 'peer-host-2', name: 'Nick', host: true });
  a.ws.close(); back.ws.close();
  await r.close();
});

test('the host doesn\'t come back within the grace period: the guests hear "ended" ("host gone"), closed 4000', async () => {
  const { r, url } = await start({ limits: { ...LIMITS, hostGraceMs: 300 }, sweepMs: 50 });
  const host = await page(url), a = await page(url);
  join(host, 'peer-host-1', 'Nick', { create: true });
  await host.next();
  join(a, 'peer-guest-1', 'Robin');
  await a.until('peers');
  host.ws.close();
  await a.until('peers');
  assert.deepEqual(await a.next(2000), { t: 'ended', why: 'host gone' });
  assert.deepEqual(await a.next(), { closed: 4000 });
  assert.equal(r.stats().rooms, 0);
  await r.close();
});

test('refusals: not JSON, not text, too big (answered); a frame far too big closes the connection', async () => {
  const { r, url } = await start();
  const a = await page(url);
  a.send('nonsense');
  assert.equal((await a.next()).why, 'not JSON');
  a.ws.send(Buffer.from([1, 2, 3]), { binary: true });
  assert.equal((await a.next()).why, 'not text');
  join(a, 'peer-host-1', 'Nick', { create: true });
  assert.equal((await a.next()).t, 'joined');
  await a.next();
  a.send({ t: 'all', data: { pad: 'x'.repeat(70 * 1024) } });
  assert.equal((await a.next()).why, 'too big');
  a.send('x'.repeat(300 * 1024));                       // over the frame limit: ws closes it (1009)
  assert.deepEqual(await a.next(), { closed: 1009 });
  await r.close();
});

test('a connection that never joins a room is closed; one that keeps making mistakes is closed', async () => {
  const { r, url } = await start({ joinWithinMs: 200, maxErrors: 5 });
  const idle = await page(url);
  assert.deepEqual(await idle.next(), { closed: 1008 });
  const noisy = await page(url);
  join(noisy, 'peer-host-1', 'Nick', { create: true });
  assert.equal((await noisy.next()).t, 'joined');
  await noisy.next();
  for (let i = 0; i < 4; i++) { noisy.send('?'); assert.equal((await noisy.next()).why, 'not JSON'); }
  noisy.send('?');
  assert.deepEqual(await noisy.next(), { closed: 1008 });
  await r.close();
});

test('limits: connections per address (Fly\'s fly-client-ip), and in all', async () => {
  const { r, url } = await start({ maxPerIp: 2, maxConnections: 3 });
  const home = { headers: { 'fly-client-ip': '203.0.113.7' } };
  const p1 = await page(url, home), p2 = await page(url, home);
  assert.ok(p1.ws && p2.ws);
  assert.equal((await page(url, home)).refused, 429);
  const other = await page(url, { headers: { 'fly-client-ip': '198.51.100.2' } });
  assert.ok(other.ws);
  assert.equal((await page(url, { headers: { 'fly-client-ip': '198.51.100.3' } })).refused, 503);
  p1.ws.close();
  await new Promise((res) => setTimeout(res, 100));
  const p3 = await page(url, home);
  assert.ok(p3.ws, 'a closed connection frees its place');
  for (const p of [p2, other, p3]) p.ws.close();
  await r.close();
});

test('a dead host connection (no answer to the heartbeat) is dropped, and the guest sees the host away', async () => {
  const { r, url } = await start({ heartbeatMs: 150 });
  const host = await page(url), a = await page(url);
  join(host, 'peer-host-1', 'Nick', { create: true });
  await host.next();
  join(a, 'peer-guest-1', 'Robin');
  await a.until('peers');
  host.ws.pong = () => {};                                 // the host stops answering pings, as a laptop shut
  host.ws._receiver.removeAllListeners('ping');
  host.ws._socket.pause();                                  // …and reads nothing more
  const away = await a.until('peers', 2000);
  assert.equal(away.list[0].away, true);
  a.ws.close(); host.ws.terminate();
  await r.close();
});

test('stopping (a deploy, a sleep) tells each page 1012; on a new relay the host makes the room again with its key, then guests join', async () => {
  const first = await start();
  const host = await page(first.url), a = await page(first.url);
  join(host, 'peer-host-1', 'Nick', { create: true });
  const { hostKey } = await host.next();
  join(a, 'peer-guest-1', 'Robin');
  await a.until('peers');
  await first.r.close();
  assert.deepEqual(await host.until('nothing'), { closed: 1012 });
  assert.deepEqual(await a.until('nothing'), { closed: 1012 });
  const again = await start({ port: first.port });
  const a2 = await page(again.url);
  join(a2, 'peer-guest-1', 'Robin');
  assert.equal((await a2.next()).why, 'no room');          // the guest's page tries again a little later
  const host2 = await page(again.url);
  join(host2, 'peer-host-1', 'Nick', { create: true, hostKey });
  assert.equal((await host2.next()).hostKey, hostKey);
  const a3 = await page(again.url);
  join(a3, 'peer-guest-1', 'Robin');
  assert.equal((await a3.next()).t, 'joined');
  for (const p of [a2, host2, a3]) p.ws.close();
  await again.r.close();
});

test('the Fly files: the app name, one region, sleeps when idle and wakes on a connection, counts connections, health check, the origins, the Dockerfile ships the relay\'s files, the lock file is current', () => {
  const toml = readFileSync(new URL('../fly.toml', import.meta.url), 'utf8');
  assert.match(toml, /^app = 'thunderbird-rooms-relay'$/m);
  assert.match(toml, /^primary_region = 'sjc'$/m);
  assert.match(toml, /auto_stop_machines = 'stop'/);
  assert.match(toml, /auto_start_machines = true/);
  assert.match(toml, /^\s*min_machines_running = 0$/m);                  // sleeps when idle (R4)
  assert.match(toml, /type = 'connections'/);
  assert.match(toml, /path = '\/health'/);
  assert.match(toml, /ALLOWED_ORIGINS = 'https:\/\/thunderbird\.cafe,http:\/\/127\.0\.0\.1:4321'$/m);
  assert.match(toml, /fly deploy --ha=false/);
  assert.match(toml, /relay\.rooms\.thunderbird\.cafe/);
  const docker = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(docker, /COPY server\.js rooms\.js turn\.js \.\//);
  assert.match(docker, /npm ci --omit=dev/);
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies, 'package-lock.json is out of date: run npm install');
  for (const name of Object.keys(pkg.dependencies)) assert.ok(lock.packages[`node_modules/${name}`], `${name} is missing from package-lock.json: run npm install`);
});
