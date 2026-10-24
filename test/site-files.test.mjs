// What copy-to-site.mjs puts into the site (build step 5): every page module, the site's entry point, the
// pinned house, and the page; nothing without a published house; every import inside the copy resolves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { siteFiles, pinnedFrom, MODULES } from '../scripts/copy-to-site.mjs';
import { pageCsp } from '../site/page-csp.js';

const PUBLISHED = {
  account: 'did:plc:6vxjigxrqizmbo56gojxico3', handle: 'thunderbird.cafe',
  house: { uri: 'at://did:plc:6vxjigxrqizmbo56gojxico3/ing.dasl.masl/3house', cid: `bafyrei${'h'.repeat(52)}`, manifestCid: 'x', publishedAt: '2026-10-24T00:00:00.000Z' },
};

test('no published house: nothing is copied (publish first, so the live page never goes up without it)', () => {
  assert.throws(() => siteFiles(null), /Publish it first/);
  assert.throws(() => siteFiles({}), /Publish it first/);
  assert.equal(pinnedFrom({ house: { uri: 'at://x' } }), null);
});

test('the copy: every module, the entry point, the policy, the pinned house and the page', async () => {
  const { files, pinned } = siteFiles(PUBLISHED);
  assert.deepEqual(pinned, { account: PUBLISHED.account, house: { uri: PUBLISHED.house.uri, cid: PUBLISHED.house.cid } });
  for (const m of MODULES) assert.match(files[`src/rooms-lab/${m}`], /^\/\/ COPY of rooms-lab\/src\//, m);
  for (const m of ['main.js', 'page-csp.js']) assert.match(files[`src/rooms-lab/${m}`], /^\/\/ COPY of rooms-lab\/site\//, m);
  assert.match(files['src/rooms-lab/room.css'], /^\/\* COPY of rooms-lab\/src\/room\.css/);
  const gen = files['src/rooms-lab/published.generated.js'];
  assert.ok(gen.includes(PUBLISHED.house.uri) && gen.includes(PUBLISHED.house.cid));
  assert.ok(!gen.includes('manifestCid'), 'only the address and CID');
  const page = files['src/pages/webtiles/rooms-lab/index.astro'];
  assert.match(page, /^---\n\/\/ COPY of rooms-lab\/site\/index\.astro/);
  assert.match(page, /import '\.\.\/\.\.\/\.\.\/rooms-lab\/main\.js'/);
  assert.match(page, /<meta name="robots" content="noindex, nofollow" \/>/);
  assert.match(page, /import\.meta\.env\.PROD \? pageCsp\(TILE_LOAD_DOMAIN\) : null/);
});

test('every import inside the copy points at a file it writes (or the site\'s loader and loading domain)', () => {
  const { files } = siteFiles(PUBLISHED);
  const outside = new Set(['@dasl/tile-loader', '../lib/tile-load-domain.js']);
  for (const [path, text] of Object.entries(files)) {
    if (!path.startsWith('src/rooms-lab/') || !path.endsWith('.js')) continue;
    for (const m of text.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'/gm)) {
      const spec = m[1];
      if (outside.has(spec)) continue;
      assert.ok(spec.startsWith('./') && files[`src/rooms-lab/${spec.slice(2)}`] !== undefined, `${path} imports ${spec}`);
    }
  }
});

test('the page\'s security policy: scripts only from the site, frames only from the loading server, connections over https and wss', () => {
  const csp = pageCsp('load.tiles.lexicographer.space');
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-src https:\/\/load\.tiles\.lexicographer\.space https:\/\/\*\.tiles\.lexicographer\.space/);
  assert.match(csp, /connect-src 'self' https: wss:/);
  assert.match(csp, /object-src 'none'/);
});
