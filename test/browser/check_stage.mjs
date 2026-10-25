// check_stage.mjs: build step 9's browser check (claude/rooms-lab-step9.md): tiles on the stage, the page's own
// "Screen" / "Tile" badges, the stage keeping one size, the messages inside it, full screen.
//
//   - the empty stage: "Nothing on the stage…" inside the box, the host's and a guest's hints;
//   - Nick (host) opens a tile: on the stage for everyone (his card laid over the stage's box, never moved), the
//     status lines name it, the box keeps its size; a second tile takes its place and the first drops back
//     into the list, still running;
//   - Robin's approved tile goes into the list, not the stage; Nick's "Put on stage"; a tile named like a
//     screen still wears the "Tile" badge; full screen and back;
//   - Ted joins late and finds the tile on the stage; a guest's forged "stage" message is ignored;
//   - Robin hides the staged tile for herself; the host has no "Hide for me" on the staged tile;
//   - Robin shares her screen: the screen takes the stage on every page; Nick puts a tile on the stage over it,
//     then "Back to screen"; she stops; Nick's reload keeps the stage; "Close for everyone" empties it;
//   - phone width: no sideways scroll, the card still over the stage.
// Same stand-ins as check_room.mjs (tile servers, the tile loader), the real relay and dev page.
//
//   node test/browser/check_stage.mjs           (needs Playwright with Chromium; not part of npm test)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { startDev } from '../../dev/serve.mjs';
import { rawCid } from '../../scripts/lib/cid.js';
import { sha256Hex, tileKey, HIDE_LIST_URL } from '../../src/hide-check.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import('playwright')); }

const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen', '--autoplay-policy=no-user-gesture-required'];
const step = (s) => console.log(`- ${s}`);

const dev = await startDev({ port: 0, relayPort: 0, quiet: true });
const PAGE = `${dev.url}?relay=${encodeURIComponent(dev.relayUrl)}`;
const browser = await chromium.launch({ args: ARGS });
const errors = [];
// The one expected error: the house first looks for a tile loader's data.js (there's none on the dev page),
// then talks with plain messages.
const DATA_JS = '/.well-known/web-tiles/data.js';

// ---- Stand-ins for the tiles' servers ----
const TILE_DID = 'did:plc:tiletiletiletiletiletile';
const TILE_PDS = 'https://pds.tiles.test';
const SALT = 'lexicographer.space hide list v1';
const counterPage = (label) => `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;margin:12px"><p>${label}</p><button id="b">0</button><script>b.onclick=()=>{b.textContent=String(+b.textContent+1)}</script>`;
const TILES = {
  stagea: { name: 'Counter A', letter: 'q' }, stageb: { name: 'Counter B', letter: 'r' },
  // A tile that names itself like a screen: the page's own "Tile" badge still says what it is.
  spoof1: { name: 'Nick’s screen', letter: 's' }, hidden1: { name: 'Hidden', letter: 't' },
};
for (const [rkey, t] of Object.entries(TILES)) {
  t.bytes = new TextEncoder().encode(counterPage(t.name));
  t.blobCid = await rawCid(t.bytes);
  t.cid = `bafyrei${t.letter.repeat(52)}`;
}
// other1 is by an account whose handle doesn't point back to it (so its handle isn't shown).
const OTHER_DID = 'did:plc:otherotherotherotherothe';
const didOf = (rkey) => (TILES[rkey]?.did === 'other' ? OTHER_DID : TILE_DID);
const uriOf = (rkey) => `at://${didOf(rkey)}/ing.dasl.masl/${rkey}`;
const HIDE_LIST = { version: 1, salt: SALT, accounts: [], tiles: [await sha256Hex(tileKey(SALT, TILE_DID, 'hidden1'))] };
const recordReads = new Map();
const CORS = { 'access-control-allow-origin': '*' };
async function standIns(ctx) {
  const json = (route, body, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await ctx.route('https://plc.directory/**', (route) => {
    const did = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    const handle = did === OTHER_DID ? 'pretender.test' : 'tiles.test';
    return json(route, { id: did, alsoKnownAs: [`at://${handle}`], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: TILE_PDS }] });
  });
  await ctx.route(`${TILE_PDS}/**`, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/xrpc/com.atproto.repo.getRecord') {
      const rkey = u.searchParams.get('rkey'), t = TILES[rkey];
      if (!t) return json(route, { error: 'RecordNotFound' }, 400);
      const n = (recordReads.get(rkey) || 0) + 1;
      recordReads.set(rkey, n);
      const cid = t.changesAfter && n > t.changesAfter ? `bafyrei${'v'.repeat(52)}` : t.cid;    // changed after that many reads
      const manifest = { name: t.name, sizing: { width: 400, height: 220 }, resources: { '/': { src: { $type: 'blob', ref: { $link: t.blobCid }, mimeType: 'text/html', size: t.bytes.length }, 'content-type': 'text/html' } } };
      return json(route, { uri: uriOf(rkey), cid, value: { $type: 'ing.dasl.masl', cid: t.cid, tile: manifest, createdAt: '2026-10-23T12:00:00.000Z' } });
    }
    if (u.pathname === '/xrpc/com.atproto.sync.getBlob') {
      const t = Object.values(TILES).find((x) => x.blobCid === u.searchParams.get('cid'));
      if (!t) return route.fulfill({ status: 404, headers: CORS, body: '' });
      const body = t.badBlob ? Buffer.from('<p>not what the record says</p>') : Buffer.from(t.bytes);
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': '*/*' }, body });
    }
    return route.fulfill({ status: 404, headers: CORS, body: '' });
  });
  await ctx.route(HIDE_LIST_URL, (route) => json(route, HIDE_LIST));
  await ctx.route('https://public.api.bsky.app/**', (route) => {
    const u = new URL(route.request().url());
    // resolveHandle: tiles.test and pretender.test both belong to TILE_DID (so pretender.test doesn't point back to OTHER_DID).
    if (u.pathname === '/xrpc/com.atproto.identity.resolveHandle') return json(route, { did: TILE_DID });
    return json(route, { did: u.searchParams.get('actor'), handle: 'someone.test', labels: [] });
  });
}
// The stand-in tile loader: the tile's page (from the page's own pinned file loader) in a sealed frame.
const STANDIN_TILE_HOST = () => {
  window.__roomsLabTileHost = {
    async render({ loader }) {
      const r = await loader.resolvePath('/');
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      if (r.ok) f.srcdoc = new TextDecoder().decode(r.body);
      return f;
    },
  };
};

async function person(name, { tiles = true } = {}) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  await standIns(ctx);
  if (tiles) await ctx.addInitScript(STANDIN_TILE_HOST);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().includes(DATA_JS) || (m.location()?.url || '').includes(DATA_JS)) return;
    errors.push(`${name} console: ${m.text()}`);
  });
  return { name, ctx, page };
}
const until = async (p, fn, arg, ms = 15000) => p.page.waitForFunction(fn, arg, { timeout: ms, polling: 100 });
const status = (p) => p.page.locator('.rl-status').first().textContent();
const waitStatus = (p, re, ms) => until(p, (src) => new RegExp(src).test(document.querySelector('.rl-status')?.textContent || ''), re.source, ms);
const row = (p, name) => p.page.locator('.rl-person', { has: p.page.locator('.rl-who', { hasText: name }) });
const room = (p, expr, arg) => p.page.evaluate(expr, arg);
const approval = (p, text) => p.page.locator('.rl-approval', { hasText: text });
const promptShown = (p) => until(p, () => !document.querySelector('.rl-prompt').hidden);
const sharing = (p) => room(p, () => !!window.__roomsLab.room.screenTrack);
const logHas = (p, re) => room(p, (src) => window.__roomsLab.room.log.some((l) => new RegExp(src).test(l)), re.source);

async function join(p, link, button) {
  await p.page.goto(link);
  await p.page.fill('.rl-name', p.name);
  await p.page.click(`button:has-text("${button}")`);
  await until(p, () => window.__roomsLab.room?.link.joined === true);
}

// Bytes of audio received from `from`'s connection, now.
const audioIn = (p, fromName) => p.page.evaluate(async (who) => {
  const r = window.__roomsLab.room;
  const peer = [...r.people.values()].find((x) => x.name === who)?.peer;
  const pc = r.mesh.connection(peer);
  if (!pc) return -1;
  let n = 0;
  (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') n += s.bytesReceived || 0; });
  return n;
}, fromName);
async function hears(p, fromName) {
  const a = await audioIn(p, fromName);
  await p.page.waitForTimeout(1200);
  const b = await audioIn(p, fromName);
  return b > a && a >= 0;
}
const stageShows = (p) => until(p, () => { const v = document.querySelector('.rl-video'); return v && !v.hidden && v.videoWidth > 0; }, undefined, 20000);
const stageClear = (p) => until(p, () => document.querySelector('.rl-video').hidden && document.querySelector('.rl-stage').dataset.on === 'empty' && /^Nothing on the stage: nobody is sharing their screen, and no tile is on the stage\.$/.test(document.querySelector('.rl-stage-line').textContent));
// Step 9: a tile on the stage: its card laid over the stage's box (same place, same size), the page's "Tile" badge.
const stageHasTile = (p, uri) => until(p, (u) => {
  const st = document.querySelector('.rl-stage');
  const card = document.querySelector(`.rl-tile[data-uri="${u}"]`);
  if (st.dataset.on !== 'tile' || !card || !card.classList.contains('rl-tile-on-stage')) return false;
  const a = st.getBoundingClientRect(), b = card.getBoundingClientRect();
  return Math.abs(a.top - b.top) < 2 && Math.abs(a.left - b.left) < 2 && Math.abs(a.width - b.width) < 2 && Math.abs(a.height - b.height) < 2
    && !card.querySelector('.rl-stage-badge-tile').hidden && !!document.querySelector(`.rl-tile-placeholder[data-uri="${u}"]`);
}, uri);

const tileCard = (p, rkey) => p.page.locator(`.rl-tile[data-uri="${uriOf(rkey)}"]`);
const tileIs = (p, rkey, state) => until(p, ([u, st]) => document.querySelector(`.rl-tile[data-uri="${u}"]`)?.dataset.state === st, [uriOf(rkey), state], 20000);
const counter = (p, rkey) => p.page.frameLocator(`.rl-tile[data-uri="${uriOf(rkey)}"] iframe`).locator('#b');
const markFrame = (p, rkey) => room(p, (u) => { document.querySelector(`.rl-tile[data-uri="${u}"] iframe`).dataset.mark = 'kept'; }, uriOf(rkey));
const sameFrame = (p, rkey) => room(p, (u) => document.querySelector(`.rl-tile[data-uri="${u}"] iframe`)?.dataset.mark === 'kept', uriOf(rkey));
const onStageIs = (p, what) => until(p, (w) => document.querySelector('.rl-stage').dataset.on === w, what);
const stageHeight = (p) => room(p, () => Math.round(document.querySelector('.rl-stage').getBoundingClientRect().height));
const badge = (p) => room(p, () => { const b = document.querySelector('.rl-stage-bar .rl-stage-badge'); return b.hidden ? null : b.textContent; });
const inList = (p, rkey) => until(p, (u) => { const c = document.querySelector(`.rl-tile[data-uri="${u}"]`); return c && !c.classList.contains('rl-tile-on-stage') && !c.style.position && !document.querySelector(`.rl-tile-placeholder[data-uri="${u}"]`); }, uriOf(rkey));
async function openTile(p, rkey) {
  await p.page.fill('.rl-tile-input', uriOf(rkey));
  await p.page.click('.rl-tile-preview-go');
  await tileIs(p, rkey, 'open');
  await tileCard(p, rkey).locator('.rl-tile-open').click();
}

try {
  const nick = await person('Nick'), robin = await person('Robin'), ted = await person('Ted');
  for (const p of [nick, robin, ted]) await p.page.setViewportSize({ width: 1280, height: 900 });
  globalThis.__people = [nick, robin, ted];

  step('the empty stage says so inside the box: the line, and the host\'s and a guest\'s hints');
  await join(nick, PAGE, 'New room');
  await until(nick, () => document.querySelector('.rl-house-line').dataset.house === 'ready');
  const invite = await nick.page.inputValue('.rl-invite');
  await join(robin, invite, 'Join room');
  for (const p of [nick, robin]) await stageClear(p);
  assert.equal(await nick.page.locator('.rl-stage-hint').textContent(), 'Share your screen, or put a tile on the stage from the list below.');
  assert.equal(await robin.page.locator('.rl-stage-hint').textContent(), 'You can ask to share your screen, or ask to open a tile.');
  assert.equal(await badge(robin), null, 'no badge on an empty stage');
  const H = await stageHeight(robin);
  assert.ok(H > 300, `the stage has its full size even empty (${H}px)`);
  if (process.env.SHOTS) await robin.page.screenshot({ path: `${process.env.SHOTS}/step9-empty.png` });

  step('Nick opens a tile: it goes on the stage for everyone, his card laid over the box (never moved), the status lines name it, the box keeps its size');
  await openTile(nick, 'stagea');
  for (const p of [nick, robin]) { await tileIs(p, 'stagea', 'open'); await stageHasTile(p, uriOf('stagea')); }
  await waitStatus(robin, /^Nick put a tile on the stage: Counter A$/);
  assert.equal(await status(nick), 'You put a tile on the stage: Counter A');
  assert.equal(await stageHeight(robin), H, 'same size with a tile');
  assert.equal(await badge(robin), 'Tile');
  assert.equal(await tileCard(robin, 'stagea').locator('.rl-stage-badge-tile').textContent(), 'Tile');
  assert.equal(await robin.page.locator(`.rl-tile-placeholder[data-uri="${uriOf('stagea')}"]`).textContent(), 'Tile Counter A: on the stage ↑');
  assert.equal(await tileCard(nick, 'stagea').locator('.rl-tile-stage-off').textContent(), 'Take off stage');
  assert.equal(await tileCard(robin, 'stagea').locator('.rl-tile-stage-off').isVisible(), false, 'only the host takes it off');
  assert.equal(await tileCard(robin, 'stagea').locator('.rl-tile-stage-on').isVisible(), false);
  assert.equal(await tileCard(nick, 'stagea').locator('.rl-tile-hide').isVisible(), false, 'the host has no Hide for me on the staged tile');
  const frameH = await room(robin, (u) => document.querySelector(`.rl-tile[data-uri="${u}"] iframe`).getBoundingClientRect().height, uriOf('stagea'));
  assert.ok(frameH > H * 0.6, `the tile fills the stage (${frameH}px of ${H}px)`);
  await counter(robin, 'stagea').click();
  await counter(robin, 'stagea').click();
  await markFrame(robin, 'stagea');
  if (process.env.SHOTS) await robin.page.screenshot({ path: `${process.env.SHOTS}/step9-tile-on-stage.png` });

  step('a second tile from Nick takes the stage; the first drops back into the list, still running (same frame, same count)');
  await openTile(nick, 'stageb');
  for (const p of [nick, robin]) await stageHasTile(p, uriOf('stageb'));
  await inList(robin, 'stagea');
  assert.equal(await sameFrame(robin, 'stagea'), true, 'not reloaded');
  assert.equal(await counter(robin, 'stagea').textContent(), '2', 'what she did in it stays');
  assert.equal(await tileCard(nick, 'stagea').locator('.rl-tile-stage-on').textContent(), 'Put on stage');
  assert.equal(await stageHeight(robin), H);

  step('Robin asks to open a tile named like a screen; Nick allows it: it goes into the list, not the stage');
  await openTile(robin, 'spoof1');
  await approval(nick, 'Robin asks to open').waitFor();
  await approval(nick, 'Robin asks to open').locator('button', { hasText: 'Allow' }).click();
  for (const p of [nick, robin]) await tileIs(p, 'spoof1', 'open');
  await inList(robin, 'spoof1');
  await stageHasTile(robin, uriOf('stageb'));

  step('Nick puts it on the stage: the page\'s badge says "Tile" whatever the tile calls itself; the caption says who opened it');
  await tileCard(nick, 'spoof1').locator('.rl-tile-stage-on').click();
  for (const p of [nick, robin]) await stageHasTile(p, uriOf('spoof1'));
  await waitStatus(robin, /^Nick put a tile on the stage: Nick’s screen$/);
  assert.equal(await badge(robin), 'Tile');
  assert.equal(await robin.page.locator('.rl-caption').textContent(), 'Nick’s screen · opened by You');
  assert.equal(await nick.page.locator('.rl-caption').textContent(), 'Nick’s screen · opened by Robin');
  await inList(robin, 'stageb');

  step('full screen: the staged tile\'s own button, and back');
  await tileCard(robin, 'spoof1').locator('.rl-tile-full').click();
  await until(robin, (u) => document.fullscreenElement === document.querySelector(`.rl-tile[data-uri="${u}"]`), uriOf('spoof1'));
  await until(robin, (u) => document.querySelector(`.rl-tile[data-uri="${u}"] .rl-tile-full`).textContent === 'Exit full screen', uriOf('spoof1'));
  await tileCard(robin, 'spoof1').locator('.rl-tile-full').click();
  await until(robin, () => !document.fullscreenElement);
  await stageHasTile(robin, uriOf('spoof1'));
  assert.equal(await tileCard(robin, 'stageb').locator('.rl-tile-full').isVisible(), false, 'only the staged tile has it');

  step('Ted joins late: the tile is on his stage too (no "put" line for him); a guest\'s forged "stage" is ignored');
  await join(ted, invite, 'Join room');
  for (const rk of ['stagea', 'stageb', 'spoof1']) await tileIs(ted, rk, 'open');
  await stageHasTile(ted, uriOf('spoof1'));
  assert.ok(!/put a tile/.test(await status(ted)));
  const tedId = await room(ted, () => window.__roomsLab.room.me);
  await room(robin, ([id, u]) => window.__roomsLab.room.link.to(id, { kind: 'stage', uri: u }), [tedId, uriOf('stagea')]);
  await until(ted, () => window.__roomsLab.room.log.some((l) => /Robin: stage not from the host: ignored/.test(l)));
  await stageHasTile(ted, uriOf('spoof1'));

  step('Robin hides the staged tile for herself: her stage says so; everyone else still has it');
  await tileCard(robin, 'spoof1').locator('.rl-tile-hide').click();
  await onStageIs(robin, 'tile-hidden');
  assert.equal(await robin.page.locator('.rl-stage-line').textContent(), 'You hid the tile on the stage. It’s still on the stage for everyone else.');
  assert.equal(await badge(robin), 'Tile');
  assert.equal(await stageHeight(robin), H);
  await stageHasTile(ted, uriOf('spoof1'));

  step('Robin asks to present; Nick allows; she shares: her screen takes the stage on every page (the tile back to the list)');
  await robin.page.click('.rl-share');
  await approval(nick, 'Robin asks to present').waitFor();
  await approval(nick, 'Robin asks to present').locator('button', { hasText: 'Allow' }).click();
  await promptShown(robin);
  await robin.page.click('.rl-prompt button:has-text("Choose what to share")');
  for (const p of [nick, ted]) { await stageShows(p); await onStageIs(p, 'screen'); }
  await inList(ted, 'spoof1');
  await waitStatus(ted, /^(Robin is sharing their screen\.|Back to Robin’s screen\.)$/);
  assert.equal(await badge(ted), 'Screen');
  assert.equal(await ted.page.locator('.rl-caption').textContent(), 'Robin’s screen');
  assert.equal(await ted.page.locator('.rl-stage-full').isVisible(), true, 'full screen for a screen too');
  assert.equal(await stageHeight(ted), H, 'same size with a screen');
  if (process.env.SHOTS) await ted.page.screenshot({ path: `${process.env.SHOTS}/step9-screen-on-stage.png` });

  step('Nick puts a tile on the stage over her screen ("Back to screen" for him), then goes back to her screen');
  await tileCard(nick, 'stagea').locator('.rl-tile-stage-on').click();
  for (const p of [nick, ted, robin]) await stageHasTile(p, uriOf('stagea'));
  assert.equal(await sharing(robin), true, 'her share keeps running underneath');
  assert.match(await status(robin), /put a tile on the stage/);
  assert.equal(await tileCard(nick, 'stagea').locator('.rl-tile-stage-off').textContent(), 'Back to screen');
  await tileCard(nick, 'stagea').locator('.rl-tile-stage-off').click();
  for (const p of [nick, ted]) await onStageIs(p, 'screen');
  await waitStatus(ted, /^Back to Robin’s screen\.$/);
  await inList(ted, 'stagea');

  step('Robin stops sharing: the stage is empty everywhere');
  await robin.page.click('.rl-share');
  for (const p of [nick, robin, ted]) await stageClear(p);

  step('Nick puts a tile on the stage and reloads: he comes back as host with the same tile on the stage, for everyone');
  await tileCard(nick, 'stageb').locator('.rl-tile-stage-on').click();
  for (const p of [nick, ted]) await stageHasTile(p, uriOf('stageb'));
  await nick.page.goto('about:blank');
  await waitStatus(ted, /Waiting for Nick to come back/);
  await nick.page.goBack();
  await nick.page.waitForSelector('button:has-text("Rejoin as host")');
  await nick.page.click('button:has-text("Rejoin as host")');
  await waitStatus(nick, /You're the host/);
  await tileIs(nick, 'stageb', 'open');
  await stageHasTile(nick, uriOf('stageb'));
  await stageHasTile(ted, uriOf('stageb'));

  step('phone width: no sideways scroll, the card still over the stage');
  await ted.page.setViewportSize({ width: 375, height: 800 });
  await stageHasTile(ted, uriOf('stageb'));
  assert.equal(await ted.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  if (process.env.SHOTS) await ted.page.screenshot({ path: `${process.env.SHOTS}/step9-phone.png`, fullPage: false });
  await ted.page.setViewportSize({ width: 1280, height: 900 });

  step('Close for everyone on the staged tile: the stage is empty on every page');
  await tileCard(nick, 'stageb').locator('.rl-tile-close').click();
  for (const p of [nick, robin, ted]) await stageClear(p);
  assert.equal(await ted.page.locator('.rl-tile-placeholder').count(), 0);
  await waitStatus(robin, /^(Nick put|The tile left|Robin|You)/).catch(() => {});

  assert.deepEqual(errors, [], 'no errors on the pages');
  console.log('\nAll stage checks passed.');
} catch (e) {
  console.error('\nFAILED:', e.message);
  if (process.env.DEBUG_STAGE) for (const p of globalThis.__people || []) { try { console.error(p.name, await p.page.evaluate(() => ({ on: document.querySelector('.rl-stage')?.dataset.on, stage: window.__roomsLab.room?.stageTile, log: window.__roomsLab.room?.log.slice(-8), status: document.querySelector('.rl-status')?.textContent }))); } catch (x) { console.error(p.name, x.message); } }
  if (errors.length) console.error('Page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await dev.close();
}
