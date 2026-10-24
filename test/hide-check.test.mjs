// Would Raku refuse this tile? (src/hide-check.js, a copy of Raku's moderation logic) with stand-in answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHideCheck, sha256Hex, accountKey, tileKey, parseCodedList, hidingLabel, BLUESKY_MODERATION, HIDE_LIST_URL } from '../src/hide-check.js';

const SALT = 'lexicographer.space hide list v1';
const D1 = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa';
const D2 = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb';
const D3 = 'did:plc:cccccccccccccccccccccccc';

async function list() {
  return { version: 1, salt: SALT, accounts: [await sha256Hex(accountKey(SALT, D1))], tiles: [await sha256Hex(tileKey(SALT, D2, 'hidden1'))] };
}
function stand({ listJson, listStatus = 200, profiles = {}, down = false } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (down) throw new Error('offline');
    const u = new URL(String(url));
    if (String(url) === HIDE_LIST_URL) return new Response(JSON.stringify(listJson), { status: listStatus });
    if (u.pathname === '/xrpc/app.bsky.actor.getProfile') {
      const p = profiles[u.searchParams.get('actor')];
      if (p === 'takedown') return new Response(JSON.stringify({ error: 'AccountTakedown' }), { status: 400 });
      return new Response(JSON.stringify({ did: u.searchParams.get('actor'), labels: p || [] }), { status: 200 });
    }
    return new Response('', { status: 404 });
  };
  return { fetchImpl, calls };
}

test('the agreed hashes (the same values as Raku and the viewer check)', async () => {
  assert.equal(await sha256Hex(accountKey(SALT, 'did:plc:abcdefghijklmnopqrstuvwx')), '5b3a74a95d6d6f1ec288eccbc232ce346ef37e956041671864d573ad0b84e008');
  assert.equal(await sha256Hex(tileKey(SALT, 'did:plc:abcdefghijklmnopqrstuvwx', '3mxxxxxxxxxxx')), '893853110c30e8cef1f4c15ae2f781fca0039225001e5153427d678b999ae66d');
});

test('the hide list: a hidden account, a hidden tile; others shown', async () => {
  const s = stand({ listJson: await list() });
  const h = createHideCheck({ fetchImpl: s.fetchImpl });
  assert.equal(await h.isHidden(D1, 'anything'), true);
  assert.equal(await h.isHidden(D2, 'hidden1'), true);
  assert.equal(await h.isHidden(D2, 'other'), false);
  assert.equal(await h.isHidden(D3, 'x'), false);
  assert.equal(s.calls.filter((c) => c === HIDE_LIST_URL).length, 1, 'downloaded once, then kept');
});

test('Bluesky\'s moderation: a taken-down account, a !hide label in force; negated or expired labels don\'t count', async () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  const s = stand({ listJson: await list(), profiles: {
    [D3]: 'takedown',
    'did:plc:dddddddddddddddddddddddd': [{ src: BLUESKY_MODERATION, val: '!hide' }],
    'did:plc:eeeeeeeeeeeeeeeeeeeeeeee': [{ src: BLUESKY_MODERATION, val: '!hide', neg: true }],
    'did:plc:ffffffffffffffffffffffff': [{ src: BLUESKY_MODERATION, val: '!takedown', exp: '2026-10-01T00:00:00Z' }],
    'did:plc:gggggggggggggggggggggggg': [{ src: 'did:plc:someoneelse', val: '!hide' }],
  } });
  const h = createHideCheck({ fetchImpl: s.fetchImpl, now: () => now });
  assert.equal(await h.isHidden(D3, 'x'), true);
  assert.equal(await h.isHidden('did:plc:dddddddddddddddddddddddd', 'x'), true);
  assert.equal(await h.isHidden('did:plc:eeeeeeeeeeeeeeeeeeeeeeee', 'x'), false);
  assert.equal(await h.isHidden('did:plc:ffffffffffffffffffffffff', 'x'), false);
  assert.equal(await h.isHidden('did:plc:gggggggggggggggggggggggg', 'x'), false);
  assert.equal(hidingLabel({ src: BLUESKY_MODERATION, val: '!takedown' }), true);
});

test('can\'t reach the list or Bluesky: the tile is shown; a copy kept in this browser is used next time', async () => {
  const down = stand({ down: true });
  assert.equal(await createHideCheck({ fetchImpl: down.fetchImpl }).isHidden(D1, 'x'), false);
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  await createHideCheck({ fetchImpl: stand({ listJson: await list() }).fetchImpl, storage }).isHidden(D3, 'x');
  assert.ok(store.size === 1, 'kept');
  assert.equal(await createHideCheck({ fetchImpl: down.fetchImpl, storage }).isHidden(D1, 'x'), true, 'the kept copy still hides');
});

test('a malformed list is not used', () => {
  assert.equal(parseCodedList({ version: 1, salt: 's', accounts: ['nothex'], tiles: [] }), null);
  assert.equal(parseCodedList({ version: 2, salt: 's', accounts: [], tiles: [] }), null);
  assert.equal(parseCodedList(null), null);
});
