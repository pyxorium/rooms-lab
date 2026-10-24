// The page's connection to the relay (src/room-link.js) against the real relay (relay/server.js) over real
// WebSockets: joining, the host key, messages, "no room" and trying again, a relay restart in the middle of
// a room, the ends ("removed", "ended", "replaced").
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createRelayServer } from '../relay/server.js';
import { connectRoom } from '../src/room-link.js';

const { WebSocket } = createRequire(new URL('../relay/package.json', import.meta.url))('ws');
const ROOM = 'abcdefghjkmn';
const FAST = { noRoomRetryMs: 100, noRoomTries: 30, askTimeoutMs: 60_000 };

async function relayAt(port = 0) {
  const r = createRelayServer({ port, host: '127.0.0.1', allowedOrigins: ['*'], log: () => {} });
  const p = await r.listen();
  return { r, port: p, url: `ws://127.0.0.1:${p}/` };
}

// A page's link with everything it hears written down; `wait(fn)` waits until fn() is true.
function pageLink(opts) {
  const heard = [], states = [], selves = [];
  const link = connectRoom({ WebSocketImpl: WebSocket, times: FAST, onMessage: (m) => heard.push(m), onState: (s, d) => states.push([s, d]), onSelf: (p) => selves.push(p), ...opts });
  return { link, heard, states, selves, lastState: () => states.at(-1)?.[0] };
}
async function wait(fn, ms = 3000) {
  const until = Date.now() + ms;
  while (!fn()) { if (Date.now() > until) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)); }
}

test('the host makes a room and gets its key; a guest joins; messages to one and to all; the host removes, then ends', async () => {
  const { r, url } = await relayAt();
  const host = pageLink({ url, room: ROOM, name: 'Nick', create: true, peer: 'peer-host-1' });
  await wait(() => host.lastState() === 'joined');
  assert.equal(host.link.isHost, true);
  assert.match(host.link.hostKey, /^[A-Za-z0-9_-]{43}$/);
  const g = pageLink({ url, room: ROOM, name: 'Robin', peer: 'peer-guest-1' });
  await wait(() => g.lastState() === 'joined');
  assert.equal(g.link.isHost, false);
  assert.equal(g.link.hostKey, null);
  await wait(() => host.heard.some((m) => m.t === 'peers' && m.list.length === 2));
  g.link.to('peer-host-1', { kind: 'ask-screen', id: 'x1' });
  await wait(() => host.heard.some((m) => m.t === 'from' && m.data.id === 'x1'));
  host.link.all({ kind: 'presenting', on: true });
  await wait(() => g.heard.some((m) => m.t === 'from' && m.all && m.data.kind === 'presenting'));
  host.link.remove('peer-guest-1');
  await wait(() => g.lastState() === 'over');
  assert.equal(g.states.at(-1)[1].why, 'removed');
  host.link.end();
  await wait(() => host.lastState() === 'over');
  assert.equal(host.states.at(-1)[1].why, 'ended');
  await r.close();
});

test('a guest with a link to a room that isn\'t there yet tries again, and gets in once the host makes it', async () => {
  const { r, url } = await relayAt();
  const g = pageLink({ url, room: ROOM, name: 'Robin', peer: 'peer-guest-1' });
  await wait(() => g.states.some(([s]) => s === 'no-room'));
  const host = pageLink({ url, room: ROOM, name: 'Nick', create: true, peer: 'peer-host-1' });
  await wait(() => g.lastState() === 'joined');
  host.link.stop(); g.link.stop();
  await r.close();
});

test('a guest gives up after the tries run out', async () => {
  const { r, url } = await relayAt();
  const g = pageLink({ url, room: ROOM, name: 'Robin', times: { ...FAST, noRoomTries: 2 } });
  await wait(() => g.lastState() === 'over');
  assert.equal(g.states.at(-1)[1].why, 'no room');
  await r.close();
});

test('a relay restart in the middle of a room: the host\'s page makes it again with the same key, and the guest gets back in', async () => {
  const first = await relayAt();
  const host = pageLink({ url: first.url, room: ROOM, name: 'Nick', create: true, peer: 'peer-host-1' });
  await wait(() => host.lastState() === 'joined');
  const key = host.link.hostKey;
  const g = pageLink({ url: first.url, room: ROOM, name: 'Robin', peer: 'peer-guest-1' });
  await wait(() => g.lastState() === 'joined');
  await first.r.close();
  await wait(() => host.states.some(([s]) => s === 'down') && g.states.some(([s]) => s === 'down'));
  const again = await relayAt(first.port);
  await wait(() => host.lastState() === 'joined' && g.lastState() === 'joined', 15000);
  assert.equal(host.link.hostKey, key, 'same host key: the host link still works');
  assert.equal(host.link.isHost, true);
  host.link.to('peer-guest-1', { kind: 'ask-screen', id: 'after' });
  await wait(() => g.heard.some((m) => m.t === 'from' && m.data.id === 'after'));
  host.link.stop(); g.link.stop();
  await again.r.close();
});

test('the host link in another tab takes over as host (the old tab is told "replaced"); a wrong host key joins as a guest', async () => {
  const { r, url } = await relayAt();
  const host = pageLink({ url, room: ROOM, name: 'Nick', create: true, peer: 'peer-host-1' });
  await wait(() => host.lastState() === 'joined');
  const tab2 = pageLink({ url, room: ROOM, name: 'Nick', hostKey: host.link.hostKey, peer: 'peer-host-2' });
  await wait(() => tab2.lastState() === 'joined' && host.lastState() === 'over');
  assert.equal(host.states.at(-1)[1].why, 'replaced');
  assert.equal(tab2.link.isHost, true);
  const wrong = pageLink({ url, room: ROOM, name: 'Eve', hostKey: 'w'.repeat(43), peer: 'peer-eve-1' });
  await wait(() => wrong.lastState() === 'joined');
  assert.ok(wrong.states.some(([s]) => s === 'not-host'));
  assert.equal(wrong.link.isHost, false);
  tab2.link.stop(); wrong.link.stop();
  await r.close();
});

test('"peer taken" (the relay still holds this page\'s old connection): a new peer id, and the page is told', async () => {
  const { r, url } = await relayAt();
  const host = pageLink({ url, room: ROOM, name: 'Nick', create: true, peer: 'peer-host-1' });
  await wait(() => host.lastState() === 'joined');
  const a = pageLink({ url, room: ROOM, name: 'Robin', peer: 'peer-same-1' });
  await wait(() => a.lastState() === 'joined');
  const b = pageLink({ url, room: ROOM, name: 'Robin', peer: 'peer-same-1', makePeerId: () => 'peer-fresh-1' });
  await wait(() => b.lastState() === 'joined');
  assert.deepEqual(b.selves, ['peer-fresh-1']);
  assert.equal(b.link.peer, 'peer-fresh-1');
  for (const p of [host, a, b]) p.link.stop();
  await r.close();
});

test('a dropped connection comes back by itself with the same peer id (so the others\' direct connections carry on)', async () => {
  const { r, url } = await relayAt();
  const host = pageLink({ url, room: ROOM, name: 'Nick', create: true, peer: 'peer-host-1' });
  await wait(() => host.lastState() === 'joined');
  const g = pageLink({ url, room: ROOM, name: 'Robin', peer: 'peer-guest-1' });
  await wait(() => g.lastState() === 'joined');
  g.link.blip();
  await wait(() => g.states.filter(([s]) => s === 'joined').length === 2);
  assert.equal(g.link.peer, 'peer-guest-1');
  assert.deepEqual(g.selves, []);
  host.link.stop(); g.link.stop();
  await r.close();
});
