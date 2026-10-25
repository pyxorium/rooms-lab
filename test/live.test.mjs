// Live tiles (src/live.js) on their own: the envelope, the checks, the hub's one order and limits, and three
// pages wired together in memory (the host's page as the hub).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_UP, LIVE_DOWN, LIMITS, readFromTile, readPeerLive, jsonData, createHub, bucket, newCopyId, isCopyId, createLiveTiles,
} from '../src/live.js';

const TILE = 'at://did:plc:6vxjigxrqizmbo56gojxico3/ing.dasl.masl/3mpolltile22';
const OTHER = 'at://did:plc:6vxjigxrqizmbo56gojxico3/ing.dasl.masl/3motherone22';
const clock = () => { let t = 1_000_000; return { now: () => t, tick: (ms) => { t += ms; } }; };

test('a copy id: 16 letters and digits, random', () => {
  const a = newCopyId(), b = newCopyId();
  assert.match(a, /^[a-z0-9]{16}$/);
  assert.notEqual(a, b);
  assert.ok(isCopyId(a));
  for (const x of ['short', 'UPPERCASEUPPERCASE', 'did:plc:abcdefghijklmnop', 42, null]) assert.equal(isCopyId(x), false, String(x));
});

test('what a tile may send: hello, or send with plain JSON up to 16 KB', () => {
  assert.deepEqual(readFromTile({ v: 1, kind: 'hello' }), { kind: 'hello' });
  assert.deepEqual(readFromTile({ v: 1, kind: 'send', data: { t: 'vote', option: 2 } }), { kind: 'send', data: { t: 'vote', option: 2 }, text: '{"t":"vote","option":2}' });
  assert.equal(readFromTile({ v: 1, kind: 'send', data: 'x'.repeat(17000) }).reason, 'size');
  const loop = {}; loop.loop = loop;
  assert.equal(readFromTile({ v: 1, kind: 'send', data: loop }).reason, 'json');
  assert.equal(readFromTile({ v: 1, kind: 'send', data: undefined }).reason, 'json');
  assert.equal(readFromTile({ v: 1, kind: 'send', data: () => 1 }).reason, 'json');
  assert.match(readFromTile({ v: 1, kind: 'message', n: 1 }).drop, /may not send/);
  assert.match(readFromTile({ v: 2, kind: 'hello' }).drop, /not a live message/);
  assert.match(readFromTile(null).drop, /not a live message/);
  assert.deepEqual(jsonData({ when: new Date(0) }).data, { when: '1970-01-01T00:00:00.000Z' }, 'what goes out is plain JSON');
});

test('between pages: only the six live kinds, each checked', () => {
  const id = 'abcdefghijklmnop';
  assert.deepEqual(readPeerLive({ kind: 'live-join', uri: TILE, id }), { kind: 'live-join', uri: TILE, id });
  assert.equal(readPeerLive({ kind: 'live-join', uri: TILE, id: 'Robin' }), null, 'never a name');
  assert.equal(readPeerLive({ kind: 'live-join', uri: 'https://x', id }), null);
  assert.deepEqual(readPeerLive({ kind: 'live-send', uri: TILE, data: [1, 2] }).data, [1, 2]);
  assert.equal(readPeerLive({ kind: 'live-send', uri: TILE, data: 'x'.repeat(17000) }), null);
  assert.deepEqual(readPeerLive({ kind: 'live-msg', uri: TILE, n: 3, from: id, data: 'hi' }), { kind: 'live-msg', uri: TILE, n: 3, from: id, data: 'hi' });
  assert.equal(readPeerLive({ kind: 'live-msg', uri: TILE, n: 0, from: id, data: 'hi' }), null);
  assert.equal(readPeerLive({ kind: 'live-msg', uri: TILE, n: 1, from: 'x', data: 'hi' }), null);
  assert.deepEqual(readPeerLive({ kind: 'live-here', uri: TILE, here: [id], joined: [id] }), { kind: 'live-here', uri: TILE, here: [id], joined: [id] });
  assert.equal(readPeerLive({ kind: 'live-here', uri: TILE, here: [id], joined: ['zzzzzzzzzzzzzzzz'] }), null, 'joined: only ids that are here');
  assert.equal(readPeerLive({ kind: 'live-here', uri: TILE, here: Array(7).fill(id) }), null, 'six at most');
  assert.deepEqual(readPeerLive({ kind: 'live-limit', uri: TILE, reason: 'rate' }), { kind: 'live-limit', uri: TILE, reason: 'rate' });
  assert.equal(readPeerLive({ kind: 'live-limit', uri: TILE, reason: 'because' }), null);
  assert.equal(readPeerLive({ kind: 'rtc', uri: TILE }), null);
  assert.equal(readPeerLive([]), null);
});

test('the hub numbers every message in one order, names the sender by copy id only, and keeps nothing', () => {
  const c = clock();
  const hub = createHub({ now: c.now });
  hub.open(TILE);
  assert.equal(hub.join(TILE, 'nick-peer', 'nnnnnnnnnnnnnnnn'), true);
  assert.equal(hub.join(TILE, 'robin-peer', 'rrrrrrrrrrrrrrrr'), true);
  assert.equal(hub.join(TILE, 'robin-peer', 'rrrrrrrrrrrrrrrr'), false, 'rejoining with the same id changes nothing');
  assert.equal(hub.join(TILE, 'ted-peer', 'rrrrrrrrrrrrrrrr'), false, 'nobody takes another page\'s id');
  assert.deepEqual(hub.ids(TILE), ['nnnnnnnnnnnnnnnn', 'rrrrrrrrrrrrrrrr']);
  const a = hub.send(TILE, 'robin-peer', '"a"', 'a');
  const b = hub.send(TILE, 'nick-peer', '"b"', 'b');
  assert.deepEqual(a.msg, { n: 1, from: 'rrrrrrrrrrrrrrrr', data: 'a' });
  assert.deepEqual(b.msg, { n: 2, from: 'nnnnnnnnnnnnnnnn', data: 'b' });
  assert.equal(hub.send(TILE, 'ted-peer', '"x"', 'x').reason, 'connection', 'not a member: nothing numbered');
  assert.equal(hub.send(OTHER, 'robin-peer', '"x"', 'x').reason, 'connection', 'not a live tile');
  assert.equal(hub.send(TILE, 'robin-peer', JSON.stringify('x'.repeat(17000)), 'x').reason, 'size');
  assert.equal(hub.send(TILE, 'robin-peer', '"c"', 'c').msg.n, 3, 'refused messages take no number');
  hub.close(TILE);
  assert.equal(hub.isOpen(TILE), false);
  hub.open(TILE);
  assert.deepEqual(hub.ids(TILE), [], 'closing forgets everything');
});

test('limits: 10 a second per copy with bursts of 30; the room\'s 60 a second and 128 KB a second', () => {
  const c = clock();
  const hub = createHub({ now: c.now });
  hub.open(TILE);
  const pages = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => `${x}-peer`);
  pages.forEach((p, i) => hub.join(TILE, p, String(i).repeat(16)));
  let ok = 0;
  for (let i = 0; i < 40; i++) if (hub.send(TILE, 'a-peer', '1', 1).msg) ok++;
  assert.equal(ok, 30, 'a burst of 30');
  assert.equal(hub.send(TILE, 'a-peer', '1', 1).reason, 'rate');
  c.tick(1000);
  ok = 0;
  for (let i = 0; i < 20; i++) if (hub.send(TILE, 'a-peer', '1', 1).msg) ok++;
  assert.equal(ok, 10, 'then 10 a second');
  // the room: everyone at once, well past 60 a second
  const c2 = clock();
  const hub2 = createHub({ now: c2.now });
  hub2.open(TILE);
  pages.forEach((p, i) => hub2.join(TILE, p, String(i).repeat(16)));
  const reasons = new Map();
  for (let i = 0; i < 30; i++) for (const p of pages) { const r = hub2.send(TILE, p, '1', 1); reasons.set(r.reason || 'ok', (reasons.get(r.reason || 'ok') || 0) + 1); }
  assert.equal(reasons.get('ok'), LIMITS.room.burst, 'the room budget stops it first');
  assert.equal(reasons.get('room'), 180 - LIMITS.room.burst);
  // bytes: 16 KB messages, 8 in a burst (128 KB), then the room says no
  const c3 = clock();
  const hub3 = createHub({ now: c3.now });
  hub3.open(TILE);
  pages.forEach((p, i) => hub3.join(TILE, p, String(i).repeat(16)));
  const big = JSON.stringify('x'.repeat(16 * 1024 - 2));
  let sent = 0;
  for (let i = 0; i < 12; i++) if (hub3.send(TILE, pages[i % 6], big, 'x').msg) sent++;
  assert.equal(sent, 8);
});

test('a bucket refills over time', () => {
  const c = clock();
  const b = bucket({ perSecond: 2, burst: 2 }, c.now);
  assert.equal(b.take(), true); assert.equal(b.take(), true); assert.equal(b.take(), false);
  c.tick(500); assert.equal(b.take(), true); assert.equal(b.take(), false);
});

// ---- Three pages in memory: Nick (host), Robin, Ted ----
function fakeWin() {
  const ls = new Set();
  return { addEventListener: (t, f) => ls.add(f), removeEventListener: (t, f) => ls.delete(f), fire: (e) => ls.forEach((f) => f(e)) };
}
function fakeFrame() {
  const got = [];
  const contentWindow = { postMessage: (m) => got.push(m.payload) };
  return { contentWindow, got, last: (kind) => got.filter((p) => p.kind === kind).at(-1), all: (kind) => got.filter((p) => p.kind === kind) };
}
function world({ channels = () => true } = {}) {
  const c = clock();
  const pages = {};
  const retries = [];                     // each page's retry tick (step 9b), run by hand
  const hostAway = { v: false };
  const make = (me, host) => {
    const win = fakeWin();
    const frames = new Map();             // uri → fake frame (shared cards)
    const strip = {
      frameOf: (uri) => frames.get(uri) || null,
      uriOfSource: (src) => [...frames].find(([, f]) => f.contentWindow === src)?.[0] || null,
      isShared: (uri) => frames.has(uri),
    };
    const store = new Map();
    const live = createLiveTiles({
      win, strip, room: 'roomcode1234', session: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
      isHost: () => host, me: () => me, hostPeer: () => 'nick-peer-1', hostAway: () => hostAway.v,
      toPeer: (peer, obj) => {
        if (!channels(me, peer)) return false;
        const m = readPeerLive(JSON.parse(JSON.stringify(obj)));
        if (m) pages[peer].live.fromPeer(me, m);
        return true;
      },
      now: c.now,
      setIntervalImpl: (fn) => { retries.push(fn); return retries.length; }, clearIntervalImpl: () => {},
    });
    const tileSays = (uri, payload) => win.fire({ data: { action: LIVE_UP, payload }, source: frames.get(uri)?.contentWindow });
    return { me, live, win, frames, strip, store, tileSays, open: (uri) => { const f = fakeFrame(); frames.set(uri, f); return f; } };
  };
  pages['nick-peer-1'] = make('nick-peer-1', true);
  pages['robin-peer-1'] = make('robin-peer-1', false);
  pages['ted-peer-11'] = make('ted-peer-11', false);
  const retry = (ms = 2000) => { c.tick(ms); retries.forEach((f) => f()); };
  return { c, pages, hostAway, retry, nick: pages['nick-peer-1'], robin: pages['robin-peer-1'], ted: pages['ted-peer-11'] };
}

test('not live: a copy is a room of one (presence just you; your messages come straight back)', () => {
  const w = world();
  const f = w.robin.open(TILE);
  w.robin.tileSays(TILE, { v: 1, kind: 'hello' });
  const p = f.last('presence');
  assert.ok(isCopyId(p.you));
  assert.deepEqual(p.here, [p.you]);
  w.robin.tileSays(TILE, { v: 1, kind: 'send', data: { t: 'vote', option: 1 } });
  assert.deepEqual(f.last('message'), { v: 1, kind: 'message', n: 1, from: p.you, data: { t: 'vote', option: 1 } });
  assert.equal(w.nick.live.hub.isOpen(TILE), false, 'nothing reached the host\'s page');
  assert.equal(f.got.every((m) => m.v === 1), true);
});

test('live: every copy gets presence with everyone, and who just came in; messages come back numbered in one order, the sender\'s too', () => {
  const w = world();
  const fn = w.nick.open(TILE), fr = w.robin.open(TILE), ft = w.ted.open(TILE);
  for (const p of [w.nick, w.robin, w.ted]) p.tileSays(TILE, { v: 1, kind: 'hello' });
  for (const p of [w.nick, w.robin, w.ted]) p.live.setLive(TILE, true);
  const ids = [fn, fr, ft].map((f) => f.last('presence').you);
  for (const f of [fn, fr, ft]) assert.deepEqual([...f.last('presence').here].sort(), [...ids].sort());
  assert.deepEqual(fn.last('presence').joined, [ids[2]], 'Ted came in last: everyone hears so');
  assert.deepEqual(fr.last('presence').joined, [ids[2]]);
  assert.deepEqual(fn.all('presence').filter((p) => p.joined).map((p) => p.joined[0]), ids, 'Nick\'s copy heard of itself, Robin, then Ted');
  w.robin.tileSays(TILE, { v: 1, kind: 'send', data: 'from robin' });
  w.ted.tileSays(TILE, { v: 1, kind: 'send', data: 'from ted' });
  w.nick.tileSays(TILE, { v: 1, kind: 'send', data: 'from nick' });
  const seq = (f) => f.all('message').map((m) => `${m.n}:${m.data}`);
  assert.deepEqual(seq(fr), ['1:from robin', '2:from ted', '3:from nick']);
  assert.deepEqual(seq(ft), seq(fr));
  assert.deepEqual(seq(fn), seq(fr));
  assert.equal(fr.all('message')[0].from, ids[1], 'the sender is named by its copy id');
  // the copy ids aren't the pages' ids and differ per tile and room
  assert.ok(!ids.some((id) => id.includes('peer')));
  assert.equal(w.robin.live.idOf(TILE), ids[1], 'one id per person, per tile, per room (kept for a reload)');
  assert.notEqual(w.robin.live.idOf(OTHER), ids[1]);
});

test('a guest\'s page can\'t speak for the host: live messages from anyone else are ignored', () => {
  const w = world();
  const fr = w.robin.open(TILE);
  w.robin.tileSays(TILE, { v: 1, kind: 'hello' });
  w.robin.live.setLive(TILE, true);
  const before = fr.got.length;
  w.robin.live.fromPeer('ted-peer-11', { kind: 'live-msg', uri: TILE, n: 9, from: 'tttttttttttttttt', data: 'forged' });
  w.robin.live.fromPeer('ted-peer-11', { kind: 'live-here', uri: TILE, here: ['tttttttttttttttt'] });
  assert.equal(fr.got.length, before);
  // and a host page only takes joins and sends for live tiles, from members
  w.nick.live.fromPeer('ted-peer-11', { kind: 'live-send', uri: TILE, data: 'not live yet', text: '"not live yet"' });
  assert.equal(w.nick.live.hub.isOpen(TILE), false);
});

test('only copies of the same tile: a live tile\'s messages never reach another tile', () => {
  const w = world();
  const a = w.robin.open(TILE), b = w.robin.open(OTHER), na = w.nick.open(TILE), nb = w.nick.open(OTHER);
  for (const p of [w.nick, w.robin]) { p.tileSays(TILE, { v: 1, kind: 'hello' }); p.tileSays(OTHER, { v: 1, kind: 'hello' }); p.live.setLive(TILE, true); }
  w.nick.tileSays(TILE, { v: 1, kind: 'send', data: 'poll' });
  assert.equal(a.all('message').length, 1);
  assert.equal(b.all('message').length, 0);
  assert.equal(nb.all('message').length, 0);
  w.robin.tileSays(OTHER, { v: 1, kind: 'send', data: 'mine' });
  assert.deepEqual(b.last('message').data, 'mine', 'the not-live tile stays a room of one');
  assert.equal(na.all('message').length, 1);
});

test('limits reach the sender\'s copy as "limit"; nothing numbered', () => {
  const w = world();
  const fr = w.robin.open(TILE), fn = w.nick.open(TILE);
  for (const p of [w.nick, w.robin]) { p.tileSays(TILE, { v: 1, kind: 'hello' }); p.live.setLive(TILE, true); }
  w.robin.tileSays(TILE, { v: 1, kind: 'send', data: 'x'.repeat(17000) });
  assert.equal(fr.last('limit').reason, 'size');
  for (let i = 0; i < 31; i++) w.robin.tileSays(TILE, { v: 1, kind: 'send', data: i });
  assert.equal(fr.last('limit').reason, 'rate');
  assert.equal(fn.all('message').length, 30);
});

test('stop sharing live: each copy is just itself again and keeps what it has; nothing more goes out', () => {
  const w = world();
  const fr = w.robin.open(TILE), fn = w.nick.open(TILE);
  for (const p of [w.nick, w.robin]) { p.tileSays(TILE, { v: 1, kind: 'hello' }); p.live.setLive(TILE, true); }
  for (const p of [w.nick, w.robin]) p.live.setLive(TILE, false);
  const you = fr.last('presence').you;
  assert.deepEqual(fr.last('presence').here, [you]);
  const n = fn.all('message').length;
  w.robin.tileSays(TILE, { v: 1, kind: 'send', data: 'alone' });
  assert.equal(fn.all('message').length, n, 'the host\'s copy hears nothing');
  assert.equal(fr.last('message').data, 'alone', 'Robin\'s copy, a room of one');
  assert.equal(fr.all('message').some((m) => m.kind === 'reset'), false);
});

test('the host away: live copies pause (sending says "paused"), then resume and rejoin', () => {
  const w = world();
  const fr = w.robin.open(TILE), fn = w.nick.open(TILE);
  for (const p of [w.nick, w.robin]) { p.tileSays(TILE, { v: 1, kind: 'hello' }); p.live.setLive(TILE, true); }
  w.robin.live.setPaused(true);
  assert.ok(fr.last('paused'));
  w.robin.tileSays(TILE, { v: 1, kind: 'send', data: 'hello?' });
  assert.equal(fr.last('limit').reason, 'paused');
  w.robin.live.setPaused(false);
  assert.ok(fr.last('resumed'));
  w.robin.tileSays(TILE, { v: 1, kind: 'send', data: 'back' });
  assert.equal(fn.last('message').data, 'back');
});

test('a guest who leaves is dropped from the list; a copy hidden on one page leaves', () => {
  const w = world();
  const fr = w.robin.open(TILE), fn = w.nick.open(TILE), ft = w.ted.open(TILE);
  for (const p of [w.nick, w.robin, w.ted]) { p.tileSays(TILE, { v: 1, kind: 'hello' }); p.live.setLive(TILE, true); }
  assert.equal(fn.last('presence').here.length, 3);
  w.nick.live.peerGone('ted-peer-11');
  assert.equal(fn.last('presence').here.length, 2);
  w.robin.frames.delete(TILE);
  w.robin.live.removed(TILE);
  assert.equal(fn.last('presence').here.length, 1);
  assert.equal(fn.last('presence').joined, undefined, 'leaving names nobody as joined');
  assert.ok(fr);
  assert.ok(ft);
});

test('no direct connection to the host: the guest\'s copy hears "connection" and stays a room of one', () => {
  const w = world({ channels: (from, to) => !(from === 'robin-peer-1' || to === 'robin-peer-1') });
  const fr = w.robin.open(TILE), fn = w.nick.open(TILE);
  for (const p of [w.nick, w.robin]) { p.tileSays(TILE, { v: 1, kind: 'hello' }); p.live.setLive(TILE, true); }
  const you = fr.last('presence').you;
  assert.deepEqual(fr.last('presence').here, [you]);
  w.robin.tileSays(TILE, { v: 1, kind: 'send', data: 'x' });
  assert.equal(fr.last('limit').reason, 'connection');
  assert.equal(fn.all('message').length, 0);
});

test('a frame that isn\'t a tile on the strip, or not speaking v1, is ignored', () => {
  const w = world();
  const fr = w.robin.open(TILE);
  w.robin.win.fire({ data: { action: LIVE_UP, payload: { v: 1, kind: 'hello' } }, source: { postMessage() {} } });
  assert.equal(fr.got.length, 0);
  w.robin.tileSays(TILE, { v: 2, kind: 'hello' });
  assert.equal(fr.got.length, 0);
  w.robin.tileSays(TILE, { v: 1, kind: 'send', data: 1 });
  assert.equal(fr.got.length, 0, 'a copy that never said hello gets nothing');
  assert.equal(LIVE_DOWN, 'tiles-protocol-down-live-payload');
  assert.equal(LIVE_UP, 'tiles-protocol-up-live-payload');
});

test('step 9b: a guest\'s join that got lost goes out again until the host counts it; "joining" shows only after a while', () => {
  let drop = 1;                           // the first live-join from Robin to Nick is lost (the owner's phone, Oct 25)
  const w = world({ channels: (from, to) => !(from === 'robin-peer-1' && to === 'nick-peer-1' && drop-- > 0) });
  const fn = w.nick.open(TILE), fr = w.robin.open(TILE);
  for (const p of [w.nick, w.robin]) p.tileSays(TILE, { v: 1, kind: 'hello' });
  for (const p of [w.nick, w.robin]) p.live.setLive(TILE, true);
  assert.equal(w.nick.live.hub.ids(TILE).length, 1, 'the host counts only itself (Live · 1)');
  assert.deepEqual(fr.last('presence').here, [fr.last('presence').you], 'Robin\'s copy: just you');
  assert.equal(w.robin.live.joining(TILE), false, 'not yet: a normal join takes a moment');
  w.c.tick(2600);
  assert.equal(w.robin.live.joining(TILE), true, 'after a while: "Joining the live room…"');
  assert.equal(w.nick.live.joining(TILE), false, 'never on the host\'s page');
  w.retry();
  assert.equal(w.nick.live.hub.ids(TILE).length, 2, 'asked again: counted');
  assert.equal(fr.last('presence').here.length, 2);
  assert.equal(fn.last('presence').here.length, 2);
  assert.equal(w.robin.live.joining(TILE), false);
});

test('step 9b: the host\'s answer got lost: a repeated join from a page it already counts gets the list again', () => {
  let drop = 1;                           // the first live-here from Nick to Robin is lost
  const w = world({ channels: (from, to) => !(from === 'nick-peer-1' && to === 'robin-peer-1' && drop-- > 0) });
  w.nick.open(TILE); const fr = w.robin.open(TILE);
  for (const p of [w.nick, w.robin]) p.tileSays(TILE, { v: 1, kind: 'hello' });
  for (const p of [w.nick, w.robin]) p.live.setLive(TILE, true);
  assert.equal(w.nick.live.hub.ids(TILE).length, 2, 'the host counts Robin');
  assert.equal(w.robin.live.joined(TILE), false, 'but Robin never heard');
  w.retry();
  assert.equal(w.robin.live.joined(TILE), true, 'the repeated join brought the list back');
  assert.equal(fr.last('presence').here.length, 2);
  assert.equal(w.nick.live.hub.ids(TILE).length, 2, 'still two (no double count)');
});

test('step 9b: once counted, nothing more goes out; a page with no connection keeps trying quietly', () => {
  const sent = [];
  const w = world({ channels: (from, to) => { if (from === 'ted-peer-11') sent.push(to); return from !== 'ted-peer-11'; } });
  w.nick.open(TILE); w.robin.open(TILE); w.ted.open(TILE);
  for (const p of [w.nick, w.robin, w.ted]) { p.tileSays(TILE, { v: 1, kind: 'hello' }); p.live.setLive(TILE, true); }
  const robinJoinsBefore = w.nick.live.hub.ids(TILE).length;
  const n = sent.length;
  w.retry(); w.retry();
  assert.equal(w.nick.live.hub.ids(TILE).length, robinJoinsBefore, 'Robin (counted) asked nothing again');
  assert.equal(sent.length, n + 2, 'Ted (no connection) asks every tick');
  assert.equal(w.ted.live.joining(TILE), true);
  w.ted.live.setLive(TILE, false);
  w.retry();
  assert.equal(sent.length, n + 2, 'not live any more: no more asking');
  assert.equal(w.ted.live.joining(TILE), false);
});
