// The new-tile offer (0.10.0, src/new-tiles.js, and recent() in src/tile-records.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNewTileWatcher, tidTime, madeAt, offerWords, POLL_MS, SLACK_MS } from '../src/new-tiles.js';
import { createTileRecords } from '../src/tile-records.js';

const ALICE = 'did:plc:rqbqpaaluty5v47jwciowpik';
const BOB = 'did:plc:joer5rzmwgec3dkr4srfmq45';
const CID = 'bafyreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku';

// A TID for a time (ms), as atproto makes record keys.
const S32 = '234567abcdefghijklmnopqrstuvwxyz';
function tid(ms) {
  let v = (BigInt(Math.round(ms * 1000)) << 10n) | 7n;
  let out = '';
  for (let i = 0; i < 13; i++) { out = S32[Number(v & 31n)] + out; v >>= 5n; }
  return out;
}
const T0 = Date.UTC(2026, 9, 26, 18, 0, 0);
const tile = (name, ms, did = ALICE) => ({ uri: `at://${did}/ing.dasl.masl/${tid(ms)}`, rkey: tid(ms), cid: CID, name, createdAt: new Date(ms).toISOString() });

function watcher(o = {}) {
  let listed = o.listed || [];
  const offers = [], calls = [];
  let tick = null, cleared = false;
  const w = createNewTileWatcher({
    did: ALICE, since: T0, list: async (d) => { calls.push(d); if (o.fail) throw new Error('down'); return listed; },
    onOffer: (t) => offers.push(t.map((x) => x.name)), skip: o.skip, isVisible: () => (o.visible ?? true),
    setIntervalImpl: (f, ms) => { tick = f; assert.equal(ms, o.pollMs ?? POLL_MS); return { unref() {} }; },
    clearIntervalImpl: () => { cleared = true; }, ...(o.pollMs ? { pollMs: o.pollMs } : {}),
  });
  return { w, offers, calls, tick: () => tick(), set: (l) => { listed = l; }, cleared: () => cleared, o };
}

test('record keys: a TID gives its time; anything else none', () => {
  assert.equal(tidTime(tid(T0)), T0);
  assert.equal(tidTime('3myq4i2qx5c2c') > Date.UTC(2026, 0, 1), true, 'the owner\'s Sprite Walker from Oct 25');
  assert.equal(tidTime('3myq4i2qx5c2c') < Date.UTC(2026, 11, 1), true);
  for (const k of ['self', 'tile-1', '', null, 'zzzzzzzzzzzzz', '3myq4i2qx5c2']) assert.equal(tidTime(k), null, String(k));
  assert.equal(madeAt({ rkey: 'self', createdAt: '2026-10-26T18:00:00.000Z' }), T0, 'not a TID: createdAt');
  assert.equal(madeAt({ rkey: 'self' }), null);
});

test('the words: one tile, several, no name', () => {
  assert.deepEqual(offerWords([{ name: 'Twilight Sprite' }]), { name: 'Twilight Sprite', more: 0, tail: ' is now saved in your account.' });
  assert.deepEqual(offerWords([{ name: 'Twilight Sprite' }, {}, {}]), { name: 'Twilight Sprite', more: 2, tail: ' are now saved in your account.' });
  assert.equal(offerWords([{ name: '' }]).name, 'Your new tile');
  assert.equal(offerWords([]), null);
});

test('a look offers the tiles made since joining, newest first; older ones, other accounts and junk are left out', async () => {
  const { w, offers, calls } = watcher({ listed: [
    tile('Beach Sprite', T0 + 60_000), tile('Twilight Sprite', T0 + 120_000), tile('Old one', T0 - SLACK_MS - 1000),
    tile('Just before joining', T0 - 30_000), tile('Bob\'s', T0 + 5000, BOB), { uri: 'nonsense' }, null,
  ] });
  await w.visible();
  assert.deepEqual(calls, [ALICE]);
  assert.deepEqual(offers, [['Twilight Sprite', 'Beach Sprite', 'Just before joining']]);
  // The same answer again: no new offer drawn.
  await w.check();
  assert.equal(offers.length, 1);
});

test('the slow check: only while visible, and not while an offer waits', async () => {
  const s = watcher({ visible: false });
  s.tick(); await new Promise((r) => setImmediate(r));
  assert.equal(s.calls.length, 0, 'hidden: no look');
  s.o.visible = true;
  s.set([tile('Twilight Sprite', T0 + 1000)]);
  s.tick(); await new Promise((r) => setImmediate(r));
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.offers.at(-1), ['Twilight Sprite']);
  s.tick(); await new Promise((r) => setImmediate(r));
  assert.equal(s.calls.length, 1, 'an offer waits: the slow check pauses');
  await s.w.visible();
  assert.equal(s.calls.length, 2, 'coming back to the tab still looks');
  s.w.stop();
  assert.equal(s.cleared(), true);
});

test('Not now drops them for the visit; a newer tile gets a new offer', async () => {
  const s = watcher({ listed: [tile('Twilight Sprite', T0 + 1000)] });
  await s.w.visible();
  s.w.notNow();
  assert.deepEqual(s.offers.at(-1), []);
  await s.w.visible();
  assert.deepEqual(s.offers.at(-1), [], 'not offered again');
  s.set([tile('Beach Sprite', T0 + 9000), tile('Twilight Sprite', T0 + 1000)]);
  await s.w.visible();
  assert.deepEqual(s.offers.at(-1), ['Beach Sprite']);
});

test('Preview it takes one out of the offer for good; one already in the strip is never offered', async () => {
  const inStrip = new Set();
  const s = watcher({ listed: [tile('B', T0 + 2000), tile('A', T0 + 1000)], skip: (u) => inStrip.has(u) });
  await s.w.visible();
  assert.deepEqual(s.offers.at(-1), ['B', 'A']);
  s.w.take(s.w.offered[0].uri);
  assert.deepEqual(s.offers.at(-1), ['A']);
  await s.w.visible();
  assert.deepEqual(s.w.offered.map((t) => t.name), ['A'], 'the previewed one doesn\'t come back');
  inStrip.add(s.w.offered[0].uri);
  s.w.forget(s.w.offered[0].uri);
  assert.deepEqual(s.offers.at(-1), []);
  await s.w.visible();
  assert.deepEqual(s.w.offered, [], 'in the strip: skipped');
});

test('a server that doesn\'t answer: nothing offered, no error; looks don\'t pile up; stopped means stopped', async () => {
  const s = watcher({ fail: true });
  await s.w.visible();
  assert.deepEqual(s.offers, []);
  let release;
  const slow = createNewTileWatcher({ did: ALICE, since: T0, list: () => new Promise((r) => { release = r; }), setIntervalImpl: () => ({}), clearIntervalImpl: () => {} });
  const a = slow.check(), b = slow.check();
  assert.equal(a, b, 'one look at a time');
  release([]);
  await a;
  const st = watcher({ listed: [tile('X', T0 + 1)] });
  st.w.stop();
  await st.w.visible();
  assert.deepEqual(st.offers, []);
  assert.throws(() => createNewTileWatcher({ did: '', since: T0, list: async () => [] }));
});

test('the real timer is unref\'d (npm test must finish)', () => {
  let unrefd = false;
  const w = createNewTileWatcher({ did: ALICE, since: T0, list: async () => [], setIntervalImpl: () => ({ unref() { unrefd = true; } }), clearIntervalImpl: () => {} });
  w.stop();
  assert.equal(unrefd, true);
  const real = createNewTileWatcher({ did: ALICE, since: T0, list: async () => [] });
  real.stop();
});

test('recent(): the account\'s newest tile records from its own server, checked and trimmed', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(url);
    if (url === `https://plc.directory/${ALICE}`) return Response.json({ id: ALICE, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example' }] });
    if (url.startsWith('https://pds.example/xrpc/com.atproto.repo.listRecords?')) {
      return Response.json({ records: [
        { uri: `at://${ALICE}/ing.dasl.masl/${tid(T0)}`, cid: CID, value: { tile: { name: '  Twilight Sprite  ' }, createdAt: '2026-10-26T18:00:00.000Z' } },
        { uri: `at://${BOB}/ing.dasl.masl/${tid(T0)}`, cid: CID, value: { tile: { name: 'Not hers' } } },
        { uri: `at://${ALICE}/ing.dasl.masl/${tid(T0 - 1)}`, cid: 'not-a-cid', value: {} },
        { uri: `at://${ALICE}/app.bsky.feed.post/${tid(T0)}`, cid: CID, value: {} },
        { uri: `at://${ALICE}/ing.dasl.masl/${tid(T0 - 2)}`, cid: CID, value: { tile: { name: 42 } } },
      ] });
    }
    return new Response('', { status: 404 });
  };
  const recs = createTileRecords({ fetchImpl });
  const got = await recs.recent(ALICE, 10);
  assert.deepEqual(got.map((t) => [t.name, t.rkey]), [['Twilight Sprite', tid(T0)], ['', tid(T0 - 2)]]);
  assert.equal(got[0].uri, `at://${ALICE}/ing.dasl.masl/${tid(T0)}`);
  assert.equal(got[0].createdAt, '2026-10-26T18:00:00.000Z');
  const q = new URL(asked.find((u) => u.includes('listRecords')));
  assert.equal(q.searchParams.get('repo'), ALICE);
  assert.equal(q.searchParams.get('collection'), 'ing.dasl.masl');
  assert.equal(q.searchParams.get('limit'), '10');
  await assert.rejects(createTileRecords({ fetchImpl: async (u) => (u.includes('plc.directory') ? fetchImpl(u) : new Response('', { status: 500 })) }).recent(ALICE));
  await assert.rejects(createTileRecords({ fetchImpl: async () => new Response('', { status: 404 }) }).recent(ALICE));
});
