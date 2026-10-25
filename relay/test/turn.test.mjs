// TURN credentials (turn.js and the relay's { t: "ice" }): Cloudflare's answer read and trimmed, the key kept
// on the relay, only joined pages served, the limits, and rooms carrying on when Cloudflare isn't there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createTurn, readIceServers, TURN } from '../turn.js';
import { createRelayServer } from '../server.js';

// Cloudflare's documented example answer (developers.cloudflare.com, "Generate credentials").
const CLOUDFLARE = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
    {
      urls: [
        'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp',
        'turn:turn.cloudflare.com:3478?transport=tcp', 'turn:turn.cloudflare.com:80?transport=tcp',
        'turns:turn.cloudflare.com:5349?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp',
      ],
      username: 'bc91b63e2b5d759f8eb9f3b58062439e0a0e15893d76317d833265ad08d6631099ce7c7087caabb31ad3e1c386424e3e',
      credential: 'ebd71f1d3edbc2b0edae3cd5a6d82284aeb5c3b8fdaa9b8e3bf9cec683e0d45fe9f5b44e5145db3300f06c250a15b4a0',
    },
  ],
};

function fakeCloudflare({ status = 201, body = CLOUDFLARE, fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (fail) throw new Error('network');
    return { status, json: async () => body };
  };
  return { calls, fetchImpl };
}

test('Cloudflare\'s answer: port 53 left out (browsers block it), TLS on 443 kept, odd entries dropped', () => {
  const s = readIceServers(CLOUDFLARE);
  assert.deepEqual(s[0], { urls: ['stun:stun.cloudflare.com:3478'] });
  assert.deepEqual(s[1].urls, [
    'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp',
    'turn:turn.cloudflare.com:80?transport=tcp', 'turns:turn.cloudflare.com:5349?transport=tcp',
    'turns:turn.cloudflare.com:443?transport=tcp',
  ]);
  assert.equal(s[1].username, CLOUDFLARE.iceServers[1].username);
  assert.equal(readIceServers({}), null);
  assert.equal(readIceServers({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] }), null, 'no TURN entry: nothing to send');
  assert.equal(readIceServers({ iceServers: [{ urls: ['turn:turn.cloudflare.com:3478'] }] }), null, 'TURN without a username');
  const odd = readIceServers({ iceServers: [{ urls: ['javascript:alert(1)', 'turn:evil host:3478'], username: 'u', credential: 'c' }, { urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'c', extra: 'dropped' }] });
  assert.deepEqual(odd, [{ urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'c' }]);
});

test('createTurn asks Cloudflare with the key and a 4-hour lifetime; off without both secrets; null when Cloudflare fails', async () => {
  const cf = fakeCloudflare();
  const turn = createTurn({ keyId: 'key1234abcd', apiToken: 'secret-token', fetchImpl: cf.fetchImpl });
  assert.equal(turn.on, true);
  const got = await turn.get();
  assert.equal(got.ttl, 4 * 3600);
  assert.equal(TURN.ttlSeconds, 4 * 3600);
  assert.equal(cf.calls[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key1234abcd/credentials/generate-ice-servers');
  assert.equal(cf.calls[0].init.method, 'POST');
  assert.equal(cf.calls[0].init.headers.authorization, 'Bearer secret-token');
  assert.deepEqual(cf.calls[0].body, { ttl: 14400 });
  assert.equal(createTurn({ keyId: 'key1234abcd', fetchImpl: cf.fetchImpl }).on, false);
  assert.equal(createTurn({ apiToken: 'x', fetchImpl: cf.fetchImpl }).on, false);
  assert.equal(createTurn({ keyId: '../../x', apiToken: 'x', fetchImpl: cf.fetchImpl }).on, false, 'a key id that would bend the address');
  assert.equal(await createTurn({ keyId: 'key1234abcd', apiToken: 't', fetchImpl: fakeCloudflare({ status: 401 }).fetchImpl }).get(), null);
  assert.equal(await createTurn({ keyId: 'key1234abcd', apiToken: 't', fetchImpl: fakeCloudflare({ fail: true }).fetchImpl }).get(), null);
  assert.equal(await createTurn({ keyId: 'key1234abcd', apiToken: 't', fetchImpl: fakeCloudflare({ body: { nope: 1 } }).fetchImpl }).get(), null);
  assert.equal(await createTurn({}).get(), null);
});

// ---- The relay's { t: "ice" } ----
const ROOM = 'k7q3m2xw9aZ4';
async function start(cfg = {}) {
  const r = createRelayServer({ port: 0, host: '127.0.0.1', allowedOrigins: ['https://thunderbird.cafe'], log: () => {}, ...cfg });
  const port = await r.listen();
  return { r, url: `ws://127.0.0.1:${port}/` };
}
function page(url) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { origin: 'https://thunderbird.cafe' });
    const inbox = [];
    ws.on('message', (d) => inbox.push(JSON.parse(d.toString())));
    ws.on('open', () => resolve({
      send: (x) => ws.send(JSON.stringify(x)),
      async until(t, ms = 3000) {
        const end = Date.now() + ms;
        for (;;) {
          const i = inbox.findIndex((m) => m.t === t);
          if (i >= 0) return inbox.splice(0, i + 1).pop();
          if (Date.now() > end) throw new Error(`no ${t}`);
          await new Promise((r) => setTimeout(r, 20));
        }
      },
      inbox,
    }));
  });
}

test('only a page in a room gets credentials; they never carry the key; once every 10 minutes per connection', async (tt) => {
  let t = 1_000_000;
  const cf = fakeCloudflare();
  const turn = createTurn({ keyId: 'key1234abcd', apiToken: 'secret-token', fetchImpl: cf.fetchImpl });
  const { r, url } = await start({ turn, now: () => t });
  tt.after(() => r.close());
  const a = await page(url);
  a.send({ t: 'ice' });
  assert.deepEqual(await a.until('error'), { t: 'error', why: 'join a room first' });
  assert.equal(cf.calls.length, 0, 'Cloudflare not asked for a page outside any room');
  a.send({ t: 'join', room: ROOM, peer: 'peerAAAAAAAA', name: 'Ann', create: true });
  await a.until('joined');
  a.send({ t: 'ice' });
  const ice = await a.until('ice');
  assert.equal(ice.ttl, 14400);
  assert.equal(ice.servers.at(-1).username, CLOUDFLARE.iceServers[1].username);
  assert.ok(!JSON.stringify(ice).includes('secret-token') && !JSON.stringify(ice).includes('key1234abcd'));
  a.send({ t: 'ice' });
  assert.deepEqual(await a.until('error'), { t: 'error', why: 'ice too soon' });
  t += 10 * 60_000;                                                   // a refresh later on is fine
  a.send({ t: 'ice' });
  assert.ok((await a.until('ice')).servers);
  assert.equal(cf.calls.length, 2);
  // A second person gets their own.
  const b = await page(url);
  b.send({ t: 'join', room: ROOM, peer: 'peerBBBBBBBB', name: 'Bo' });
  await b.until('joined');
  b.send({ t: 'ice' });
  assert.ok((await b.until('ice')).servers);
  // "ice" with anything else in it is just an unknown message for the room rules.
  b.send({ t: 'ice', please: 'more' });
  assert.deepEqual(await b.until('error'), { t: 'error', why: 'unknown type' });
});

test('a few times in all per connection, and a cap for the whole relay', async (tt) => {
  let t = 5_000_000;
  const cf = fakeCloudflare();
  const turn = createTurn({ keyId: 'key1234abcd', apiToken: 'secret-token', fetchImpl: cf.fetchImpl });
  const { r, url } = await start({ turn, now: () => t, iceMaxPerConn: 2, icePerMinute: 3 });
  tt.after(() => r.close());
  const a = await page(url);
  a.send({ t: 'join', room: ROOM, peer: 'peerAAAAAAAA', name: 'Ann', create: true });
  await a.until('joined');
  for (let i = 0; i < 2; i++) { a.send({ t: 'ice' }); assert.ok((await a.until('ice')).servers); t += 11 * 60_000; }
  a.send({ t: 'ice' });
  assert.deepEqual(await a.until('error'), { t: 'error', why: 'ice too soon' });
  // The relay-wide cap: three asks a minute in all, then "unavailable" until the minute is over.
  const people = [];
  for (let i = 0; i < 4; i++) {
    const p = await page(url);
    p.send({ t: 'join', room: ROOM, peer: `peer${i}XXXXXXX`, name: `P${i}` });
    await p.until('joined');
    people.push(p);
  }
  for (const p of people.slice(0, 3)) { p.send({ t: 'ice' }); assert.ok((await p.until('ice')).servers); }
  people[3].send({ t: 'ice' });
  assert.deepEqual(await people[3].until('ice'), { t: 'ice', none: 'unavailable' });
  t += 60_000;
  const later = await page(url);
  later.send({ t: 'join', room: ROOM, peer: 'peerLATERXXXX', name: 'Later' });
  await later.until('joined');
  later.send({ t: 'ice' });
  assert.ok((await later.until('ice')).servers, 'a new minute: asks go through again');
  assert.equal(cf.calls.length, 6);
});

test('without the secrets the room works as before and the page hears TURN is off; Cloudflare failing is "unavailable"', async (tt) => {
  const off = await start();
  tt.after(() => off.r.close());
  const a = await page(off.url);
  a.send({ t: 'join', room: ROOM, peer: 'peerAAAAAAAA', name: 'Ann', create: true });
  await a.until('joined');
  a.send({ t: 'ice' });
  assert.deepEqual(await a.until('ice'), { t: 'ice', none: 'off' });
  a.send({ t: 'all', data: { kind: 'hello' } });                    // the room still works

  const down = await start({ turn: createTurn({ keyId: 'key1234abcd', apiToken: 't', fetchImpl: fakeCloudflare({ fail: true }).fetchImpl }) });
  tt.after(() => down.r.close());
  const b = await page(down.url);
  b.send({ t: 'join', room: ROOM, peer: 'peerBBBBBBBB', name: 'Bo', create: true });
  await b.until('joined');
  b.send({ t: 'ice' });
  assert.deepEqual(await b.until('ice'), { t: 'ice', none: 'unavailable' });
});

test('the Fly image carries every module the relay imports (turn.js included)', async () => {
  const { readFileSync } = await import('node:fs');
  const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  const docker = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  const copied = docker.split('\n').filter((l) => /^COPY /.test(l)).join(' ');
  const local = [...server.matchAll(/from '\.\/([\w-]+\.js)'/g)].map((m) => m[1]);
  assert.ok(local.includes('turn.js'));
  for (const f of local) assert.ok(copied.includes(f), `Dockerfile copies ${f}`);
});
