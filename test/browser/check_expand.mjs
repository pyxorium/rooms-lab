// check_expand.mjs: Expand (0.12.0; claude/raku-rooms-step3.md, RR15 to RR21), on a computer.
//
//   - an empty stage has no Expand; a tile on the stage has Expand on its card, a screen in the stage's bar;
//   - Robin expands the staged tile: the stage fills the window under a slim room bar (badge, what's on, the
//     people as chips, Mute, Full screen, Back to the room), the same frame keeps running; only her view (RR15);
//   - Mute in the room bar; the stage changing keeps her expanded, the status line shows in the bar for a few
//     seconds (RR17, RR18);
//   - Nick (host) expanded: Robin's request floats over the corner of his stage; she shares; her screen takes the
//     stage and he stays expanded; Full screen from the room bar and back to the expanded view (RR21); Escape
//     folds back; the stage going empty folds back on its own (RR17);
//   - a reload doesn't keep it (RR21).
// Same stand-ins as check_stage.mjs, the real relay and dev page.
//
//   node test/browser/check_expand.mjs           (needs Playwright with Chromium; not part of npm test)
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
      const manifest = { name: t.name, sizing: t.sizing || { width: 400, height: 220 }, resources: { '/': { src: { $type: 'blob', ref: { $link: t.blobCid }, mimeType: 'text/html', size: t.bytes.length }, 'content-type': 'text/html' } } };
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


const expanded = (p) => room(p, () => document.querySelector('.rl-room')?.classList.contains('rl-expanded') === true);
// Expanded: the stage fills the window under the room bar (at the top on a computer), the staged card (if any) over it.
const fillsWindow = (p, uri = null) => until(p, (u) => {
  const sec = document.querySelector('.rl-room'), st = document.querySelector('.rl-stage'), bar = document.querySelector('.rl-xbar');
  if (!sec?.classList.contains('rl-expanded')) return false;
  const a = st.getBoundingClientRect(), x = bar.getBoundingClientRect();
  const ok = x.top === 0 && x.height >= 40 && Math.abs(a.top - x.bottom) <= 1 && a.left === 0 && Math.abs(a.width - window.innerWidth) <= 1 && Math.abs(a.bottom - window.innerHeight) <= 1;
  if (!ok || !u) return ok;
  const c = document.querySelector(`.rl-tile[data-uri="${u}"]`);
  if (!c) return false;
  const b = c.getBoundingClientRect();
  return getComputedStyle(c).position === 'fixed' && Math.abs(a.top - b.top) < 2 && Math.abs(a.left - b.left) < 2 && Math.abs(a.width - b.width) < 2 && Math.abs(a.height - b.height) < 2;
}, uri);
const folded = (p) => until(p, () => !document.querySelector('.rl-room').classList.contains('rl-expanded'));
const barText = (p, sel) => p.page.locator(`.rl-xbar ${sel}`).textContent();
const visible = (p, sel) => p.page.locator(sel).isVisible();

try {
  const nick = await person('Nick'), robin = await person('Robin');
  for (const p of [nick, robin]) await p.page.setViewportSize({ width: 1280, height: 800 });
  globalThis.__people = [nick, robin];

  step('the empty stage: no Expand anywhere, and no room bar');
  await join(nick, PAGE, 'New room');
  await until(nick, () => document.querySelector('.rl-house-line').dataset.house === 'ready');
  const invite = await nick.page.inputValue('.rl-invite');
  await join(robin, invite, 'Join room');
  for (const p of [nick, robin]) await stageClear(p);
  assert.equal(await visible(robin, '.rl-stage-expand'), false);
  assert.equal(await visible(robin, '.rl-xbar'), false);

  step('Nick opens a tile: on the stage, its card has Expand beside Full screen');
  await openTile(nick, 'stagea');
  await stageHasTile(robin, uriOf('stagea'));
  assert.equal(await tileCard(robin, 'stagea').locator('.rl-tile-expand').textContent(), 'Expand');
  assert.equal(await tileCard(robin, 'stagea').locator('.rl-tile-full').isVisible(), true);
  assert.equal(await visible(robin, '.rl-stage-expand'), false, 'a tile\'s Expand is on its card, not under it');
  await counter(robin, 'stagea').click();
  await counter(robin, 'stagea').click();
  await markFrame(robin, 'stagea');

  step('Robin expands it: the stage fills the window under the room bar, the same frame keeps running; Nick\'s view doesn\'t change (RR15)');
  await tileCard(robin, 'stagea').locator('.rl-tile-expand').click();
  await fillsWindow(robin, uriOf('stagea'));
  assert.equal(await sameFrame(robin, 'stagea'), true, 'not reloaded');
  assert.equal(await counter(robin, 'stagea').textContent(), '2');
  await counter(robin, 'stagea').click();
  assert.equal(await counter(robin, 'stagea').textContent(), '3', 'still playable');
  assert.equal(await expanded(nick), false, 'only her own view');
  assert.equal(await barText(robin, '.rl-stage-badge'), 'Tile');
  assert.equal(await barText(robin, '.rl-x-caption'), 'Counter A · opened by Nick');
  const chips = (await robin.page.locator('.rl-x-chip .rl-x-name').allTextContents()).sort();
  assert.deepEqual(chips, ['Nick', 'You'], 'the people as chips');
  assert.equal(await visible(robin, '.rl-x-count'), false, 'chips fit: no count');
  assert.equal(await barText(robin, '.rl-x-back'), 'Back to the room');
  assert.equal(await visible(robin, '.rl-x-full'), true, 'Full screen in the room bar');
  assert.equal(await tileCard(robin, 'stagea').locator('.rl-tile-full').isVisible(), false, 'the card\'s own Full screen steps aside');
  assert.equal(await tileCard(robin, 'stagea').locator('.rl-tile-expand').isVisible(), false);
  assert.equal(await tileCard(robin, 'stagea').locator('.rl-stage-badge-tile').isVisible(), true, 'the card keeps the page\'s Tile badge');
  assert.equal(await robin.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.equal(await logHas(robin, /expanded the stage \(on this page only\)/), true);
  if (process.env.SHOTS) await robin.page.screenshot({ path: `${process.env.SHOTS}/step3-tile-expanded.png` });

  step('Mute in the room bar works the room\'s own microphone');
  await robin.page.click('.rl-x-mic');
  await until(robin, () => document.querySelector('.rl-x-mic').textContent === 'Mute' && document.querySelector('.rl-mic').textContent === 'Mute');
  assert.equal(await room(robin, () => !!window.__roomsLab.room.micTrack && !window.__roomsLab.room.muted), true);
  await robin.page.click('.rl-x-mic');
  await until(robin, () => document.querySelector('.rl-x-mic').textContent === 'Unmute');

  step('Nick opens another tile: Robin stays expanded and follows the stage; the status line shows in the bar, then the name comes back (RR17, RR18)');
  await openTile(nick, 'stageb');
  await fillsWindow(robin, uriOf('stageb'));
  await until(robin, () => /^Nick put a tile on the stage: Counter B$/.test(document.querySelector('.rl-x-status').textContent) && !document.querySelector('.rl-x-status').hidden);
  assert.equal(await visible(robin, '.rl-x-caption'), false);
  await until(robin, () => document.querySelector('.rl-x-status').hidden && document.querySelector('.rl-x-caption').textContent === 'Counter B · opened by Nick', undefined, 9000);
  assert.equal(await sameFrame(robin, 'stagea'), true, 'the first tile, back in the list, still the same frame');
  assert.equal(await counter(robin, 'stagea').textContent(), '3');

  step('Back to the room: the stage and the card back in place, the room bar gone');
  await robin.page.click('.rl-x-back');
  await folded(robin);
  await stageHasTile(robin, uriOf('stageb'));
  assert.equal(await visible(robin, '.rl-xbar'), false);
  assert.equal(await logHas(robin, /back to the room/), true);

  step('Nick expands; Robin asks to present: the approval floats over the corner of his stage, above the tile');
  await tileCard(nick, 'stageb').locator('.rl-tile-expand').click();
  await fillsWindow(nick, uriOf('stageb'));
  await robin.page.click('.rl-share');
  await approval(nick, 'Robin asks to present').waitFor();
  const onTop = await room(nick, () => {
    const card = document.querySelector('.rl-approval'), st = document.querySelector('.rl-stage').getBoundingClientRect();
    const b = card.getBoundingClientRect();
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + 12);
    return { fixed: getComputedStyle(card.parentElement).position === 'fixed', inside: b.top >= st.top && b.right <= st.right + 1 && b.left > st.left + st.width / 2, top: card.contains(hit) };
  });
  assert.deepEqual(onTop, { fixed: true, inside: true, top: true }, 'over the top-right corner of the stage, on top of the tile');
  if (process.env.SHOTS) await nick.page.screenshot({ path: `${process.env.SHOTS}/step3-host-request.png` });
  await approval(nick, 'Robin asks to present').locator('button', { hasText: 'Allow' }).click();
  await promptShown(robin);
  await robin.page.click('.rl-prompt button:has-text("Choose what to share")');

  step('her screen takes the stage: Nick stays expanded and sees it (RR17), the bar says Screen');
  await stageShows(nick);
  await onStageIs(nick, 'screen');
  await fillsWindow(nick);
  assert.equal(await barText(nick, '.rl-stage-badge'), 'Screen');
  assert.equal(await barText(nick, '.rl-x-caption'), 'Robin’s screen');
  const vid = await room(nick, () => { const a = document.querySelector('.rl-stage').getBoundingClientRect(), v = document.querySelector('.rl-video').getBoundingClientRect(); return Math.abs(a.width - v.width) < 2 && Math.abs(a.bottom - v.bottom) < 2; });
  assert.equal(vid, true, 'the screen fills the stage');
  assert.equal(await visible(nick, '.rl-stage-bar'), false, 'the stage\'s own bar folds away while expanded');
  if (process.env.SHOTS) await nick.page.screenshot({ path: `${process.env.SHOTS}/step3-screen-expanded.png` });

  step('Robin (sharing) has Expand in the stage\'s bar for a screen');
  await onStageIs(robin, 'screen');
  assert.equal(await visible(robin, '.rl-stage-expand'), true);

  step('Full screen from Nick\'s room bar: the stage goes full screen with its own bar (Exit); Escape there doesn\'t fold the room; Exit lands back in the expanded view (RR21)');
  await nick.page.click('.rl-x-full');
  await until(nick, () => document.fullscreenElement === document.querySelector('.rl-stage'));
  await until(nick, () => document.querySelector('.rl-stage-full').textContent === 'Exit full screen' && getComputedStyle(document.querySelector('.rl-stage-bar')).display !== 'none');
  await room(nick, () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  assert.equal(await expanded(nick), true, 'Escape in full screen leaves full screen only');
  await nick.page.click('.rl-stage-full');
  await until(nick, () => !document.fullscreenElement);
  await fillsWindow(nick);
  assert.equal(await visible(nick, '.rl-stage-bar'), false);

  step('Escape folds Nick back to the room');
  await nick.page.waitForTimeout(500);
  await nick.page.keyboard.press('Escape');
  await folded(nick);

  step('Nick expands the screen from the stage\'s bar; Robin stops sharing: the stage is empty, so he folds back on his own (RR17)');
  await nick.page.click('.rl-stage-expand');
  await fillsWindow(nick);
  await robin.page.click('.rl-share');
  await stageClear(nick);
  await folded(nick);
  assert.equal(await visible(nick, '.rl-xbar'), false);

  step('a tile on the stage, Robin expands, reloads and rejoins: not remembered (RR21)');
  await tileCard(nick, 'stagea').locator('.rl-tile-stage-on').click();
  await stageHasTile(robin, uriOf('stagea'));
  await tileCard(robin, 'stagea').locator('.rl-tile-expand').click();
  await fillsWindow(robin, uriOf('stagea'));
  await robin.page.reload();
  await robin.page.waitForSelector('button:has-text("Join room")');
  await robin.page.fill('.rl-name', 'Robin');
  await robin.page.click('button:has-text("Join room")');
  await until(robin, () => window.__roomsLab.room?.link.joined === true);
  await tileIs(robin, 'stagea', 'open');
  await stageHasTile(robin, uriOf('stagea'));
  assert.equal(await expanded(robin), false);

  step('Close for everyone while Robin is expanded: the stage empties and she folds back');
  await tileCard(robin, 'stagea').locator('.rl-tile-expand').click();
  await fillsWindow(robin, uriOf('stagea'));
  await tileCard(nick, 'stagea').locator('.rl-tile-close').click();
  await stageClear(robin);
  await folded(robin);

  assert.deepEqual(errors, [], 'no errors on the pages');
  console.log('\nAll expand checks passed.');
} catch (e) {
  console.error('\nFAILED:', e.message);
  for (const p of globalThis.__people || []) { try { console.error(p.name, await p.page.evaluate(() => ({ on: document.querySelector('.rl-stage')?.dataset.on, x: window.__roomsLab.room?.expanded, log: window.__roomsLab.room?.log.slice(-6), status: document.querySelector('.rl-status')?.textContent }))); } catch (x) { console.error(p.name, x.message); } }
  if (errors.length) console.error('Page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await dev.close();
}
