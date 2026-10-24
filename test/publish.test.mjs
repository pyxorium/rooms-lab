// Publishing the house tile (scripts/publish.mjs) to a stand-in server (test/fake-pds.mjs, from daisy-tiles):
// the dry run, a Foundry-shaped record read back, the pin, the password check, --again, and the tile's files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPublish, ACCOUNT, tileToPublish } from '../scripts/publish.mjs';
import { TILES, publishFiles, fingerprint } from '../scripts/tiles.mjs';
import { createFakePds } from './fake-pds.mjs';
import { dagCborCid } from '../scripts/lib/dagcbor.js';
import { rawCid } from '../scripts/lib/cid.js';

const quiet = () => {};
function run(pds, opts = {}) {
  let published = opts.published || {};
  const writes = [];
  return runPublish({
    fetchImpl: pds.fetchImpl, log: quiet, ask: async () => opts.answer ?? 'y', askHidden: async () => opts.password ?? 'right-password',
    readPublished: () => published, writePublished: (o) => { published = o; writes.push(structuredClone(o)); },
    now: () => '2026-10-23T12:00:00.000Z', ...opts,
  }).then((r) => ({ ...r, writes, published }));
}

test('a dry run writes nothing and asks nothing', async () => {
  const pds = createFakePds({ did: ACCOUNT, handle: 'thunderbird.cafe' });
  const r = await run(pds, { dryRun: true, askHidden: async () => { throw new Error('asked'); } });
  assert.equal(r.changed, false);
  assert.deepEqual(r.plan.map((t) => t.id), ['house', 'poll']);
  assert.ok(!pds.calls.some((c) => c.includes('uploadBlob') || c.includes('Record')));
});

test('publishing the house: a Foundry-shaped record, every file read back, pinned by the record CID', async () => {
  const pds = createFakePds({ did: ACCOUNT, handle: 'thunderbird.cafe' });
  const r = await run(pds);
  assert.equal(r.changed, true);
  const p = r.published.house;
  assert.match(p.uri, new RegExp(`^at://${ACCOUNT}/ing.dasl.masl/`));
  assert.equal(r.published.account, ACCOUNT);
  assert.equal(r.published.handle, 'thunderbird.cafe');
  const rec = pds.records.get(`ing.dasl.masl/${p.uri.split('/').pop()}`);
  assert.equal(rec.cid, p.cid, 'pinned to the record CID the server gave');
  const value = rec.value;
  assert.equal(value.$type, 'ing.dasl.masl');
  assert.equal(value.cid, await dagCborCid(value.tile), 'the manifest address recomputes, as the Foundry checks');
  assert.equal(value.cid, p.manifestCid);
  assert.equal(value.tile.name, 'Rooms lab house');
  assert.equal(value.tile.generator, 'Rooms lab');
  assert.ok(value.tile.description.includes('thunderbird.cafe/webtiles/rooms-lab/'));
  assert.deepEqual(value.tile.icons, [{ src: '/icon.png' }]);
  assert.deepEqual(value.tile.screenshots, [{ src: '/banner.png' }]);
  assert.deepEqual(Object.keys(value.tile.resources).sort(), ['/', '/banner.png', '/house.css', '/house.js', '/icon.png', '/rules.js', '/talk.js']);
  const root = value.tile.resources['/'];
  assert.equal(root['content-type'], 'text/html');
  assert.match(root['content-security-policy'], /default-src 'self' blob: data:; script-src 'self'/);
  assert.match(root['content-security-policy'], /connect-src 'self'/, 'the house can\'t reach the network');
  for (const [path, entry] of Object.entries(value.tile.resources)) {
    const b = pds.blobs.get(entry.src.ref.$link);
    assert.ok(b, `${path} uploaded`);
    assert.equal(await rawCid(b.bytes), entry.src.ref.$link);
  }
});

test('published once: nothing to do; --again <tile>: a new record for that tile only; --again alone is refused', async () => {
  const pds = createFakePds({ did: ACCOUNT, handle: 'thunderbird.cafe' });
  const first = await run(pds);
  const second = await run(pds, { published: first.published });
  assert.equal(second.changed, false);
  await assert.rejects(run(pds, { published: first.published, again: true }), /Say which tile to publish again/);
  const again = await run(pds, { published: first.published, again: true, only: ['house'] });
  assert.equal(again.changed, true);
  assert.notEqual(again.published.house.uri, first.published.house.uri);
  assert.deepEqual(again.published.poll, first.published.poll, 'the poll is left as it was');
  await assert.rejects(run(pds, { only: ['nope'] }), /no tile called "nope"/);
});

test('one tile at a time: publishing the poll alone leaves the house as it is', async () => {
  const pds = createFakePds({ did: ACCOUNT, handle: 'thunderbird.cafe' });
  const house = { uri: `at://${ACCOUNT}/ing.dasl.masl/3house`, cid: 'bafyreihouse', manifestCid: 'm', publishedAt: 'then' };
  const r = await run(pds, { published: { account: ACCOUNT, handle: 'thunderbird.cafe', house }, only: ['poll'] });
  assert.equal(r.changed, true);
  assert.deepEqual(r.published.house, house);
  const value = pds.records.get(`ing.dasl.masl/${r.published.poll.uri.split('/').pop()}`).value;
  assert.equal(value.tile.name, 'Live poll');
  assert.deepEqual(Object.keys(value.tile.resources).sort(), ['/', '/banner.png', '/icon.png', '/live-talk.js', '/poll-state.js', '/poll.css', '/poll.js', '/ready.js']);
  assert.match(value.tile.resources['/']['content-security-policy'], /connect-src 'self'/, 'the poll can\'t reach the network');
  assert.ok(!/thunderbird\.cafe\/webtiles|rooms-lab\//.test(value.tile.description), 'the poll names no address');
});

test('a wrong password or "no" publishes nothing', async () => {
  const pds = createFakePds({ did: ACCOUNT, handle: 'thunderbird.cafe' });
  await assert.rejects(run(pds, { password: 'wrong' }), /Invalid identifier or password/);
  const no = await run(pds, { answer: 'n' });
  assert.equal(no.changed, false);
  assert.equal(no.writes.length, 0);
  assert.ok(!pds.calls.some((c) => c.includes('uploadBlob')));
});

test('the tile\'s files: its page, scripts and style, and the two card pictures (PNG); the fingerprint follows the code', async () => {
  const files = publishFiles('house');
  assert.deepEqual(files.map((f) => f.path), ['/', '/house.css', '/house.js', '/rules.js', '/talk.js', '/icon.png', '/banner.png']);
  for (const f of files.filter((x) => x.path.endsWith('.png'))) assert.deepEqual([...f.bytes.slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const t = await tileToPublish('house');
  assert.equal(t.sizing.width, TILES.house.sizing.width);
  assert.match(fingerprint('house'), /^memory:[0-9a-f]{24}$/);
});
