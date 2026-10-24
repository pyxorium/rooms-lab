// The host's page holding the house (src/house-bridge.js), with a stand-in frame and window: the fixed
// routing rules, the fallback when there's no house or it goes quiet, and the real house's rules wired in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHouseBridge, readFromHouse, fallbackRule, UP, DOWN } from '../src/house-bridge.js';
import { decide, WISHES } from '../tiles/house/rules.js';
const TILE = 'at://did:plc:6vxjigxrqizmbo56gojxico3/ing.dasl.masl/3myfnyphiuw2t';

const STATE = { host: 'host-peer-1', presenter: null, peers: [{ peer: 'host-peer-1', name: 'Nick', host: true }, { peer: 'robin-peer-1', name: 'Robin', host: false }, { peer: 'ted-peer-11', name: 'Ted', host: false }] };
const env = (kind, extra = {}) => ({ game: 'rooms', v: 1, kind, ...extra });

// A stand-in window and frame. `house(payload, reply)` plays the tile: it gets what the page posts.
function stage(house = () => {}) {
  const listeners = new Set();
  const win = { addEventListener: (t, f) => listeners.add(f), removeEventListener: (t, f) => listeners.delete(f) };
  const sent = [];
  const frameWin = {};
  const reply = (payload, source = frameWin) => { for (const f of listeners) f({ source, data: { action: UP, payload } }); };
  frameWin.postMessage = (msg) => { sent.push(msg); queueMicrotask(() => house(msg.payload, reply)); };
  const frame = { contentWindow: frameWin, remove() { this.removed = true; } };
  return { win, frame, sent, reply, listeners };
}
const logs = () => { const l = []; return { l, onLog: (what, text) => l.push(`${what}: ${text}`) }; };

test('no house: the page\'s own rule, "the host approves each request"', async () => {
  const b = createHouseBridge({ makeFrame: null });
  await b.start();
  assert.equal(b.status, 'off');
  assert.deepEqual(await b.decide(STATE, { by: 'robin-peer-1', wish: 'present' }), { decision: 'ask-host', reason: 'The host approves each request.', by: 'page' });
  assert.equal((await b.decide(STATE, { by: 'host-peer-1', wish: 'present' })).decision, 'allow');
  assert.equal((await b.decide(STATE, { by: 'robin-peer-1', wish: 'see-screen', target: 'host-peer-1' })).decision, 'allow');
  assert.equal(fallbackRule(STATE, { by: 'robin-peer-1', wish: 'see-screen', target: 'ted-peer-11' }).decision, 'ask-host');
});

test('the house says hello, gets the room\'s state, and decides with its own rules (the real rules.js behind a stand-in frame)', async () => {
  const s = stage((p, reply) => {
    if (p.from !== 'page') return;
    if (p.kind === 'wish') reply(env('rule', { id: p.id, ...decide(s.lastState, p) }));
    if (p.kind === 'state') s.lastState = p;
  });
  const { l, onLog } = logs();
  const b = createHouseBridge({ makeFrame: async () => s.frame, win: s.win, onLog });
  await b.start();
  assert.equal(b.status, 'loading');
  s.reply(env('hello', { rules: 'host-approves', wishes: WISHES }));
  assert.equal(b.status, 'ready');
  assert.equal(b.rules, 'host-approves');
  assert.deepEqual(b.wishes, ['see-screen', 'present', 'open-tile', 'live']);
  const live = await b.decide(STATE, { by: 'robin-peer-1', wish: 'live', uri: TILE });
  assert.deepEqual(live, { decision: 'ask-host', reason: 'The host approves tiles shared live.', by: 'house' });
  const a = await b.decide(STATE, { by: 'robin-peer-1', wish: 'see-screen', target: 'ted-peer-11' });
  assert.deepEqual(a, { decision: 'ask-host', reason: 'The host approves screen requests.', by: 'house' });
  const wishMsg = s.sent.find((m) => m.payload.kind === 'wish');
  assert.equal(wishMsg.action, DOWN);
  assert.equal(wishMsg.payload.from, 'page', 'the page stamps what it sends');
  assert.equal(wishMsg.payload.by, 'robin-peer-1', 'and the asker travels as "by"');
  assert.match(wishMsg.payload.id, /^w\d+$/, 'the page\'s own id, not the asker\'s');
  assert.ok(s.sent.some((m) => m.payload.kind === 'state' && m.payload.peers.length === 3));
  assert.ok(l.some((x) => x.startsWith('ready')));
  b.stop();
  assert.equal(s.frame.removed, true);
});

test('fixed rules: only hello, pong and rule from the house; a rule must answer a wish the page asked; only allow, deny or ask-host', () => {
  const asked = (id) => id === 'w1';
  assert.deepEqual(readFromHouse(env('rule', { id: 'w1', decision: 'allow', reason: 'ok' }), { asked }), { kind: 'rule', id: 'w1', decision: 'allow', reason: 'ok' });
  assert.match(readFromHouse(env('rule', { id: 'w9', decision: 'allow' }), { asked }).drop, /no wish the page asked/);
  assert.match(readFromHouse(env('rule', { id: 'w1', decision: 'share-now' }), { asked }).drop, /not allow, deny or ask-host/);
  assert.match(readFromHouse(env('ask-screen', { id: 'w1' }), { asked }).drop, /may not send "ask-screen"/);
  assert.match(readFromHouse(env('go-ahead'), { asked }).drop, /may not send/);
  assert.match(readFromHouse({ game: 'daisy', v: 1, kind: 'hello' }).drop, /not a Rooms message/);
  assert.match(readFromHouse(env('hello', { pad: 'x'.repeat(9000) })).drop, /too big/);
  assert.equal(readFromHouse(env('rule', { id: 'w1', decision: 'deny', reason: 'r'.repeat(500) }), { asked }).reason.length, 200);
});

test('messages from other frames, or that break the rules, are dropped (and logged), never decide anything', async () => {
  const s = stage();
  const { l, onLog } = logs();
  const b = createHouseBridge({ makeFrame: async () => s.frame, win: s.win, onLog, times: { helloMs: 5000, answerMs: 200 } });
  await b.start();
  s.reply(env('hello', { rules: 'x' }), {});                          // another frame: ignored entirely
  assert.equal(b.status, 'loading');
  s.reply(env('hello', { rules: 'host-approves' }));
  const p = b.decide(STATE, { by: 'robin-peer-1', wish: 'present' });
  s.reply(env('rule', { id: 'w1', decision: 'allow', reason: 'from elsewhere' }), {});   // not the house's frame
  s.reply(env('rule', { id: 'w7', decision: 'allow' }));               // no such wish
  s.reply(env('go-ahead', { id: 'w1' }));                              // not the house's to send
  const a = await p;
  assert.equal(a.by, 'page', 'nothing valid came: the page\'s fallback after the wait');
  assert.equal(a.decision, 'ask-host');
  assert.ok(l.some((x) => /no wish the page asked/.test(x)));
  assert.ok(l.some((x) => /may not send "go-ahead"/.test(x)));
  assert.ok(l.some((x) => x.startsWith('timeout')));
  b.stop();
});

test('a house that never says hello: failed, and the page decides', async () => {
  const s = stage();
  const b = createHouseBridge({ makeFrame: async () => s.frame, win: s.win, times: { helloMs: 50, answerMs: 50 } });
  await b.start();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(b.status, 'failed');
  assert.equal((await b.decide(STATE, { by: 'robin-peer-1', wish: 'present' })).by, 'page');
  const nothing = createHouseBridge({ makeFrame: async () => { throw new Error('no loader'); }, win: s.win });
  await nothing.start();
  assert.equal(nothing.status, 'failed');
});

test('a late rule (after the page gave up waiting) changes nothing', async () => {
  let held = null;
  const s = stage((p, reply) => { if (p.kind === 'wish') held = () => reply(env('rule', { id: p.id, decision: 'allow', reason: 'late' })); });
  const { l, onLog } = logs();
  const b = createHouseBridge({ makeFrame: async () => s.frame, win: s.win, onLog, times: { helloMs: 1000, answerMs: 30 } });
  await b.start();
  s.reply(env('hello', { rules: 'host-approves' }));
  const a = await b.decide(STATE, { by: 'robin-peer-1', wish: 'present' });
  assert.equal(a.by, 'page');
  held();
  assert.ok(l.some((x) => /no wish the page asked/.test(x)));
  b.stop();
});

test('too many messages from the house are dropped', async () => {
  const s = stage();
  const { l, onLog } = logs();
  let t = 0;
  const b = createHouseBridge({ makeFrame: async () => s.frame, win: s.win, onLog, now: () => t, limits: { maxBytes: 8192, burst: 3, perSecond: 1 } });
  await b.start();
  for (let i = 0; i < 6; i++) s.reply(env('pong'));
  assert.equal(l.filter((x) => /too many/.test(x)).length, 3);
  b.stop();
});

test('a house decides only the wishes its hello lists; the first house (no list) knows three, and the page decides live itself', async () => {
  for (const [hello, liveBy] of [[{ rules: 'host-approves' }, 'page'], [{ rules: 'host-approves', wishes: ['see-screen', 'present', 'open-tile'] }, 'page'], [{ rules: 'host-approves', wishes: WISHES }, 'house']]) {
    const s = stage((p, reply) => {
      if (p.from !== 'page') return;
      if (p.kind === 'wish') reply(env('rule', { id: p.id, ...decide(s.lastState, p) }));
      if (p.kind === 'state') s.lastState = p;
    });
    const b = createHouseBridge({ makeFrame: async () => s.frame, win: s.win });
    await b.start();
    s.reply(env('hello', hello));
    const guest = await b.decide(STATE, { by: 'robin-peer-1', wish: 'live', uri: TILE });
    const host = await b.decide(STATE, { by: STATE.host, wish: 'live', uri: TILE });
    assert.equal(guest.by, liveBy, JSON.stringify(hello));
    assert.equal(guest.decision, 'ask-host', 'a guest asking to share live: the host approves, house or not');
    assert.equal(host.decision, 'allow', 'the host\'s own: allowed, house or not');
    if (liveBy === 'page') assert.equal(guest.unknown, true, 'the page says the house doesn\'t decide this one');
    assert.equal((await b.decide(STATE, { by: 'robin-peer-1', wish: 'present' })).by, 'house', 'the first three still go to the house');
    b.stop();
  }
  assert.deepEqual(readFromHouse(env('hello', { rules: 'x', wishes: ['live', 'BAD!', 42, 'present'] })).wishes, ['live', 'present'], 'odd names dropped');
});
