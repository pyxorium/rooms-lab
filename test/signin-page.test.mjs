// The page's sign-in module (step 8, src/signin.js) with a stand-in library: the client id, the scope it asks
// for, keeping the sign-in, the pass it asks the account's server for, the clash check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignIn, cleanHandle, clientIdFor, pageOfScope, ACCOUNT_KEY } from '../src/signin.js';
import { SCOPE, CLIENT_ID, hasJoinScope, RELAY_AUDIENCE, JOIN_LXM } from '../src/config.js';

const GRANTED = 'atproto rpc:cafe.thunderbird.rooms.join?aud=did:web:relay.rooms.thunderbird.cafe%23rooms_relay';
const NICK = 'did:plc:nicknicknicknicknicknick';
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

function standIn({ granted = GRANTED, sessions = new Map(), calls = [] } = {}) {
  const session = (did, scope) => ({
    did, async getTokenInfo() { return { scope }; },
    async fetchHandler(path) { calls.push(path); return new Response(JSON.stringify({ token: `pass-${calls.length}` }), { status: 200 }); },
  });
  class BrowserOAuthClient {
    static async load(o) { calls.push(['load', o]); return new BrowserOAuthClient(); }
    async init() {}
    addEventListener() {}
    async signInPopup(handle, o) { calls.push(['popup', handle, o.scope]); sessions.set(NICK, granted); return session(NICK, granted); }
    async restore(did) { if (!sessions.has(did)) throw new Error('none'); return session(did, sessions.get(did)); }
    async revoke(did) { calls.push(['revoke', did]); sessions.delete(did); }
  }
  return { lib: { BrowserOAuthClient }, calls, sessions };
}
const LIVE = new URL('https://thunderbird.cafe/webtiles/rooms-lab/');

test('the scope: the Rooms set with the relay as audience; what the server grants is recognised', () => {
  assert.equal(SCOPE, 'atproto include:cafe.thunderbird.rooms.authJoin?aud=did:web:relay.rooms.thunderbird.cafe%23rooms_relay');
  assert.ok(hasJoinScope(GRANTED));
  assert.ok(!hasJoinScope('atproto include:cafe.thunderbird.daisy.authPlay'));
  assert.ok(!hasJoinScope('atproto rpc:cafe.thunderbird.rooms.joinx?aud=x'));
  assert.equal(RELAY_AUDIENCE, 'did:web:relay.rooms.thunderbird.cafe#rooms_relay');
  assert.equal(JOIN_LXM, 'cafe.thunderbird.rooms.join');
});

test('the client id: the live page\'s description file; a loopback one on this computer (with this page\'s path)', () => {
  assert.equal(clientIdFor(LIVE), CLIENT_ID);
  const local = clientIdFor(new URL('http://127.0.0.1:4321/webtiles/rooms-lab/'));
  assert.equal(local, `http://localhost?redirect_uri=${encodeURIComponent('http://127.0.0.1:4321/webtiles/rooms-lab/')}&scope=${encodeURIComponent(SCOPE)}`);
});

test('handles typed: "@", spaces and capitals tidied; non-handles refused', () => {
  assert.equal(cleanHandle(' @Nick.Example '), 'nick.example');
  for (const x of ['', 'nick', 'nick..example', 'did:plc:abc', 'a b.example']) assert.equal(cleanHandle(x), null, x);
});

test('which page an existing sign-in belongs to (from its scope)', () => {
  assert.equal(pageOfScope('atproto include:cafe.thunderbird.daisy.authPlay'), 'Daisy');
  assert.equal(pageOfScope('atproto repo:cafe.thunderbird.sevenup.match'), 'Seven-Up');
  assert.equal(pageOfScope(GRANTED), null);
  assert.equal(pageOfScope('atproto transition:generic'), 'another page on this site');
});

test('sign in: asks for the scope, keeps { did, handle }; a pass is asked for this relay, this method, one minute', async () => {
  const s = standIn(), storage = memory();
  const si = createSignIn(s.lib, { loc: LIVE, storage });
  assert.deepEqual(await si.start(), {});
  assert.equal(s.calls[0][1].clientId, CLIENT_ID);
  await si.signIn('Nick.Example');
  assert.deepEqual(s.calls.find((c) => c[0] === 'popup'), ['popup', 'Nick.Example', SCOPE]);
  assert.deepEqual(si.account, { did: NICK, handle: 'nick.example' });
  assert.deepEqual(JSON.parse(storage.getItem(ACCOUNT_KEY)), { did: NICK, handle: 'nick.example' });
  const t0 = Math.floor(Date.now() / 1000);
  assert.equal(await si.getPass(), 'pass-3');
  const q = new URL(`https://x${s.calls.at(-1)}`);
  assert.equal(q.pathname, '/xrpc/com.atproto.server.getServiceAuth');
  assert.equal(q.searchParams.get('aud'), RELAY_AUDIENCE);
  assert.equal(q.searchParams.get('lxm'), JOIN_LXM);
  assert.ok(Math.abs(Number(q.searchParams.get('exp')) - (t0 + 60)) <= 2);
  si.sawHandle('nick.example.org');
  assert.equal(si.account.handle, 'nick.example.org');
});

test('a sign-in without the Rooms permission is undone, not kept', async () => {
  const s = standIn({ granted: 'atproto' });
  const si = createSignIn(s.lib, { loc: LIVE, storage: memory() });
  await si.start();
  await assert.rejects(si.signIn('nick.example'), /Rooms permission/);
  assert.equal(si.account, null);
  assert.ok(s.calls.some((c) => c[0] === 'revoke'));
});

test('kept: the next visit is signed in without a window; a kept sign-in that\'s gone (or lacks the permission) is forgotten', async () => {
  const storage = memory();
  storage.setItem(ACCOUNT_KEY, JSON.stringify({ did: NICK, handle: 'nick.example' }));
  const ok = createSignIn(standIn({ sessions: new Map([[NICK, GRANTED]]) }).lib, { loc: LIVE, storage });
  await ok.start();
  assert.deepEqual(ok.account, { did: NICK, handle: 'nick.example' });
  const gone = createSignIn(standIn().lib, { loc: LIVE, storage });
  await gone.start();
  assert.equal(gone.account, null);
  assert.equal(storage.getItem(ACCOUNT_KEY), null);
});

test('signed out: no pass (SignInNeeded); sign out revokes and forgets', async () => {
  const s = standIn(), storage = memory();
  const si = createSignIn(s.lib, { loc: LIVE, storage });
  await si.start();
  await assert.rejects(si.getPass(), /signed out/);
  await si.signIn('nick.example');
  await si.signOut();
  assert.equal(si.account, null);
  assert.equal(storage.getItem(ACCOUNT_KEY), null);
  assert.ok(s.calls.some((c) => c[0] === 'revoke' && c[1] === NICK));
});

test('no library: unavailable, and the page runs with typed names', async () => {
  const si = createSignIn(null, { loc: LIVE, storage: memory() });
  assert.deepEqual(await si.start(), { unavailable: true });
  assert.equal(si.ready(), false);
});

test('the clash check: unknown when the handle or the store can\'t be read; no clash for an unknown handle (400)', async () => {
  const si = createSignIn(standIn().lib, { loc: LIVE, storage: memory(), idb: null,
    fetchImpl: async (u) => (String(u).includes('nobody') ? new Response('{}', { status: 400 }) : new Response(JSON.stringify({ did: NICK }), { status: 200 })) });
  assert.deepEqual(await si.clashFor('nobody.example'), { page: null });
  assert.deepEqual(await si.clashFor('nick.example'), { unknown: true }, 'no IndexedDB here: "may"');
  const down = createSignIn(standIn().lib, { loc: LIVE, storage: memory(), fetchImpl: async () => { throw new Error('offline'); } });
  assert.deepEqual(await down.clashFor('nick.example'), { unknown: true });
  assert.deepEqual(await down.clashFor('not a handle'), { page: null });
});
