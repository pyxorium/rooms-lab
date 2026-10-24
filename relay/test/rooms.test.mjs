// The relay's rules (rooms.js) on their own, with a clock the tests move: joining, the list of people,
// messages to one person and to everyone, the host's powers, the grace period, limits, rooms vanishing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRooms, LIMITS, CLOSE, cleanName, isRoomCode } from '../rooms.js';

const ROOM = 'k7q3m2xw9aZ4';
const KEY = 'h'.repeat(43);

// A little world: a clock, the rules, and connections that remember what they were sent.
function world(opts = {}) {
  let t = 1_000_000;
  const rooms = createRooms({ now: () => t, makeHostKey: () => KEY, ...opts });
  const inbox = new Map();
  const closed = new Map();
  const apply = (out) => {
    for (const o of out) {
      if (o.close) closed.set(o.conn, o.close.code);
      else inbox.get(o.conn).push(o.msg);
    }
    return out;
  };
  const conn = (label) => {
    const c = { label };
    inbox.set(c, []);
    rooms.open(c);
    return c;
  };
  return {
    rooms,
    tick: (ms) => { t += ms; },
    conn,
    say: (c, m) => apply(rooms.receive(c, typeof m === 'string' ? m : JSON.stringify(m))),
    drop: (c) => apply(rooms.close(c)),
    sweep: () => apply(rooms.sweep()),
    take: (c) => inbox.get(c).splice(0),               // everything c was sent since last time
    last: (c) => inbox.get(c).at(-1),
    closedWith: (c) => closed.get(c),
  };
}

// The host makes a room; guests join it. Returns the connections.
function room(w, ...guests) {
  const host = w.conn('host');
  w.say(host, { t: 'join', room: ROOM, peer: 'peer-host-1', name: 'Nick', create: true });
  const gs = guests.map((name, i) => {
    const g = w.conn(name);
    w.say(g, { t: 'join', room: ROOM, peer: `peer-guest-${i + 1}`, name });
    return g;
  });
  for (const c of [host, ...gs]) w.take(c);
  return [host, ...gs];
}

test('creating a room: the host gets a host key, and sees itself in the list', () => {
  const w = world();
  const host = w.conn('host');
  w.say(host, { t: 'join', room: ROOM, peer: 'peer-host-1', name: '  Nick  ', create: true });
  assert.deepEqual(w.take(host), [
    { t: 'joined', room: ROOM, peer: 'peer-host-1', host: true, hostKey: KEY },
    { t: 'peers', list: [{ peer: 'peer-host-1', name: 'Nick', host: true }] },
  ]);
  assert.deepEqual(w.rooms.stats(), { rooms: 1, connections: 1 });
});

test('the real host key is random, 43 characters, different each time', () => {
  const keys = new Set();
  for (let i = 0; i < 5; i++) {
    const rooms = createRooms();
    rooms.open('c');
    const out = rooms.receive('c', JSON.stringify({ t: 'join', room: ROOM, peer: 'peer-host-1', name: 'Nick', create: true }));
    keys.add(out[0].msg.hostKey);
  }
  assert.equal(keys.size, 5);
  for (const k of keys) assert.match(k, /^[A-Za-z0-9_-]{43}$/);
});

test('joining: a guest gets no host key; everyone gets the new list of people (who\'s here)', () => {
  const w = world();
  const [host] = room(w);
  const g = w.conn('g');
  w.say(g, { t: 'join', room: ROOM, peer: 'peer-guest-1', name: 'Robin' });
  const list = [{ peer: 'peer-host-1', name: 'Nick', host: true }, { peer: 'peer-guest-1', name: 'Robin', host: false }];
  assert.deepEqual(w.take(g), [{ t: 'joined', room: ROOM, peer: 'peer-guest-1', host: false }, { t: 'peers', list }]);
  assert.deepEqual(w.take(host), [{ t: 'peers', list }]);
});

test('joining refusals: no room, room taken, bad room code, peer id, name, host key; already joined', () => {
  const w = world();
  room(w, 'Robin');
  const c = w.conn('c');
  const why = (m) => { w.say(c, m); return w.last(c).why; };
  assert.equal(why({ t: 'join', room: 'nosuchroom123', peer: 'peer-x-0001', name: 'X' }), 'no room');
  assert.equal(why({ t: 'join', room: ROOM, peer: 'peer-x-0001', name: 'X', create: true }), 'room taken');
  assert.equal(why({ t: 'join', room: 'short', peer: 'peer-x-0001', name: 'X' }), 'room');
  assert.equal(why({ t: 'join', room: 'has space in it', peer: 'peer-x-0001', name: 'X' }), 'room');
  assert.equal(why({ t: 'join', room: ROOM, peer: 'p', name: 'X' }), 'peer');
  assert.equal(why({ t: 'join', room: ROOM, peer: 'peer-x-0001', name: '   ' }), 'name');
  assert.equal(why({ t: 'join', room: ROOM, peer: 'peer-x-0001', name: 'x'.repeat(41) }), 'name');
  assert.equal(why({ t: 'join', room: ROOM, peer: 'peer-x-0001', name: 'a\nb' }), 'name');
  assert.equal(why({ t: 'join', room: ROOM, peer: 'peer-x-0001', name: 42 }), 'name');
  assert.equal(why({ t: 'join', room: ROOM, peer: 'peer-x-0001', name: 'X', hostKey: 'short' }), 'host key');
  assert.equal(why({ t: 'join', room: ROOM, peer: 'peer-x-0001', name: 'X', hostKey: 'w'.repeat(43) }), 'host key');
  assert.equal(why({ t: 'join', room: ROOM, peer: 'peer-guest-1', name: 'X' }), 'peer taken');   // ids aren't taken over
  w.say(c, { t: 'join', room: ROOM, peer: 'peer-x-0001', name: 'X' });
  assert.equal(w.take(c).at(-2).t, 'joined');
  assert.equal(why({ t: 'join', room: ROOM, peer: 'peer-x-0002', name: 'X' }), 'already joined');
});

test('names: trimmed, up to 40 characters (emoji count as one), no control characters', () => {
  assert.equal(cleanName(' Ana '), 'Ana');
  assert.equal(cleanName('🌩️'.repeat(10)).length > 0, true);
  assert.equal(cleanName('é'.repeat(40)), 'é'.repeat(40));
  assert.equal(cleanName('é'.repeat(41)), null);
  assert.equal(cleanName('a\u0007b'), null);
  assert.equal(cleanName('a\u2028b'), null);
  assert.equal(isRoomCode('abcDEF-_09'), true);
  assert.equal(isRoomCode('abc'), false);
});

test('"to": only that person gets it, marked with who sent it; "not here", "to yourself", no data', () => {
  const w = world();
  const [host, a, b] = room(w, 'Robin', 'Ted');
  w.say(a, { t: 'to', peer: 'peer-host-1', data: { kind: 'offer', sdp: 'v=0…' } });
  assert.deepEqual(w.take(host), [{ t: 'from', peer: 'peer-guest-1', data: { kind: 'offer', sdp: 'v=0…' } }]);
  assert.deepEqual(w.take(b), []);
  assert.deepEqual(w.take(a), []);
  w.say(a, { t: 'to', peer: 'peer-nobody-1', data: 1 });
  assert.deepEqual(w.take(a), [{ t: 'error', why: 'not here', peer: 'peer-nobody-1' }]);
  w.say(a, { t: 'to', peer: 'peer-guest-1', data: 1 });
  assert.equal(w.take(a)[0].why, 'to yourself');
  w.say(a, { t: 'to', peer: 'peer-host-1' });
  assert.equal(w.take(a)[0].why, 'data');
  w.say(a, { t: 'to', peer: 'peer-host-1', data: null });          // null is data
  assert.deepEqual(w.take(host), [{ t: 'from', peer: 'peer-guest-1', data: null }]);
});

test('"all": everyone else gets it (not the sender), marked all: true', () => {
  const w = world();
  const [host, a, b] = room(w, 'Robin', 'Ted');
  w.say(host, { t: 'all', data: { kind: 'tile', uri: 'at://did:plc:x/ing.dasl.masl/3abc', cid: 'bafyrei…' } });
  const got = { t: 'from', peer: 'peer-host-1', data: { kind: 'tile', uri: 'at://did:plc:x/ing.dasl.masl/3abc', cid: 'bafyrei…' }, all: true };
  assert.deepEqual(w.take(a), [got]);
  assert.deepEqual(w.take(b), [got]);
  assert.deepEqual(w.take(host), []);
  w.say(a, { t: 'all' });
  assert.equal(w.take(a)[0].why, 'data');
});

test('before joining, only "join" works; unknown types, not JSON, not an object are refused', () => {
  const w = world();
  const c = w.conn('c');
  for (const m of [{ t: 'to', peer: 'peer-host-1', data: 1 }, { t: 'all', data: 1 }, { t: 'end' }, { t: 'remove', peer: 'peer-x-0001' }]) {
    w.say(c, m);
    assert.equal(w.last(c).why, 'join a room first', m.t);
  }
  w.say(c, { t: 'dance' }); assert.equal(w.last(c).why, 'unknown type');
  w.say(c, { type: 'join' }); assert.equal(w.last(c).why, 'unknown type');
  w.say(c, 'nonsense'); assert.equal(w.last(c).why, 'not JSON');
  w.say(c, '[1,2]'); assert.equal(w.last(c).why, 'not a message');
  w.say(c, 'null'); assert.equal(w.last(c).why, 'not a message');
});

test('the host removes someone: they hear "removed" and are closed (4001); the rest get the new list; guests can\'t', () => {
  const w = world();
  const [host, a, b] = room(w, 'Robin', 'Ted');
  w.say(a, { t: 'remove', peer: 'peer-guest-2' });
  assert.equal(w.take(a)[0].why, 'host only');
  w.say(host, { t: 'remove', peer: 'peer-host-1' });
  assert.equal(w.take(host)[0].why, 'not yourself');
  w.say(host, { t: 'remove', peer: 'peer-guest-2' });
  assert.deepEqual(w.take(b), [{ t: 'removed' }]);
  assert.equal(w.closedWith(b), CLOSE.removed);
  const list = [{ peer: 'peer-host-1', name: 'Nick', host: true }, { peer: 'peer-guest-1', name: 'Robin', host: false }];
  assert.deepEqual(w.take(a), [{ t: 'peers', list }]);
  assert.deepEqual(w.take(host), [{ t: 'peers', list }]);
  w.say(b, { t: 'all', data: 1 });                          // b's connection is out of the room
  assert.equal(w.take(b)[0].why, 'join a room first');
  assert.deepEqual(w.drop(b), []);                          // its close changes nothing more
  w.say(host, { t: 'remove', peer: 'peer-guest-2' });
  assert.equal(w.take(host)[0].why, 'not here');
});

test('the host ends the room: everyone hears "ended" (why "host") and is closed (4000); the room vanishes', () => {
  const w = world();
  const [host, a] = room(w, 'Robin');
  w.say(a, { t: 'end' });
  assert.equal(w.take(a)[0].why, 'host only');
  w.say(host, { t: 'end' });
  for (const c of [host, a]) {
    assert.deepEqual(w.take(c), [{ t: 'ended', why: 'host' }]);
    assert.equal(w.closedWith(c), CLOSE.ended);
  }
  assert.equal(w.rooms.stats().rooms, 0);
  const late = w.conn('late');
  w.say(late, { t: 'join', room: ROOM, peer: 'peer-late-1', name: 'Late' });
  assert.equal(w.last(late).why, 'no room');
});

test('a guest leaving: the others get the new list; the room goes on', () => {
  const w = world();
  const [host, a] = room(w, 'Robin');
  w.drop(a);
  assert.deepEqual(w.take(host), [{ t: 'peers', list: [{ peer: 'peer-host-1', name: 'Nick', host: true }] }]);
  assert.equal(w.rooms.stats().rooms, 1);
});

test('the host drops: everyone stays, the host shows as away; back within the grace period with the host key → host again', () => {
  const w = world();
  const [host, a, b] = room(w, 'Robin', 'Ted');
  w.drop(host);
  const away = [{ peer: 'peer-host-1', name: 'Nick', host: true, away: true }, { peer: 'peer-guest-1', name: 'Robin', host: false }, { peer: 'peer-guest-2', name: 'Ted', host: false }];
  assert.deepEqual(w.take(a), [{ t: 'peers', list: away }]);
  // during the wait, guests still talk to each other (a screen already shared carries on); the host isn't reachable
  w.say(a, { t: 'to', peer: 'peer-guest-2', data: 'ice' });
  assert.deepEqual(w.take(b).at(-1), { t: 'from', peer: 'peer-guest-1', data: 'ice' });
  w.say(a, { t: 'to', peer: 'peer-host-1', data: 'ice' });
  assert.equal(w.take(a)[0].why, 'not here');
  w.tick(LIMITS.hostGraceMs - 1000);
  w.sweep();
  assert.deepEqual(w.take(a), []);                       // not over yet
  const back = w.conn('back');
  w.say(back, { t: 'join', room: ROOM, peer: 'peer-host-2', name: 'Nick', hostKey: KEY });   // a reload: a new peer id
  assert.deepEqual(w.take(back)[0], { t: 'joined', room: ROOM, peer: 'peer-host-2', host: true, hostKey: KEY });
  const again = [{ peer: 'peer-guest-1', name: 'Robin', host: false }, { peer: 'peer-guest-2', name: 'Ted', host: false }, { peer: 'peer-host-2', name: 'Nick', host: true }];
  assert.deepEqual(w.take(a), [{ t: 'peers', list: again }]);
  w.tick(LIMITS.hostGraceMs * 2);
  w.sweep();
  assert.deepEqual(w.take(a), []);                       // the grace period was cancelled
  w.take(b);
  w.say(back, { t: 'remove', peer: 'peer-guest-2' });    // and the host's powers are back
  assert.deepEqual(w.take(b), [{ t: 'removed' }]);
});

test('the host doesn\'t come back in time: the room ends for everyone (why "host gone") and vanishes', () => {
  const w = world();
  const [host, a] = room(w, 'Robin');
  w.drop(host);
  w.take(a);
  w.tick(LIMITS.hostGraceMs);
  w.sweep();
  assert.deepEqual(w.take(a), [{ t: 'ended', why: 'host gone' }]);
  assert.equal(w.closedWith(a), CLOSE.ended);
  assert.equal(w.rooms.stats().rooms, 0);
  const back = w.conn('back');
  w.say(back, { t: 'join', room: ROOM, peer: 'peer-host-2', name: 'Nick', hostKey: KEY });
  assert.equal(w.last(back).why, 'no room');             // too late: only create (below) makes it again
});

test('a host alone who drops still gets the grace period (a reload), and the room vanishes after it', () => {
  const w = world();
  const [host] = room(w);
  w.drop(host);
  assert.equal(w.rooms.stats().rooms, 1);
  w.tick(LIMITS.hostGraceMs);
  w.sweep();
  assert.equal(w.rooms.stats().rooms, 0);
});

test('the host key joining while the host is still connected (another tab, a dead connection not yet noticed): the old one hears "replaced" (4002)', () => {
  const w = world();
  const [host, a] = room(w, 'Robin');
  const tab2 = w.conn('tab2');
  w.say(tab2, { t: 'join', room: ROOM, peer: 'peer-host-9', name: 'Nick', hostKey: KEY });
  assert.deepEqual(w.take(host), [{ t: 'replaced' }]);
  assert.equal(w.closedWith(host), CLOSE.replaced);
  assert.equal(w.take(tab2)[0].host, true);
  assert.deepEqual(w.take(a), [{ t: 'peers', list: [{ peer: 'peer-guest-1', name: 'Robin', host: false }, { peer: 'peer-host-9', name: 'Nick', host: true }] }]);
  assert.deepEqual(w.drop(host), []);                     // the old connection closing changes nothing
  // the same page reconnecting with its own peer id works too
  w.drop(tab2); w.take(a);
  const same = w.conn('same');
  w.say(same, { t: 'join', room: ROOM, peer: 'peer-host-9', name: 'Nick', hostKey: KEY });
  assert.equal(w.take(same)[0].t, 'joined');
  // the host key can't take a guest's id
  const sneaky = w.conn('sneaky');
  w.say(sneaky, { t: 'join', room: ROOM, peer: 'peer-guest-1', name: 'Nick', hostKey: KEY });
  assert.equal(w.last(sneaky).why, 'peer taken');
});

test('after a relay restart (rooms empty), the host makes the room again with its own host key; guests meanwhile get "no room"', () => {
  const w = world({ makeHostKey: () => 'n'.repeat(43) });   // a new relay would make a different key
  const g = w.conn('g');
  w.say(g, { t: 'join', room: ROOM, peer: 'peer-guest-1', name: 'Robin' });
  assert.equal(w.last(g).why, 'no room');
  const host = w.conn('host');
  w.say(host, { t: 'join', room: ROOM, peer: 'peer-host-1', name: 'Nick', create: true, hostKey: KEY });
  assert.equal(w.take(host)[0].hostKey, KEY);              // the page's key, so its host link still works
  w.say(g, { t: 'join', room: ROOM, peer: 'peer-guest-1', name: 'Robin' });
  assert.equal(w.take(g).at(-2).t, 'joined');
});

test('at most 6 people a room, the away host included; the host coming back always fits', () => {
  const w = world();
  const [host, ...guests] = room(w, 'g1', 'g2', 'g3', 'g4', 'g5');
  assert.equal(guests.length, 5);
  const seventh = w.conn('7');
  w.say(seventh, { t: 'join', room: ROOM, peer: 'peer-seven-1', name: 'Seven' });
  assert.deepEqual(w.take(seventh), [{ t: 'full' }]);
  w.drop(host);
  w.say(seventh, { t: 'join', room: ROOM, peer: 'peer-seven-1', name: 'Seven' });
  assert.deepEqual(w.take(seventh), [{ t: 'full' }]);       // the host's place is kept
  const back = w.conn('back');
  w.say(back, { t: 'join', room: ROOM, peer: 'peer-host-2', name: 'Nick', hostKey: KEY });
  assert.equal(w.take(back)[0].t, 'joined');
  w.drop(guests[0]);
  w.say(seventh, { t: 'join', room: ROOM, peer: 'peer-seven-1', name: 'Seven' });
  assert.equal(w.take(seventh)[0].t, 'joined');
});

test('limits: a message over 64 KB is "too big"; too many messages too fast are "too many", then allowed again', () => {
  const w = world();
  const [host, a] = room(w, 'Robin');
  w.say(a, { t: 'all', data: 'x'.repeat(LIMITS.maxBytes) });
  assert.equal(w.take(a)[0].why, 'too big');
  let refused = 0;
  for (let i = 0; i < LIMITS.burst + 20; i++) {
    w.say(a, { t: 'to', peer: 'peer-host-1', data: i });
    if (w.take(a).some((m) => m.why === 'too many')) refused++;
  }
  assert.ok(refused >= 19 && refused <= 21, `refused ${refused}`);
  assert.ok(w.take(host).length >= LIMITS.burst - 2);
  w.tick(1000);
  w.say(a, { t: 'to', peer: 'peer-host-1', data: 'later' });
  assert.deepEqual(w.take(host), [{ t: 'from', peer: 'peer-guest-1', data: 'later' }]);
});

test('rooms are separate: messages, lists and ending don\'t cross', () => {
  const w = world();
  const [host1, a] = room(w, 'Robin');
  const host2 = w.conn('host2');
  w.say(host2, { t: 'join', room: 'otherroom99', peer: 'peer-host-x', name: 'Ted', create: true });
  w.take(host2);
  w.say(host1, { t: 'all', data: 'hello room one' });
  assert.deepEqual(w.take(host2), []);
  assert.equal(w.take(a).length, 1);
  w.say(host2, { t: 'to', peer: 'peer-guest-1', data: 'psst' });
  assert.equal(w.take(host2)[0].why, 'not here');
  w.say(host2, { t: 'end' });
  assert.deepEqual(w.take(a), []);
  assert.equal(w.rooms.stats().rooms, 1);
});
