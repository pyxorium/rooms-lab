// Reading a tile's record and serving its files pinned (src/tile-records.js), with a stand-in fetch for
// plc.directory, a did:web document and a PDS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTileRecords, parseTileUri, rawCid, isRecordCid, LIMITS } from '../src/tile-records.js';
import { rawCid as foundryRawCid } from '../scripts/lib/cid.js';

const DID = 'did:plc:6vxjigxrqizmbo56gojxico3';
const PDS = 'https://pds.example.test';
const PAGE = new TextEncoder().encode('<!doctype html><p>hello</p>');
const CSS = new TextEncoder().encode('p { color: red }');
const RECORD_CID = 'bafyreicounteraaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

const DEFAULT_FILES = { [await rawCid(PAGE)]: PAGE, [await rawCid(CSS)]: CSS };
async function world({ size = PAGE.length, files = DEFAULT_FILES, page = PAGE, recordCid = RECORD_CID, extra = {} } = {}) {
  const pageCid = await rawCid(page);
  const cssCid = await rawCid(CSS);
  const manifest = {
    name: '  A counter  ', sizing: { width: 400, height: 300 },
    resources: {
      '/': { src: { $type: 'blob', ref: { $link: pageCid }, mimeType: 'text/html', size }, 'content-type': 'text/html', 'content-security-policy': "default-src 'self'" },
      '/style.css': { src: { $type: 'blob', ref: { $link: cssCid }, mimeType: 'text/css', size: CSS.length }, 'content-type': 'text/css' },
    },
    ...extra,
  };
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    if (u.origin === 'https://plc.directory') return json({ id: DID, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] });
    if (u.origin === 'https://alice.example.test') return json({ id: 'did:web:alice.example.test', service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] });
    if (u.pathname === '/xrpc/com.atproto.repo.getRecord') {
      if (u.searchParams.get('rkey') === 'missing') return json({ error: 'RecordNotFound' }, 400);
      return json({ uri: `at://${u.searchParams.get('repo')}/ing.dasl.masl/${u.searchParams.get('rkey')}`, cid: recordCid, value: { $type: 'ing.dasl.masl', tile: manifest } });
    }
    if (u.pathname === '/xrpc/com.atproto.sync.getBlob') {
      const f = files[u.searchParams.get('cid')];
      return f ? new Response(f, { status: 200 }) : new Response('', { status: 404 });
    }
    return new Response('', { status: 404 });
  };
  return { records: createTileRecords({ fetchImpl }), calls, pageCid };
}

test('tile addresses: did:plc and did:web; anything else is refused', () => {
  assert.deepEqual(parseTileUri(`at://${DID}/ing.dasl.masl/3myfnyphiuw2t`), { did: DID, rkey: '3myfnyphiuw2t' });
  assert.deepEqual(parseTileUri('at://did:web:alice.example.test/ing.dasl.masl/abc'), { did: 'did:web:alice.example.test', rkey: 'abc' });
  for (const bad of [`at://${DID}/app.bsky.feed.post/3abc`, 'https://example.com', `at://${DID}/ing.dasl.masl/`, `at://did:plc:short/ing.dasl.masl/x`, null, 42]) assert.equal(parseTileUri(bad), null, String(bad));
  assert.ok(isRecordCid(RECORD_CID));
  assert.ok(!isRecordCid('QmNotOne'));
});

test('the content address is the same as the Foundry\'s (and the PDS\'s)', async () => {
  assert.equal(await rawCid(PAGE), await foundryRawCid(PAGE));
});

test('reading a tile: its record from the author\'s server (found through plc.directory or did:web), its name, size and CID', async () => {
  const { records } = await world();
  const r = await records.read(`at://${DID}/ing.dasl.masl/3abc`);
  assert.equal(r.ok, true);
  assert.equal(r.cid, RECORD_CID);
  assert.equal(r.name, 'A counter');
  assert.equal(r.pds, PDS);
  assert.deepEqual(r.sizing, { width: 400, height: 300 });
  const web = await records.read('at://did:web:alice.example.test/ing.dasl.masl/3abc');
  assert.equal(web.ok, true);
});

test('refused: not a tile address, no such record, not a tile, too large to open for everyone', async () => {
  const { records } = await world();
  assert.match((await records.read('https://example.com')).why, /isn’t a tile address/);
  assert.match((await records.read(`at://${DID}/ing.dasl.masl/missing`)).why, /no tile at that address/);
  const big = await world({ size: LIMITS.maxBytes + 1 });
  assert.match((await big.records.read(`at://${DID}/ing.dasl.masl/3abc`)).why, /too large to open for everyone/);
  const notTile = await world({ recordCid: 'nope' });
  assert.match((await notTile.records.read(`at://${DID}/ing.dasl.masl/3abc`)).why, /isn’t a tile/);
});

test('the tile\'s files: served only as the record lists them, each checked against its address; a changed file is refused', async () => {
  const { records } = await world();
  const r = await records.read(`at://${DID}/ing.dasl.masl/3abc`);
  const seen = [];
  const loader = records.pathLoader({ pds: r.pds, did: r.did, manifest: r.manifest, onFile: (p, ok) => seen.push([p, ok]) });
  const page = await loader.resolvePath('/');
  assert.equal(page.ok, true);
  assert.equal(new TextDecoder().decode(page.body), '<!doctype html><p>hello</p>');
  assert.equal(page.headers['content-type'], 'text/html');
  assert.equal(page.headers['content-security-policy'], "default-src 'self'");
  assert.equal((await loader.resolvePath('/style.css')).ok, true);
  assert.equal((await loader.resolvePath('/not-listed.js')).ok, false);
  // a server handing back other bytes under the page's address
  const evil = new TextEncoder().encode('<script>steal()</script>');
  const swapped = await world({ files: { [await rawCid(PAGE)]: evil } });
  const r2 = await swapped.records.read(`at://${DID}/ing.dasl.masl/3abc`);
  const l2 = swapped.records.pathLoader({ pds: r2.pds, did: r2.did, manifest: r2.manifest, onFile: (p, ok) => seen.push([p, ok]) });
  assert.equal((await l2.resolvePath('/')).ok, false, 'not the pinned bytes');
  assert.deepEqual(seen.at(-1), ['/', false]);
});

test('the author\'s handle: shown only when it points back to the same account (checked both ways, as Raku)', async () => {
  const docs = {
    [DID]: { id: DID, alsoKnownAs: ['at://thunderbird.cafe'], service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] },
    'did:plc:pretenderpretenderpreten': { id: 'did:plc:pretenderpretenderpreten', alsoKnownAs: ['at://thunderbird.cafe'], service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] },
    'did:plc:nohandlenohandlenohandle': { id: 'did:plc:nohandlenohandlenohandle', service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] },
    'did:plc:wrongdocwrongdocwrongdoc': { id: 'did:plc:someoneelsesomeoneelseso', alsoKnownAs: ['at://thunderbird.cafe'], service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] },
  };
  let resolverDown = true;
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    if (u.origin === 'https://plc.directory') { const d = docs[decodeURIComponent(u.pathname.slice(1))]; return d ? json(d) : json({}, 404); }
    if (u.origin === 'https://public.api.bsky.app' && u.pathname === '/xrpc/com.atproto.identity.resolveHandle') {
      if (resolverDown) return json({ error: 'down' }, 502);
      return u.searchParams.get('handle') === 'thunderbird.cafe' ? json({ did: DID }) : json({ error: 'not found' }, 400);
    }
    return new Response('', { status: 404 });
  };
  const records = createTileRecords({ fetchImpl });
  assert.equal(await records.checkedHandle(DID), null, 'the resolver is down: no handle yet…');
  resolverDown = false;
  assert.equal(await records.checkedHandle(DID), 'thunderbird.cafe', '…and that wasn\'t kept: asked again, confirmed');
  const n = calls.length;
  assert.equal(await records.checkedHandle(DID), 'thunderbird.cafe');
  assert.equal(calls.length, n, 'a confirmed handle is kept');
  assert.equal(await records.checkedHandle('did:plc:pretenderpretenderpreten'), null, 'claims a handle that belongs to someone else');
  assert.equal(await records.checkedHandle('did:plc:nohandlenohandlenohandle'), null, 'names no handle');
  assert.equal(await records.checkedHandle('did:plc:wrongdocwrongdocwrongdoc'), null, 'the document is for another account');
  assert.equal(await records.pdsOf('did:plc:wrongdocwrongdocwrongdoc'), null, 'and its server isn\'t used either');
});

test('a handle becomes its DID (for the address box): only when it points both ways; failures to reach the resolver aren\'t kept', async () => {
  const PRETENDER = 'did:plc:pretenderpretenderpreten';
  const docs = {
    [DID]: { id: DID, alsoKnownAs: ['at://thunderbird.cafe'], service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] },
    [PRETENDER]: { id: PRETENDER, alsoKnownAs: ['at://someone.else.test'], service: [{ id: '#atproto_pds', serviceEndpoint: PDS }] },
  };
  let resolverDown = true;
  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    if (u.origin === 'https://plc.directory') { const d = docs[decodeURIComponent(u.pathname.slice(1))]; return d ? json(d) : json({}, 404); }
    if (u.origin === 'https://public.api.bsky.app' && u.pathname === '/xrpc/com.atproto.identity.resolveHandle') {
      if (resolverDown) return json({ error: 'down' }, 502);
      const h = u.searchParams.get('handle');
      if (h === 'thunderbird.cafe') return json({ did: DID });
      if (h === 'claims.someone.test') return json({ did: PRETENDER });       // resolves, but the account doesn't name it
      if (h === 'odd.answer.test') return json({ did: 'not a did' });
      return json({ error: 'not found' }, 400);
    }
    return new Response('', { status: 404 });
  };
  const records = createTileRecords({ fetchImpl });
  assert.deepEqual(await records.didFor(DID), { ok: true, did: DID }, 'a DID stays as it is, no lookup');
  assert.equal(calls.length, 0);
  assert.match((await records.didFor('thunderbird.cafe')).why, /right now|Couldn.t find/, 'the resolver is down…');
  resolverDown = false;
  assert.deepEqual(await records.didFor('thunderbird.cafe'), { ok: true, did: DID }, '…not kept: asked again, found, named back');
  const n = calls.length;
  assert.deepEqual(await records.didFor('Thunderbird.Cafe'), { ok: true, did: DID }, 'kept, and case doesn\'t matter');
  assert.equal(calls.length, n);
  assert.match((await records.didFor('claims.someone.test')).why, /doesn.t point back/);
  assert.match((await records.didFor('nobody.here.test')).why, /Couldn.t find the account @nobody\.here\.test/);
  assert.match((await records.didFor('odd.answer.test')).why, /Couldn.t find/);
  assert.match((await records.didFor('not a handle')).why, /isn.t a handle/);
});
