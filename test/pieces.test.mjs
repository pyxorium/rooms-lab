// The page's small pieces on their own: formats (the same as the relay's), links, the presenter rule,
// and the checks on what other pages send.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as page from '../src/formats.js';
import * as relay from '../relay/rooms.js';
import { afterAnnounce, afterPeople } from '../src/presenting.js';
import { readPeerData } from '../src/messages.js';
import { relayUrl, RELAY_URL, LOCAL_RELAY_URL } from '../src/config.js';

test('the page checks codes, ids, keys and names exactly as the relay does', () => {
  const samples = ['', 'abc', 'abcdefghij', 'abc def ghij', 'ABCdef-_09', 'x'.repeat(64), 'x'.repeat(65), 'é'.repeat(12), null, 42,
    'h'.repeat(31), 'h'.repeat(32), 'h'.repeat(128), 'h'.repeat(129), 'peer-1', 'peer-123'];
  for (const s of samples) {
    assert.equal(page.isRoomCode(s), relay.isRoomCode(s), `room ${s}`);
    assert.equal(page.isPeerId(s), relay.isPeerId(s), `peer ${s}`);
    assert.equal(page.isHostKey(s), relay.isHostKey(s), `key ${s}`);
  }
  for (const n of [' Ana ', '', '   ', 'x'.repeat(40), 'x'.repeat(41), 'a\nb', 'a b', '🌩️ Nick', '<b>x</b>', 7]) assert.equal(page.cleanName(n), relay.cleanName(n), `name ${n}`);
});

test('new room codes and peer ids are random and the relay accepts them', () => {
  const codes = new Set(Array.from({ length: 50 }, page.newRoomCode));
  assert.equal(codes.size, 50);
  for (const c of codes) { assert.match(c, /^[a-km-z2-9]{12}$/); assert.ok(relay.isRoomCode(c)); }
  for (let i = 0; i < 20; i++) assert.ok(relay.isPeerId(page.newPeerId()));
});

test('room links: an invite carries only the room; the host link adds the key; ?relay= and ?loader= go along on this computer only', () => {
  const key = 'K'.repeat(43);
  const local = new URL('http://127.0.0.1:5190/?relay=ws%3A%2F%2F127.0.0.1%3A9000%2F&other=1#old');
  assert.equal(page.inviteLink(local, 'abcdefghjkmn'), 'http://127.0.0.1:5190/?relay=ws%3A%2F%2F127.0.0.1%3A9000%2F#r=abcdefghjkmn');
  const site = new URL('http://127.0.0.1:4400/?relay=ws%3A%2F%2F127.0.0.1%3A9000%2F&loader=http%3A%2F%2Fload.x.localhost%2F.well-known%2Fweb-tiles%2F');
  assert.equal(page.inviteLink(site, 'abcdefghjkmn'), 'http://127.0.0.1:4400/?relay=ws%3A%2F%2F127.0.0.1%3A9000%2F&loader=http%3A%2F%2Fload.x.localhost%2F.well-known%2Fweb-tiles%2F#r=abcdefghjkmn', 'the site page\'s test loader too');
  const live = new URL('https://thunderbird.cafe/webtiles/rooms-lab/?relay=wss://evil.example/&loader=https://evil.example/.well-known/web-tiles/');
  assert.equal(page.inviteLink(live, 'abcdefghjkmn'), 'https://thunderbird.cafe/webtiles/rooms-lab/#r=abcdefghjkmn');
  assert.equal(page.hostLink(live, 'abcdefghjkmn', key), `https://thunderbird.cafe/webtiles/rooms-lab/#r=abcdefghjkmn&k=${key}`);
  assert.deepEqual(page.readRoomHash(`#r=abcdefghjkmn&k=${key}`), { room: 'abcdefghjkmn', hostKey: key, turnOnly: false });
  assert.deepEqual(page.readRoomHash('#r=abcdefghjkmn'), { room: 'abcdefghjkmn', hostKey: null, turnOnly: false });
  assert.deepEqual(page.readRoomHash('#r=short&k=nope'), { room: null, hostKey: null, turnOnly: false });
  assert.deepEqual(page.readRoomHash(''), { room: null, hostKey: null, turnOnly: false });
  // The TURN test switch (step 7): only the exact value turns it on.
  assert.deepEqual(page.readRoomHash('#r=abcdefghjkmn&turn=only'), { room: 'abcdefghjkmn', hostKey: null, turnOnly: true });
  assert.equal(page.readRoomHash('#r=abcdefghjkmn&turn=yes').turnOnly, false);
});

test('which relay (when the host page names none): the real one away from this computer; the dev page\'s local one here; ?relay= only on this computer', () => {
  assert.equal(relayUrl(new URL('https://thunderbird.cafe/webtiles/rooms-lab/?relay=ws://x/')), RELAY_URL);
  assert.equal(relayUrl(new URL('http://127.0.0.1:4321/webtiles/rooms-lab/')), LOCAL_RELAY_URL, 'the site\u2019s dev server is no longer special (the lab page retired Oct 29 2026)');
  assert.equal(relayUrl(new URL('http://127.0.0.1:5190/')), LOCAL_RELAY_URL);
  assert.equal(relayUrl(new URL('http://127.0.0.1:5190/?relay=ws://127.0.0.1:9/')), 'ws://127.0.0.1:9/');
  assert.equal(relayUrl(new URL('http://127.0.0.1:5190/?relay=javascript:alert(1)')), LOCAL_RELAY_URL);
});

test('one presenter at a time: start, stop, someone else\'s stop changes nothing, two at once → the smaller id, leaving clears', () => {
  assert.equal(afterAnnounce(null, 'bbbbbbbb', true), 'bbbbbbbb');
  assert.equal(afterAnnounce('bbbbbbbb', 'bbbbbbbb', true), 'bbbbbbbb');
  assert.equal(afterAnnounce('bbbbbbbb', 'bbbbbbbb', false), null);
  assert.equal(afterAnnounce('bbbbbbbb', 'cccccccc', false), 'bbbbbbbb');
  assert.equal(afterAnnounce('bbbbbbbb', 'aaaaaaaa', true), 'aaaaaaaa');
  assert.equal(afterAnnounce('aaaaaaaa', 'bbbbbbbb', true), 'aaaaaaaa');
  // every page reaches the same answer whichever announcement arrives first
  for (const [x, y] of [['Qx3', 'Ab9'], ['zz', 'zy']]) assert.equal(afterAnnounce(afterAnnounce(null, x, true), y, true), afterAnnounce(afterAnnounce(null, y, true), x, true));
  assert.equal(afterPeople('aaaaaaaa', ['bbbbbbbb']), null);
  assert.equal(afterPeople('aaaaaaaa', ['aaaaaaaa', 'bbbbbbbb']), 'aaaaaaaa');
  assert.equal(afterPeople(null, []), null);
});

test('what other pages send is checked: known kinds only, sizes limited, extra fields dropped', () => {
  assert.deepEqual(readPeerData({ kind: 'rtc', description: { type: 'offer', sdp: 'v=0', extra: 1 } }), { kind: 'rtc', description: { type: 'offer', sdp: 'v=0' } });
  assert.equal(readPeerData({ kind: 'rtc', description: { type: 'evil', sdp: 'v=0' } }), null);
  assert.equal(readPeerData({ kind: 'rtc', description: { type: 'offer', sdp: 'x'.repeat(60_001) } }), null);
  assert.deepEqual(readPeerData({ kind: 'rtc', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'ab', x: 2 } }),
    { kind: 'rtc', candidate: { candidate: 'candidate:1 1 udp 1 1.2.3.4 5 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'ab' } });
  assert.equal(readPeerData({ kind: 'rtc', candidate: { candidate: 7 } }), null);
  assert.deepEqual(readPeerData({ kind: 'presenting', on: true }), { kind: 'presenting', on: true });
  assert.equal(readPeerData({ kind: 'presenting', on: 'yes' }), null);
  assert.deepEqual(readPeerData({ kind: 'ask-screen', id: 'abc123', asker: 'robin-peer-1' }), { kind: 'ask-screen', id: 'abc123', asker: 'robin-peer-1' });
  assert.equal(readPeerData({ kind: 'ask-screen', id: 'abc123' }), null, 'an ask names its asker (step 3)');
  assert.equal(readPeerData({ kind: 'ask-screen', id: '<script>', asker: 'robin-peer-1' }), null);
  assert.deepEqual(readPeerData({ kind: 'ask-answer', id: 'abc', answer: 'no' }), { kind: 'ask-answer', id: 'abc', answer: 'no' });
  assert.equal(readPeerData({ kind: 'ask-answer', id: 'abc', answer: 'whatever' }), null);
  // wishes (step 3): to the host, and the host's answers
  assert.deepEqual(readPeerData({ kind: 'wish', id: 'abc', wish: 'see-screen', target: 'ted-peer-11', x: 1 }), { kind: 'wish', id: 'abc', wish: 'see-screen', target: 'ted-peer-11' });
  assert.deepEqual(readPeerData({ kind: 'wish', id: 'abc', wish: 'present', target: 'ignored-peer' }), { kind: 'wish', id: 'abc', wish: 'present' });
  assert.equal(readPeerData({ kind: 'wish', id: 'abc', wish: 'see-screen' }), null, 'see-screen names whose');
  const TILE = 'at://did:plc:6vxjigxrqizmbo56gojxico3/ing.dasl.masl/3myfnyphiuw2t';
  const CID = 'bafyreidwwralslcgks5hwet7adtcthwti74k7vo47bcuipbwcqmspqk5zu';
  assert.equal(readPeerData({ kind: 'wish', id: 'abc', wish: 'open-tile', uri: 'at://x' }), null, 'only a tile address');
  assert.deepEqual(readPeerData({ kind: 'wish', id: 'abc', wish: 'open-tile', uri: TILE }), { kind: 'wish', id: 'abc', wish: 'open-tile', uri: TILE });
  const PREVIEWED = `bafyrei${'q'.repeat(52)}`;
  assert.deepEqual(readPeerData({ kind: 'wish', id: 'abc', wish: 'open-tile', uri: TILE, cid: PREVIEWED }), { kind: 'wish', id: 'abc', wish: 'open-tile', uri: TILE, cid: PREVIEWED }, 'the version previewed (step 4b)');
  assert.equal(readPeerData({ kind: 'wish', id: 'abc', wish: 'open-tile', uri: TILE, cid: 'not a cid' }), null);
  // tiles opened for everyone (step 4)
  assert.deepEqual(readPeerData({ kind: 'tile', uri: TILE, cid: CID, by: 'robin-peer-1', name: '<b>x</b>' }), { kind: 'tile', uri: TILE, cid: CID, by: 'robin-peer-1' }, 'no name: each page reads the record itself');
  assert.equal(readPeerData({ kind: 'tile', uri: TILE, cid: 'Qm123', by: 'robin-peer-1' }), null);
  assert.equal(readPeerData({ kind: 'tile', uri: 'https://example.com', cid: CID, by: 'robin-peer-1' }), null);
  assert.deepEqual(readPeerData({ kind: 'tiles', list: [{ uri: TILE, cid: CID, by: 'robin-peer-1' }] }).list.length, 1);
  assert.equal(readPeerData({ kind: 'tiles', list: Array(7).fill({ uri: TILE, cid: CID, by: 'robin-peer-1' }) }), null, 'six at most');
  assert.equal(readPeerData({ kind: 'tiles', list: [{ uri: TILE, cid: CID, by: 'robin-peer-1' }, { uri: 'x' }] }), null);
  assert.deepEqual(readPeerData({ kind: 'tile-close', uri: TILE }), { kind: 'tile-close', uri: TILE });
  assert.deepEqual(readPeerData({ kind: 'wish-result', id: 'abc', decision: 'deny', reason: 'The host said no.' }), { kind: 'wish-result', id: 'abc', decision: 'deny', reason: 'The host said no.' });
  assert.equal(readPeerData({ kind: 'wish-result', id: 'abc', decision: 'ask-host' }), null, 'askers only hear allow or deny');
  assert.equal(readPeerData({ kind: 'wish-result', id: 'abc', decision: 'deny', reason: 'x'.repeat(201) }).reason, '');
  assert.deepEqual(readPeerData({ kind: 'go-ahead', id: 'abc' }), { kind: 'go-ahead', id: 'abc' });
  // nothing can ask a page to share its screen: there's no such message
  assert.equal(readPeerData({ kind: 'share-now' }), null);
  for (const x of [null, 1, 'x', [], { kind: 'unknown' }]) assert.equal(readPeerData(x), null);
});
