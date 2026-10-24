// check_site.mjs: the Rooms lab page the site's way (build step 5; the chat sandbox).
//
// What step 5 puts on thunderbird.cafe, as close as the sandbox allows:
//   - the house tile is published (scripts/publish.mjs, unchanged) to a stand-in for thunderbird.cafe's server
//     (test/fake-pds.mjs), and copy-to-site.mjs (unchanged) writes the site's src/rooms-lab/ and the page into
//     a scratch copy of the site, pinned to that record;
//   - the site's entry point (site/main.js) is bundled with the real @dasl/tile-loader (as Astro would), and
//     the page carries the site's security policy (site/page-csp.js), with the stand-in loading server's
//     addresses and the local relay put in for the real ones;
//   - tiles load through a replica of the tile loading server (test/loader-replica.mjs: the real server's own
//     files and headers, a fresh random name per tile on *.tiles.lex.localhost, port 80);
//   - the real relay code runs locally (relay/server.js), letting in this page only.
// Checks: the house runs through the real loader on the host's page and decides (Robin's request to present
// goes to Nick's approval card with the house's reason); a tile previewed and opened for everyone runs
// through the real loader on both pages, each copy its own; the page breaks none of its own security policy;
// a house whose record changed after it was pinned isn't used (the room says it has no house).
//
// Run (sandbox): NODE_PATH=<node_modules with playwright, esbuild, ws> node test/browser/check_site.mjs
//   <tiles-loading-server folder> <node_modules with @dasl/tile-loader and its packages> <site's src/lib/tile-load-domain.js>
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import { createRelayServer } from '../../relay/server.js';
import { createFakePds, PDS } from '../fake-pds.mjs';
import { runPublish, ACCOUNT } from '../../scripts/publish.mjs';
import { siteFiles } from '../../scripts/copy-to-site.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const [LOADING_SERVER, LOADER_MODULES, LOAD_DOMAIN_FILE] = process.argv.slice(2);
if (!LOADING_SERVER || !LOADER_MODULES || !LOAD_DOMAIN_FILE) { console.error('Usage: node test/browser/check_site.mjs <tiles-loading-server> <node_modules> <tile-load-domain.js>'); process.exit(1); }
const require = createRequire(import.meta.url);
const esbuild = require('esbuild');
const step = (s) => console.log(`- ${s}`);
const REPLICA = 'http://load.tiles.lex.localhost/.well-known/web-tiles/';

// ---- thunderbird.cafe's server (a stand-in): the house published as the owner will, and a counter tile ----
const pds = createFakePds({ did: ACCOUNT, handle: 'thunderbird.cafe' });
const pub = await runPublish({ fetchImpl: pds.fetchImpl, ask: async () => 'y', askHidden: async () => 'right-password', log: () => {},
  readPublished: () => ({}), writePublished: () => {} });
assert.ok(pub.changed && pub.published.house?.uri, 'the house published to the stand-in');
const auth = { Authorization: 'Bearer fake-jwt' };
const COUNTER = new TextEncoder().encode('<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;margin:12px"><p>Counter</p><button id="b">0</button><script>b.onclick=()=>{b.textContent=String(+b.textContent+1)}</script>');
const blob = await (await pds.fetchImpl(`${PDS}/xrpc/com.atproto.repo.uploadBlob`, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/html' }, body: COUNTER })).json();
const counter = await (await pds.fetchImpl(`${PDS}/xrpc/com.atproto.repo.createRecord`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ repo: ACCOUNT, collection: 'ing.dasl.masl', record: { $type: 'ing.dasl.masl', tile: { name: 'Counter', sizing: { width: 400, height: 220 },
    resources: { '/': { src: blob.blob, 'content-type': 'text/html' } } }, createdAt: '2026-10-24T00:00:00.000Z' } }) })).json();
assert.ok(counter.uri, 'the counter tile');

// ---- the site's copy, as copy-to-site.mjs writes it, bundled as Astro would ----
const SITE = mkdtempSync(pathJoin(tmpdir(), 'rooms-site-'));
mkdirSync(pathJoin(SITE, 'src', 'lib'), { recursive: true });
copyFileSync(LOAD_DOMAIN_FILE, pathJoin(SITE, 'src', 'lib', 'tile-load-domain.js'));
const { files } = siteFiles(pub.published);
for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(pathJoin(SITE, rel)), { recursive: true }); writeFileSync(pathJoin(SITE, rel), text); }
const bundle = await esbuild.build({ entryPoints: [pathJoin(SITE, 'src', 'rooms-lab', 'main.js')], bundle: true, format: 'esm', platform: 'browser',
  write: false, logLevel: 'silent', nodePaths: [LOADER_MODULES, ...(process.env.NODE_PATH || '').split(':').filter(Boolean)] });
const { pageCsp } = await import(pathJoin(SITE, 'src', 'rooms-lab', 'page-csp.js'));
const { TILE_LOAD_DOMAIN } = await import(pathJoin(SITE, 'src', 'lib', 'tile-load-domain.js'));
// The site's policy, with the stand-ins' addresses for the real ones (the replica is http on *.localhost; the
// relay here is ws:// on this computer). Nothing else is loosened.
const csp = pageCsp(TILE_LOAD_DOMAIN)
  .replaceAll(`https://${TILE_LOAD_DOMAIN}`, 'http://load.tiles.lex.localhost')
  .replaceAll(`https://*.${TILE_LOAD_DOMAIN.replace(/^load\./, '')}`, 'http://*.tiles.lex.localhost')
  .replace("connect-src 'self' https: wss:", "connect-src 'self' https: wss: ws://127.0.0.1:*");
assert.ok(csp.includes('http://load.tiles.lex.localhost') && csp.includes('ws://127.0.0.1:*'), 'the policy was adapted');
const astro = files['src/pages/webtiles/rooms-lab/index.astro'];
assert.ok(astro.includes('<div id="room">') && astro.includes("import '../../../rooms-lab/main.js'"));
const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Rooms lab</title>
<link rel="stylesheet" href="/room.css"><style>html, body { margin: 0; background: #171411; }</style></head>
<body><div id="room"></div><script type="module" src="/page.js"></script></body></html>`;
const SERVE = { '/': ['text/html; charset=utf-8', HTML], '/page.js': ['text/javascript; charset=utf-8', bundle.outputFiles[0].text],
  '/room.css': ['text/css; charset=utf-8', files['src/rooms-lab/room.css']] };
const web = http.createServer((req, res) => {
  const f = SERVE[new URL(req.url, 'http://x').pathname];
  if (!f) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': f[0], 'cache-control': 'no-store' });
  res.end(f[1]);
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${web.address().port}`;
const relay = createRelayServer({ port: 0, host: '127.0.0.1', allowedOrigins: [ORIGIN], log: () => {} });
const relayPort = await relay.listen();
const PAGE = `${ORIGIN}/?relay=${encodeURIComponent(`ws://127.0.0.1:${relayPort}/`)}&loader=${encodeURIComponent(REPLICA)}`;
const replica = spawn('node', [pathJoin(HERE, '..', 'loader-replica.mjs'), LOADING_SERVER, '80'], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise((resolve, reject) => { replica.stdout.on('data', (d) => /loader replica on/.test(String(d)) && resolve()); replica.on('exit', () => reject(new Error('the loader replica stopped'))); });

// ---- the browser ----
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const CORS = { 'access-control-allow-origin': '*' };
async function standIns(ctx, { houseCid = null } = {}) {
  // thunderbird.cafe's server and plc.directory: the stand-in above (real records, real CIDs).
  const viaPds = async (route) => {
    const req = route.request();
    const res = await pds.fetchImpl(req.url(), { method: req.method(), headers: req.headers(), body: req.postDataBuffer() || undefined });
    let body = Buffer.from(await res.arrayBuffer());
    if (houseCid && req.url().includes('com.atproto.repo.getRecord') && req.url().includes(pub.published.house.uri.split('/').pop())) {
      const j = JSON.parse(String(body)); j.cid = houseCid; body = Buffer.from(JSON.stringify(j));       // the house changed since it was pinned
    }
    return route.fulfill({ status: res.status, headers: { ...CORS, 'content-type': res.headers.get('content-type') || 'application/octet-stream' }, body });
  };
  await ctx.route('https://plc.directory/**', viaPds);
  await ctx.route(`${PDS}/**`, viaPds);
  const json = (route, body) => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await ctx.route('https://lexicographer.space/hidden-tiles.json', (route) => json(route, { version: 1, salt: 'test salt', accounts: [], tiles: [] }));
  await ctx.route('https://public.api.bsky.app/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/xrpc/com.atproto.identity.resolveHandle') return json(route, { did: ACCOUNT });
    return json(route, { did: u.searchParams.get('actor'), handle: 'thunderbird.cafe', labels: [] });
  });
}
async function person(name, opts) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  await standIns(ctx, opts);
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  return { name, ctx, page };
}
const until = (p, fn, arg, ms = 20000) => p.page.waitForFunction(fn, arg, { timeout: ms, polling: 100 });
async function join(p, link, button) {
  await p.page.goto(link);
  await p.page.fill('.rl-name', p.name);
  await p.page.click(`button:has-text("${button}")`);
  await until(p, () => window.__roomsLab.room?.link.joined === true);
}
const houseIs = (p, st) => until(p, (s) => document.querySelector('.rl-house-line')?.dataset.house === s, st);
const tileCard = (p) => p.page.locator(`.rl-tile[data-uri="${counter.uri}"]`);
const tileIs = (p, st) => until(p, ([u, s]) => document.querySelector(`.rl-tile[data-uri="${u}"]`)?.dataset.state === s, [counter.uri, st]);
const frameHost = (p, sel) => p.page.evaluate((s) => { const f = document.querySelector(s); return f ? new URL(f.src).hostname : null; }, sel);
// A tile through the real loader: its page runs inside the loading server's frame.
const counterButton = (p) => tileCard(p).locator('iframe').contentFrame().locator('iframe').contentFrame().locator('#b');

try {
  step('the copy: copy-to-site.mjs wrote the modules, the entry point and the page, pinned to the published house');
  assert.ok(files['src/rooms-lab/published.generated.js'].includes(pub.published.house.cid));

  step('Nick makes a room on the site\'s page: the published house loads through the real tile loader, from the loading server, and says hello');
  const nick = await person('Nick');
  await join(nick, PAGE, 'New room');
  await houseIs(nick, 'ready');
  const houseHost = await frameHost(nick, '.rl-house-mount iframe, [class*="house"] iframe');
  assert.equal(houseHost, 'load.tiles.lex.localhost', 'the house comes from the loading server (which sends it on to a fresh random name)');

  step('Robin joins from the invite link and asks to present: the house decides "ask the host", and Nick gets the approval card with its reason');
  const robin = await person('Robin');
  await join(robin, await nick.page.inputValue('.rl-invite'), 'Join room');
  await robin.page.click('.rl-share');
  const card = nick.page.locator('.rl-approval', { hasText: 'Robin asks to present their screen.' });
  await card.waitFor({ timeout: 20000 });
  assert.match(await card.textContent(), /House: The host approves/);
  assert.ok(await nick.page.evaluate(() => window.__roomsLab.room.log.some((l) => /⌂ Robin: present: ask-host/.test(l))), 'the house\'s decision is logged');
  await card.locator('button', { hasText: 'Deny' }).click();

  step('Nick previews a tile: it runs through the real loader on his page only, with its author\'s handle');
  await nick.page.fill('.rl-tile-input', counter.uri);
  await nick.page.click('.rl-tile-preview-go');
  await tileIs(nick, 'open');
  assert.equal(await frameHost(nick, `.rl-tile[data-uri="${counter.uri}"] iframe`), 'load.tiles.lex.localhost');
  await until(nick, (u) => document.querySelector(`.rl-tile[data-uri="${u}"] .rl-tile-author`)?.textContent === 'by @thunderbird.cafe', counter.uri);
  await counterButton(nick).click();
  assert.equal(await counterButton(nick).textContent(), '1');

  step('Nick opens it for everyone: his preview becomes his card (still at 1); Robin\'s page loads its own copy through the real loader');
  await tileCard(nick).locator('.rl-tile-open').click();
  await tileIs(robin, 'open');
  assert.equal(await counterButton(nick).textContent(), '1');
  assert.equal(await counterButton(robin).textContent(), '0');
  await counterButton(robin).click();
  await counterButton(robin).click();
  assert.equal(await counterButton(robin).textContent(), '2');
  assert.equal(await counterButton(nick).textContent(), '1');

  step('live: the poll (published by publish.mjs) opened for everyone and shared live, through the real loader and the loading server\'s shuttle');
  const POLL = pub.published.poll.uri;
  const pollCard = (p) => p.page.locator(`.rl-tile[data-uri="${POLL}"]`);
  const pollFrame = (p) => pollCard(p).locator('iframe').contentFrame().locator('iframe').contentFrame();
  const pollStatus = (p, text) => pollFrame(p).locator('#status', { hasText: text }).waitFor({ timeout: 20000 });
  await nick.page.fill('.rl-tile-input', POLL);
  await nick.page.click('.rl-tile-preview-go');
  await until(nick, (u) => document.querySelector(`.rl-tile[data-uri="${u}"]`)?.dataset.state === 'open', POLL);
  await pollStatus(nick, 'Just you.');
  await pollCard(nick).locator('.rl-tile-open').click();
  await until(robin, (u) => document.querySelector(`.rl-tile[data-uri="${u}"]`)?.dataset.state === 'open', POLL);
  await pollStatus(robin, 'Just you.');
  await until(nick, (u) => !document.querySelector(`.rl-tile[data-uri="${u}"] .rl-tile-live-on`)?.hidden, POLL);
  await pollCard(nick).locator('.rl-tile-live-on').click();
  for (const p of [nick, robin]) await pollStatus(p, 'Live · 2 here');
  await pollFrame(nick).locator('select').selectOption('1');
  await pollFrame(nick).locator('button', { hasText: 'Start poll' }).click();
  await pollFrame(robin).locator('.poll h1', { hasText: 'Can you see the shared screen?' }).waitFor({ timeout: 20000 });
  await pollFrame(robin).locator('.vote').nth(0).click();
  await pollFrame(nick).locator('.vote').nth(0).click();
  for (const p of [nick, robin]) await pollFrame(p).locator('.tally', { hasText: '2 votes · 2 here' }).waitFor({ timeout: 20000 });
  assert.deepEqual(await pollFrame(nick).locator('.count').allTextContents(), ['2', '0', '0']);
  assert.ok(await nick.page.evaluate(() => window.__roomsLab.room.log.some((l) => /⌂ You: live \("Live poll"\): allow — The host may share tiles live\./.test(l))), 'the published house decided');

  step('the page broke none of its own security policy');
  for (const p of [nick, robin]) assert.deepEqual(await p.page.evaluate(() => window.__csp), [], p.name);

  step('a house whose record changed after it was pinned isn\'t used: the room says it has no house (the host approves each request)');
  const cal = await person('Cal', { houseCid: `bafyrei${'c'.repeat(52)}` });
  const seen = [];
  cal.page.on('console', (m) => seen.push(m.text()));
  await join(cal, PAGE, 'New room');
  await houseIs(cal, 'failed');
  assert.match(await cal.page.locator('.rl-house-line').textContent(), /No house tile: you approve each request yourself\./);
  assert.ok(seen.some((t) => /the house tile has changed/.test(t)), 'it says why, in the console');

  await browser.close();
  // Known and not this page's: the loading server's own header names "form-src", which browsers don't know
  // (the real server sends the same; it was meant as form-action). Reported to the owner, Oct 24.
  const unexpected = errors.filter((e) => !/data\.js/.test(e) && !/Unrecognized Content-Security-Policy directive 'form-src'/.test(e));
  assert.deepEqual(unexpected, [], 'page errors');
  console.log('\nAll site checks passed.');
} catch (e) {
  console.error('\nFAILED:', e.message);
  if (errors.length) console.error('Page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  replica.kill();
  await relay.close();
  web.close();
}
