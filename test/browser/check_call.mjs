// check_call.mjs: the call away from the room (0.13.0; claude/raku-rooms-step4.md, RR23 to RR32), on the dev page.
//
//   - the room's own Pop out (beside Mute) where the browser can open the floating window; none where it can't;
//   - the call bar (call-ui.js createCallBar, mounted here by the check as a host page would): what's on, the people,
//     Mute (the room's own microphone), Back to the room, Leave asking in place (RR27); folding, and opening again by
//     itself when something needs you (RR24): the host's Allow / Deny and the guest's "Choose what to share…" from the
//     bar;
//   - the one-time hint on the first screen share (RR26), on everyone's page that can pop out; Pop out from it;
//   - the floating window (RR30): someone else's screen as a picture with a thin strip, Mute from it, compact when the
//     stage is a tile or empty, a request with Allow / Deny, End room asking in place, Back to the room; while it's
//     open the call bar is one line, "The room is in its own window · Bring it back" (RR25), which folds (RR31);
//   - a phone: the bar's count, Mute, Back to the room and "⋯" (Fold, Leave); folded, a round chip (RR29).
// Same stand-ins as check_stage.mjs, the real relay and dev page.
//
//   node test/browser/check_call.mjs           (needs Playwright with Chromium; not part of npm test)
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

// The call bar, mounted the way a host page (Raku) does, from the package's own module.
// (On a phone, as at the bottom of Raku's window, above its toolbar.)
const mountBar = (p, { bottom = false } = {}) => room(p, async (atBottom) => {
  const { createCallBar } = await import('/src/call-ui.js');
  const { h } = await import('/src/room-page.js');
  window.__backs = 0;
  window.__bar = createCallBar({ call: window.__roomsLab.call, h, onBack: () => { window.__backs++; } });
  if (atBottom) { window.__bar.el.style.cssText = 'position: fixed; left: 0; right: 0; bottom: 0; z-index: 80'; document.body.append(window.__bar.el); }
  else document.body.prepend(window.__bar.el);
  window.__bar.show(true);
}, bottom);
const cb = (p, sel) => p.page.locator(`.rl-callbar ${sel}`);
const cbText = (p, sel) => cb(p, sel).first().textContent();
const callState = (p) => room(p, () => { const s = window.__roomsLab.call.state; return { ...s, screen: !!s.screen }; });
async function popOut(p, click) {
  const waiting = p.ctx.waitForEvent('page');
  await click();
  const pip = await waiting;
  await pip.waitForSelector('.rl-float');
  return pip;
}
const pipUntil = (pip, fn, arg, ms = 15000) => pip.waitForFunction(fn, arg, { timeout: ms, polling: 100 });

try {
  const nick = await person('Nick'), robin = await person('Robin');
  for (const p of [nick, robin]) await p.page.setViewportSize({ width: 1280, height: 800 });
  globalThis.__people = [nick, robin];

  step('in a room: Pop out beside Mute (Chromium can open the floating window); the call state says who’s here');
  await join(nick, PAGE, 'New room');
  await until(nick, () => document.querySelector('.rl-house-line').dataset.house === 'ready');
  const invite = await nick.page.inputValue('.rl-invite');
  await join(robin, invite, 'Join room');
  for (const p of [nick, robin]) await until(p, () => document.querySelectorAll('.rl-person').length === 2);
  for (const p of [nick, robin]) {
    assert.equal(await visible(p, '.rl-controls .rl-pop'), true);
    assert.equal(await p.page.locator('.rl-controls .rl-pop').textContent(), 'Pop out');
    assert.equal(await visible(p, '.rl-pop-hint'), false, 'no hint before anyone shares');
  }
  const st = await callState(robin);
  assert.equal(st.joined, true); assert.equal(st.host, false); assert.equal(st.micOn, false); assert.equal(st.canPopOut, true);
  assert.deepEqual(st.people.map((x) => (x.me ? 'You' : x.name)).sort(), ['Nick', 'You']);
  assert.equal((await callState(nick)).host, true);

  step('the call bar: what’s on, the people, Mute (the room’s own microphone), Pop out, Back to the room, Leave; End room for the host');
  for (const p of [nick, robin]) await mountBar(p);
  await until(robin, () => document.querySelector('.rl-callbar .rl-cb-stage')?.textContent === 'Nothing on the stage');
  assert.deepEqual((await cb(robin, '.rl-x-chip .rl-x-name').allTextContents()).sort(), ['Nick', 'You']);
  assert.equal(await cbText(robin, '.rl-cb-mic'), 'Unmute');
  assert.equal(await cbText(robin, '.rl-cb-back'), 'Back to the room');
  assert.equal(await cbText(robin, '.rl-cb-leave'), 'Leave');
  assert.equal(await cbText(nick, '.rl-cb-leave'), 'End room', 'the host’s button ends the room, as in the room');
  assert.equal(await cb(robin, '.rl-cb-pop').isVisible(), true);
  await cb(robin, '.rl-cb-mic').click();
  await until(robin, () => document.querySelector('.rl-cb-mic').textContent === 'Mute' && document.querySelector('.rl-controls .rl-mic').textContent === 'Mute');
  assert.equal((await callState(robin)).micOn, true);
  await cb(robin, '.rl-cb-back').click();
  assert.equal(await room(robin, () => window.__backs), 1, 'Back to the room asks the host page');
  if (process.env.SHOTS) await robin.page.screenshot({ path: `${process.env.SHOTS}/call-bar.png`, clip: { x: 0, y: 0, width: 1280, height: 120 } });

  step('Leave asks in place: "Leave? Yes · No"; No, or four seconds, goes back (RR27)');
  await cb(robin, '.rl-cb-row > .rl-ask-place .rl-cb-leave').click();
  assert.equal(await cbText(robin, '.rl-ask-q'), 'Leave?');
  await cb(robin, '.rl-ask-no').click();
  assert.equal(await cbText(robin, '.rl-cb-leave'), 'Leave');
  await cb(nick, '.rl-cb-row > .rl-ask-place .rl-cb-leave').click();
  assert.equal(await cbText(nick, '.rl-ask-q'), 'End the room?');
  await nick.page.waitForTimeout(4400);
  assert.equal(await cb(nick, '.rl-ask-q').count(), 0, 'back to End room by itself');
  assert.equal(await cbText(nick, '.rl-cb-leave'), 'End room');

  step('both fold their bars; Robin asks to present: Nick’s bar opens by itself with Allow / Deny (RR24)');
  for (const p of [nick, robin]) { await cb(p, '.rl-cb-fold').first().click(); await until(p, () => document.querySelector('.rl-cb-row').hidden); }
  assert.equal(await cb(nick, '.rl-cb-chip').isVisible(), false, 'no chip on a computer: the room’s tab marker opens it');
  await robin.page.click('.rl-share');
  await until(nick, () => !document.querySelector('.rl-cb-row').hidden && /Robin asks to present their screen\./.test(document.querySelector('.rl-cb-need')?.textContent || ''));
  assert.equal((await callState(nick)).approvals.length, 1);
  await cb(nick, '.rl-cb-allow').click();

  step('Robin’s folded bar opens by itself with the question; "Choose what to share…" from the bar shares');
  await until(robin, () => !document.querySelector('.rl-cb-row').hidden && document.querySelector('.rl-cb-need')?.dataset.need === 'prompt');
  assert.match(await cbText(robin, '.rl-cb-need .rl-cb-text'), /^The host said you can present\. Share with 1 person\?$/);
  await cb(robin, '.rl-cb-choose').click();
  await until(robin, () => !!window.__roomsLab.room.screenTrack);
  await until(robin, () => document.querySelector('.rl-cb-sharing .rl-cb-text')?.textContent === 'You’re sharing your screen');

  step('the first share: the hint on both pages (RR26); Nick’s bar shows Robin’s screen');
  await stageShows(nick);
  for (const p of [nick, robin]) await until(p, () => !document.querySelector('.rl-pop-hint').hidden);
  assert.equal(await nick.page.locator('.rl-pop-hint span').first().textContent(), 'Presenting from another program? Pop out the room to keep it on top.');
  await until(nick, () => /Robin’s screen/.test(document.querySelector('.rl-callbar .rl-cb-what')?.textContent || ''));

  step('Nick pops out from the hint: the floating window shows Robin’s screen as a picture with a thin strip (RR30); the hint goes; his bar is one line (RR25)');
  const pip = await popOut(nick, () => nick.page.click('.rl-pop-hint-go'));
  await pipUntil(pip, () => document.querySelector('.rl-float').dataset.layout === 'picture' && document.querySelector('.rl-fl-video')?.videoWidth > 0, undefined, 20000);
  assert.equal(await pip.locator('.rl-fl-strip .rl-x-count').textContent(), '2 here');
  assert.equal(await pip.locator('.rl-fl-back').textContent(), 'Back to the room');
  assert.equal(await pip.locator('.rl-fl-strip .rl-cb-leave').textContent(), 'End room');
  assert.equal(await pip.evaluate(() => getComputedStyle(document.querySelector('.rl-fl-strip')).display), 'flex', 'the room’s styles reached the window');
  await until(nick, () => document.querySelector('.rl-pop-hint').hidden);
  await until(nick, () => !document.querySelector('.rl-cb-popped').hidden && document.querySelector('.rl-cb-row').hidden);
  assert.equal(await cbText(nick, '.rl-cb-popped .rl-cb-text'), 'The room is in its own window');
  assert.equal(await cbText(nick, '.rl-cb-bring'), 'Bring it back');
  assert.equal(await nick.page.locator('.rl-controls .rl-pop').textContent(), 'Bring it back');
  if (process.env.SHOTS) await pip.screenshot({ path: `${process.env.SHOTS}/float-picture.png` });

  step('Mute in the floating window works the room’s microphone');
  await pip.click('.rl-fl-mic');
  await until(nick, () => document.querySelector('.rl-controls .rl-mic').textContent === 'Mute');
  await pipUntil(pip, () => document.querySelector('.rl-fl-mic').textContent === 'Mute');

  step('Robin stops sharing from her bar: her bar says so; Nick’s window turns compact (nothing on the stage)');
  await cb(robin, '.rl-cb-stop').click();
  await until(robin, () => !window.__roomsLab.room.screenTrack);
  await until(robin, () => document.querySelector('.rl-cb-notice .rl-cb-text')?.textContent === 'You stopped sharing.');
  await pipUntil(pip, () => document.querySelector('.rl-float').dataset.layout === 'compact' && /Nothing on the stage/.test(document.querySelector('.rl-fl-what').textContent));
  assert.deepEqual((await pip.locator('.rl-fl-people .rl-x-name').allTextContents()).sort(), ['Robin', 'You']);

  step('a tile on the stage: the window names it (compact)');
  await openTile(nick, 'stagea');
  await pipUntil(pip, () => /Counter A, on the stage/.test(document.querySelector('.rl-fl-what').textContent));

  step('Robin asks to see Nick\u2019s screen: the question shows in his window; Not now there');
  await row(robin, 'Nick').locator('.rl-ask').click();
  await pipUntil(pip, () => /^Robin asks to see your screen\. Share with 1 person\?$/.test(document.querySelector('.rl-fl-what .rl-cb-need[data-need="prompt"] .rl-cb-text')?.textContent || ''));
  assert.match(await pip.locator('.rl-cb-choose').textContent(), /^Choose what to share/);
  await pip.click('.rl-cb-notnow');
  await waitStatus(robin, /Nick said not now\./);
  await pipUntil(pip, () => !document.querySelector('.rl-fl-what .rl-cb-need'));

  step('End room in the window asks in place; No keeps the room');
  await pip.click('.rl-fl-buttons .rl-cb-leave');
  assert.equal(await pip.locator('.rl-ask-q').textContent(), 'End the room?');
  await pip.click('.rl-ask-no');
  assert.equal(await room(nick, () => !!window.__roomsLab.room && !window.__roomsLab.room.over), true);

  step('the one line folds too (RR31); Bring it back closes the window and the bar returns');
  await cb(nick, '.rl-cb-popped .rl-cb-fold').click();
  await until(nick, () => document.querySelector('.rl-cb-popped').hidden);
  await nick.page.evaluate(() => window.__bar.fold(false));
  await until(nick, () => !document.querySelector('.rl-cb-popped').hidden);
  await cb(nick, '.rl-cb-bring').click();
  await until(nick, () => !window.__roomsLab.call.state.popped && !document.querySelector('.rl-cb-row').hidden);
  assert.equal(pip.isClosed(), true, 'the window closed');
  assert.equal(await nick.page.locator('.rl-controls .rl-pop').textContent(), 'Pop out');

  step('Pop out from the bar, then Back to the room in the window: it closes (a host page\u2019s onBackToRoom brings the room\u2019s tab forward: Raku\u2019s check)');
  const pip2 = await popOut(nick, () => cb(nick, '.rl-cb-pop').click());
  await pip2.click('.rl-fl-back');
  await until(nick, () => !window.__roomsLab.call.state.popped);
  assert.equal(pip2.isClosed(), true);

  step('Robin pops out; the host says she can present; "Choose what to share…" in her window');
  const pip3 = await popOut(robin, () => robin.page.click('.rl-controls .rl-pop'));
  await robin.page.click('.rl-share');
  await until(nick, () => !!document.querySelector('.rl-cb-allow'));
  await cb(nick, '.rl-cb-allow').click();
  await pipUntil(pip3, () => document.querySelector('.rl-fl-what .rl-cb-need')?.dataset.need === 'prompt');
  await pip3.click('.rl-cb-choose');
  const sharedFromWindow = await robin.page.waitForFunction(() => !!window.__roomsLab.room.screenTrack, undefined, { timeout: 8000, polling: 100 }).then(() => true, () => false);
  console.log(`  (a share started from the floating window's own click: ${sharedFromWindow ? 'yes' : 'no'})`);
  if (!sharedFromWindow) console.log(`  (Robin's status: ${await status(robin)})`);
  await pipUntil(pip3, () => /You’re sharing your screen|The browser couldn/.test(document.querySelector('.rl-float').textContent) || !!document.querySelector('.rl-cb-sharing'), undefined, 8000).catch(() => {});
  assert.equal(await robin.page.locator('.rl-pop-hint').isVisible(), false, 'once per call: no hint the second time');
  if (sharedFromWindow) {
    await pipUntil(pip3, () => document.querySelector('.rl-float').dataset.layout === 'compact' && !!document.querySelector('.rl-fl-what .rl-cb-sharing'));
    await pip3.click('.rl-cb-stop');
    await until(robin, () => !window.__roomsLab.room.screenTrack);
  }

  step('Robin leaves from her window (Leave? Yes): the window closes, the bar goes, Nick sees one person');
  await pip3.click('.rl-fl-buttons .rl-cb-leave');
  await pip3.click('.rl-ask-yes');
  await until(robin, () => !window.__roomsLab.room && document.querySelector('.rl-callbar').hidden);
  assert.equal(pip3.isClosed(), true);
  assert.equal((await callState(robin)).joined, false);
  await until(nick, () => document.querySelectorAll('.rl-person').length === 1);

  step('a phone: the count, Mute, Back to the room and "⋯" (Fold, Leave); folded, a round chip that opens it again (RR29)');
  await robin.page.setViewportSize({ width: 390, height: 780 });
  await robin.page.goto('about:blank');
  await join(robin, invite, 'Join room');
  await mountBar(robin, { bottom: true });
  await until(robin, () => document.querySelector('.rl-callbar').classList.contains('rl-cb-phone') && !document.querySelector('.rl-cb-row').hidden);
  assert.equal(await cbText(robin, '.rl-cb-count'), '2 here');
  for (const sel of ['.rl-cb-mic', '.rl-cb-back', '.rl-cb-more']) assert.equal(await cb(robin, sel).isVisible(), true, sel);
  for (const sel of ['.rl-cb-pop', '.rl-cb-fold', '.rl-cb-row > .rl-ask-place']) assert.equal(await cb(robin, sel).first().isVisible(), false, sel);
  await cb(robin, '.rl-cb-more').click();
  assert.equal(await cb(robin, '.rl-cb-menu').isVisible(), true);
  assert.equal(await cbText(robin, '.rl-cb-menu .rl-cb-leave'), 'Leave');
  await cb(robin, '.rl-cb-menu-fold').click();
  await until(robin, () => { const c = document.querySelector('.rl-cb-chip'); return c && !c.hidden && c.getBoundingClientRect().width >= 40; });
  assert.equal(await cb(robin, '.rl-cb-row').isVisible(), false);
  assert.match(await cb(robin, '.rl-cb-chip').getAttribute('aria-label'), /^Show the call bar: In a room/);
  await cb(robin, '.rl-cb-chip').click();
  await until(robin, () => !document.querySelector('.rl-cb-row').hidden);
  assert.equal(await robin.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
  if (process.env.SHOTS) await robin.page.screenshot({ path: `${process.env.SHOTS}/call-bar-phone.png` });

  step('a browser without the floating window: no Pop out anywhere, no hint');
  const ann = await person('Ann');
  await ann.ctx.addInitScript(() => { delete window.documentPictureInPicture; });
  await ann.page.setViewportSize({ width: 1280, height: 800 });
  globalThis.__people.push(ann);
  await join(ann, invite, 'Join room');
  await mountBar(ann);
  assert.equal(await visible(ann, '.rl-controls .rl-pop'), false);
  assert.equal(await cb(ann, '.rl-cb-pop').isVisible(), false);
  assert.equal((await callState(ann)).canPopOut, false);

  assert.deepEqual(errors, [], 'no errors on the pages');
  console.log('\nAll call checks passed.');
} catch (e) {
  console.error('\nFAILED:', e.message);
  for (const p of globalThis.__people || []) { try { console.error(p.name, await p.page.evaluate(() => ({ state: (() => { const s = window.__roomsLab.call?.state; return s && { ...s, screen: !!s?.screen }; })(), log: window.__roomsLab.room?.log.slice(-6), status: document.querySelector('.rl-status')?.textContent }))); } catch (x) { console.error(p.name, x.message); } }
  if (errors.length) console.error('Page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await dev.close();
}
