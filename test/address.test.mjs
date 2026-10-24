// The address box's forms (src/address.js, a copy of the tile-address part of Raku's): what people copy out
// of Raku, the viewers and other tile browsers. Adapted from Raku's test/address.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAddress, HINT } from '../src/address.js';

const DID = 'did:plc:6vxjigxrqizmbo56gojxico3';
const RKEY = '3mymx23m2nf24';
const URI = `at://${DID}/ing.dasl.masl/${RKEY}`;
const HANDLE_URI = `at://thunderbird.cafe/ing.dasl.masl/${RKEY}`;

test('at:// addresses, with a DID or a handle (as Raku shows them)', () => {
  assert.deepEqual(parseAddress(URI), { ok: true, actor: DID, rkey: RKEY, uri: URI });
  const r = parseAddress(`at://Thunderbird.Cafe/ing.dasl.masl/${RKEY}`);
  assert.deepEqual(r, { ok: true, actor: 'thunderbird.cafe', rkey: RKEY, uri: HANDLE_URI });
  assert.equal(parseAddress(`  ${URI}/  `).ok, true);
  assert.equal(parseAddress(`AT://${DID}/ing.dasl.masl/${RKEY}`).uri, URI);
});

test('other collections and broken addresses are refused with a reason', () => {
  assert.match(parseAddress(`at://${DID}/app.bsky.feed.post/${RKEY}`).reason, /isn.t a web tile/);
  assert.equal(parseAddress(`at://${DID}/ing.dasl.masl`).ok, false);
  assert.equal(parseAddress(`at://did:plc:short/ing.dasl.masl/${RKEY}`).ok, false);
  assert.equal(parseAddress(`at://${DID}/ing.dasl.masl/..`).ok, false);
  assert.match(parseAddress(`at://did:key:z6Mk/ing.dasl.masl/${RKEY}`).reason, /did:plc and did:web only/);
  assert.equal(parseAddress('').reason, HINT);
  assert.match(parseAddress('https://example.com/page').reason, /not other web pages/);
  assert.match(parseAddress(`at://%E0%A4%A/ing.dasl.masl/${RKEY}`).reason, /can.t be read|isn.t a handle/);
});

test('lexicographer.space, appmosphe.re and webtil.es links, and @handle/rkey', () => {
  for (const s of [
    `https://lexicographer.space/@thunderbird.cafe/${RKEY}`,
    `https://www.lexicographer.space/@thunderbird.cafe/${RKEY}`,
    `https://appmosphe.re/@thunderbird.cafe/${RKEY}`,
    `https://webtil.es/browser/#url=${HANDLE_URI}`,
    `https://webtil.es/browser/#url=${encodeURIComponent(HANDLE_URI)}`,
    `@thunderbird.cafe/${RKEY}`,
    `thunderbird.cafe/${RKEY}`,
  ]) assert.equal(parseAddress(s).uri, HANDLE_URI, s);
  assert.equal(parseAddress(`https://lexicographer.space/@${DID}/${RKEY}`).uri, URI);
  assert.equal(parseAddress('https://lexicographer.space/takedowns').ok, false);
});

test('Beaver\'s tile:// addresses; did:web lower-cased', () => {
  assert.equal(parseAddress(`tile://${RKEY}.${encodeURIComponent(DID)}/`).uri, URI);
  assert.equal(parseAddress(`tile://${RKEY}.${DID}/`).uri, URI);
  assert.equal(parseAddress(`TILE://${RKEY}.did%3Aweb%3AExample.com`).uri, `at://did:web:example.com/ing.dasl.masl/${RKEY}`);
  assert.equal(parseAddress('tile://nonsense/').ok, false);
});
