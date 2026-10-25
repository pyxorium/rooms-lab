// Build step 9 (claude/rooms-lab-step9.md): the stage's rules, the "stage" message, and the sign-in box's handle
// suggestions (typeahead.js, Raku's copy). The page itself: test/browser/check_stage.mjs and check_signin.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { whatsOnStage, afterPresenterChange, stageLines, EMPTY_LINE, EMPTY_HINT_HOST, EMPTY_HINT_GUEST, fullScreenCall } from '../src/stage.js';
import { readPeerData } from '../src/messages.js';
import { looksLikeHandle, searchActors, CLIENT_LABEL, TYPEAHEAD_URL } from '../src/typeahead.js';

const URI = 'at://did:plc:tiletiletiletiletiletile/ing.dasl.masl/3abc';
const URI2 = 'at://did:plc:tiletiletiletiletiletile/ing.dasl.masl/3def';
const CID = `bafyrei${'q'.repeat(52)}`;
const PEER = 'peerpeer01';

test('what the stage shows: a staged tile wins over a screen; then the screen (or waiting for it); else empty', () => {
  assert.equal(whatsOnStage({ tile: URI, card: 'card', presenter: PEER, screenLive: true }), 'tile');
  assert.equal(whatsOnStage({ tile: URI, card: 'hidden', presenter: null, screenLive: false }), 'tile-hidden');
  assert.equal(whatsOnStage({ tile: URI, card: 'missing', presenter: null, screenLive: false }), 'tile-coming');
  assert.equal(whatsOnStage({ tile: null, card: 'missing', presenter: PEER, screenLive: true }), 'screen');
  assert.equal(whatsOnStage({ tile: null, card: 'missing', presenter: PEER, screenLive: false }), 'waiting');
  assert.equal(whatsOnStage({ tile: null, card: 'missing', presenter: null, screenLive: false }), 'empty');
});

test('the host\'s rule: a new presenter takes the stage back; the same presenter again (a re-announce) doesn\'t', () => {
  assert.equal(afterPresenterChange(URI, null, PEER), null);
  assert.equal(afterPresenterChange(URI, 'otherpeer1', PEER), null);
  assert.equal(afterPresenterChange(URI, PEER, PEER), URI);
  assert.equal(afterPresenterChange(URI, PEER, null), URI, 'a share ending leaves the tile where it is');
  assert.equal(afterPresenterChange(null, null, PEER), null);
});

test('the wording: the empty stage, the hints, and the status lines (a tile\'s name only after the page\'s words)', () => {
  assert.equal(EMPTY_LINE, 'Nothing on the stage: nobody is sharing their screen, and no tile is on the stage.');
  assert.equal(EMPTY_HINT_HOST, 'Share your screen, or put a tile on the stage from the list below.');
  assert.equal(EMPTY_HINT_GUEST, 'You can ask to share your screen, or ask to open a tile.');
  assert.equal(stageLines.put('@nick.test', 'Poll'), '@nick.test put a tile on the stage: Poll');
  assert.equal(stageLines.put('@nick.test', null), '@nick.test put a tile on the stage.');
  assert.equal(stageLines.left('Poll'), 'The tile left the stage: Poll');
  assert.equal(stageLines.left(null), 'The tile left the stage.');
  assert.equal(stageLines.back('@nick.test’s'), 'Back to @nick.test’s screen.');
  assert.equal(stageLines.sharing('@nick.test'), '@nick.test is sharing their screen.');
});

test('full screen: the standard call, Safari\'s, an iPhone\'s video-only one, or none', () => {
  const doc = (on) => ({ fullscreenEnabled: on });
  let called = '';
  assert.equal(typeof fullScreenCall({ ownerDocument: doc(true), requestFullscreen: () => { called = 'std'; } }), 'function');
  fullScreenCall({ ownerDocument: doc(true), requestFullscreen: () => { called = 'std'; } })();
  assert.equal(called, 'std');
  fullScreenCall({ ownerDocument: { webkitFullscreenEnabled: true }, webkitRequestFullscreen: () => { called = 'webkit'; } })();
  assert.equal(called, 'webkit');
  const video = { webkitEnterFullscreen: () => { called = 'video'; } };
  fullScreenCall({ ownerDocument: doc(false), requestFullscreen: () => {} }, video)();
  assert.equal(called, 'video');
  assert.equal(fullScreenCall({ ownerDocument: doc(false), requestFullscreen: () => {} }), null, 'no full screen: no button');
  assert.equal(fullScreenCall(null), null);
});

test('the "stage" message: a tile address or null; tiles entries carry stage: true (one at most)', () => {
  assert.deepEqual(readPeerData({ kind: 'stage', uri: URI }), { kind: 'stage', uri: URI });
  assert.deepEqual(readPeerData({ kind: 'stage', uri: null }), { kind: 'stage', uri: null });
  for (const uri of [undefined, '', 'https://example.com/', 'at://did:plc:x/app.bsky.feed.post/1', 7]) assert.equal(readPeerData({ kind: 'stage', uri }), null, String(uri));
  const list = readPeerData({ kind: 'tiles', list: [{ uri: URI, cid: CID, by: PEER, stage: true }, { uri: URI2, cid: CID, by: PEER, stage: 'yes' }] });
  assert.deepEqual(list.list, [{ uri: URI, cid: CID, by: PEER, stage: true }, { uri: URI2, cid: CID, by: PEER }]);
  assert.equal(readPeerData({ kind: 'tiles', list: [{ uri: URI, cid: CID, by: PEER, stage: true }, { uri: URI2, cid: CID, by: PEER, stage: true }] }), null, 'two on the stage: refused');
  assert.deepEqual(readPeerData({ kind: 'tile', uri: URI, cid: CID, by: PEER, stage: true }), { kind: 'tile', uri: URI, cid: CID, by: PEER, stage: true });
});

test('handle suggestions: only for what looks like the start of a handle; the service, the label, at most 6, junk dropped', async () => {
  for (const t of ['ni', '@nick', 'nick.test', 'a-b.c']) assert.ok(looksLikeHandle(t), t);
  for (const t of ['', 'n', '@n', 'did:plc:abc', 'at://x', 'https://x', 'a b', 'x/y']) assert.ok(!looksLikeHandle(t), t);
  let asked = null;
  const fetchImpl = async (url, init) => {
    asked = { url, init };
    return { ok: true, json: async () => ({ actors: [{ handle: 'nick.test' }, { handle: 'handle.invalid' }, { nope: 1 }, ...Array.from({ length: 8 }, (_, i) => ({ handle: `n${i}.test` }))] }) };
  };
  const found = await searchActors('@Nic', fetchImpl);
  assert.equal(asked.url, `${TYPEAHEAD_URL}/xrpc/tech.waow.typeahead.searchActors?q=Nic&limit=6`);
  assert.equal(asked.init.headers['X-Client'], CLIENT_LABEL);
  assert.equal(CLIENT_LABEL, 'thunderbird.cafe');
  assert.equal(asked.init.credentials, 'omit');
  assert.equal(found.length, 6);
  assert.equal(found[0].handle, 'nick.test');
  assert.ok(!found.some((a) => a.handle === 'handle.invalid'));
  assert.deepEqual(await searchActors('n', fetchImpl), [], 'too short: nobody asked');
  assert.deepEqual(await searchActors('nick', async () => { throw new Error('offline'); }), [], 'offline: no suggestions, no error');
  assert.deepEqual(await searchActors('nick', async () => ({ ok: false })), []);
});
