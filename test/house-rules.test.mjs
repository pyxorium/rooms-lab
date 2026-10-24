// The house tile's rules (tiles/house/rules.js) on their own: "the host approves".
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, RULE_SET, WISHES } from '../tiles/house/rules.js';

const H = 'host-peer-1', R = 'robin-peer-1', T = 'ted-peer-11', X = 'gone-peer-1';
const room = (extra = {}) => ({
  host: H, presenter: null,
  peers: [{ peer: H, name: 'Nick', host: true }, { peer: R, name: 'Robin', host: false }, { peer: T, name: 'Ted', host: false }],
  ...extra,
});
const d = (state, wish) => decide(state, { id: 'w1', ...wish }).decision;
const why = (state, wish) => decide(state, { id: 'w1', ...wish }).reason;
const TILE = 'at://did:plc:6vxjigxrqizmbo56gojxico3/ing.dasl.masl/3myfnyphiuw2t';

test('the rule set is named, and knows four wishes (live since the live-tiles build)', () => {
  assert.equal(RULE_SET, 'host-approves');
  assert.deepEqual(WISHES, ['see-screen', 'present', 'open-tile', 'live']);
});

test('live: the host → allowed; a guest → the host approves; only a tile address; not while the host is away', () => {
  assert.equal(d(room(), { by: H, wish: 'live', uri: TILE }), 'allow');
  assert.equal(why(room(), { by: H, wish: 'live', uri: TILE }), 'The host may share tiles live.');
  assert.equal(d(room(), { by: R, wish: 'live', uri: TILE }), 'ask-host');
  assert.equal(why(room(), { by: R, wish: 'live', uri: TILE }), 'The host approves tiles shared live.');
  for (const uri of ['https://example.com', `${TILE}/x`, null, undefined]) assert.equal(d(room(), { by: H, wish: 'live', uri }), 'deny', String(uri));
  const away = room({ peers: [{ peer: H, name: 'Nick', host: true, away: true }, { peer: R, name: 'Robin', host: false }] });
  assert.equal(d(away, { by: R, wish: 'live', uri: TILE }), 'deny');
  assert.equal(d(room({ presenter: T }), { by: R, wish: 'live', uri: TILE }), 'ask-host', 'a presenter doesn\'t block live sharing');
});

test('see-screen: a guest asking about a guest → the host approves; the host asking → allowed; asking about the host → straight to the host\'s own prompt', () => {
  assert.equal(d(room(), { by: R, wish: 'see-screen', target: T }), 'ask-host');
  assert.equal(why(room(), { by: R, wish: 'see-screen', target: T }), 'The host approves screen requests.');
  assert.equal(d(room(), { by: H, wish: 'see-screen', target: T }), 'allow');
  assert.equal(d(room(), { by: R, wish: 'see-screen', target: H }), 'allow');
  assert.equal(why(room(), { by: R, wish: 'see-screen', target: H }), 'The host answers for their own screen.');
});

test('see-screen refusals: your own screen, someone not here, while someone presents', () => {
  assert.equal(d(room(), { by: R, wish: 'see-screen', target: R }), 'deny');
  assert.equal(d(room(), { by: R, wish: 'see-screen', target: X }), 'deny');
  assert.equal(d(room(), { by: R, wish: 'see-screen' }), 'deny');
  assert.equal(d(room({ presenter: T }), { by: R, wish: 'see-screen', target: H }), 'deny');
  assert.equal(why(room({ presenter: T }), { by: H, wish: 'see-screen', target: R }), 'Someone is presenting. One screen at a time.');
});

test('present: a guest → the host approves; the host → allowed; one presenter at a time', () => {
  assert.equal(d(room(), { by: R, wish: 'present' }), 'ask-host');
  assert.equal(d(room(), { by: H, wish: 'present' }), 'allow');
  assert.equal(d(room({ presenter: T }), { by: R, wish: 'present' }), 'deny');
  assert.equal(d(room({ presenter: T }), { by: H, wish: 'present' }), 'deny', 'even the host waits for the stage');
  assert.equal(why(room({ presenter: R }), { by: R, wish: 'present' }), 'You’re already presenting.');
});

test('open-tile: the host → allowed; a guest → the host approves; only a tile address', () => {
  assert.equal(d(room(), { by: H, wish: 'open-tile', uri: TILE }), 'allow');
  assert.equal(d(room(), { by: R, wish: 'open-tile', uri: TILE }), 'ask-host');
  for (const uri of ['https://example.com', 'at://did:plc:x/app.bsky.feed.post/3abc', `${TILE} `, 42, undefined]) assert.equal(d(room(), { by: H, wish: 'open-tile', uri }), 'deny', String(uri));
});

test('nothing is decided for people who aren\'t here, while the host is away, or without a room', () => {
  assert.equal(d(room(), { by: X, wish: 'present' }), 'deny');
  const away = room({ peers: [{ peer: H, name: 'Nick', host: true, away: true }, { peer: R, name: 'Robin', host: false }] });
  assert.equal(d(away, { by: R, wish: 'present' }), 'deny');
  assert.match(why(away, { by: R, wish: 'present' }), /The host is away/);
  assert.equal(d(null, { by: R, wish: 'present' }), 'deny');
  assert.equal(d(room({ peers: 'x' }), { by: R, wish: 'present' }), 'deny');
  const awayGuest = room({ peers: [...room().peers.slice(0, 2), { peer: T, name: 'Ted', host: false, away: true }] });
  assert.equal(d(awayGuest, { by: R, wish: 'see-screen', target: T }), 'deny');
});

test('unknown wishes are refused; the answer is always allow, deny or ask-host with a reason', () => {
  assert.equal(d(room(), { by: R, wish: 'share-now', target: T }), 'deny');
  assert.equal(d(room(), { by: R }), 'deny');
  for (const wish of ['see-screen', 'present', 'open-tile', 'live', 'x']) for (const by of [H, R, X]) {
    const a = decide(room(), { id: 'w', by, wish, target: T, uri: TILE });
    assert.ok(['allow', 'deny', 'ask-host'].includes(a.decision));
    assert.equal(typeof a.reason, 'string');
    assert.ok(a.reason.length > 0 && a.reason.length <= 200);
  }
});
