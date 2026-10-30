// check_live.mjs: live tiles in the Rooms lab page, in the chat sandbox (rooms-live-tiles-plan.md).
//
// The real relay and the lab's dev page (dev/serve.mjs) with the house tile (tiles/house, which now knows
// "live"), and four Chromium profiles like separate computers: Nick (host), Robin, Ted, later Zoe. The live poll
// (tiles/poll) runs for real, in a sealed frame (scripts only, no origin of its own), fed by the page's own
// pinned file loader from a stand-in author's server (every file checked against the record).
//   - the poll is opened for everyone; before it's live each copy is "Just you"; the host's card offers
//     "Share live with the room", a guest's "Ask to share live"; a tile that doesn't speak live offers neither
//   - Robin's poll, typed before it was live, becomes everyone's when the host shares the tile live (the host's
//     copy had none); every card says "Shared live with the room"; votes show on every copy in one order
//   - nothing anyone does in a live tile goes through the relay (every page's relay messages are recorded)
//   - only the host's page speaks for the room: a live message forged by a guest's page is ignored
//   - only copies of the same tile: a second poll (another record) hears nothing of the first
//   - a newcomer gets the poll as it stands; when the asker leaves, someone else may start a new poll
//   - a guest asks to share a tile live: the host's approval card, the house's reason, Allow
//   - the host away: live copies pause, then resume; Stop sharing live: copies keep what they have
//   - too many messages: the sender's copy says so
//
//   node test/browser/check_live.mjs      (needs Playwright with Chromium; not part of npm test)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import assert from 'node:assert/strict';
import { startDev } from '../../dev/serve.mjs';
import { rawCid } from '../../scripts/lib/cid.js';
import { HIDE_LIST_URL } from '../../src/hide-check.js';
import { ROOT, TILES as OWN_TILES } from '../../scripts/tiles.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import('playwright')); }

const step = (s) => console.log(`- ${s}`);
const dev = await startDev({ port: 0, relayPort: 0, quiet: true });
const PAGE = `${dev.url}?relay=${encodeURIComponent(dev.relayUrl)}`;
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const errors = [];
const DATA_JS = '/.well-known/web-tiles/data.js';

// ---- Stand-ins for the tiles' servers (the real servers' CORS headers) ----
const DID = 'did:plc:tiletiletiletiletiletile';
const PDS = 'https://pds.tiles.test';
const CORS = { 'access-control-allow-origin': '*' };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
async function realTile(name, letter) {          // the poll's own files, as publish.mjs would publish them
  const resources = {}, blobs = {};
  for (const f of [...OWN_TILES.poll.files, 'icon.png', 'banner.png']) {
    const bytes = readFileSync(pathJoin(ROOT, 'tiles', 'poll', f));
    const cid = await rawCid(new Uint8Array(bytes));
    const ct = types[f.slice(f.lastIndexOf('.'))];
    blobs[cid] = bytes;
    resources[f === 'index.html' ? '/' : `/${f}`] = { src: { $type: 'blob', ref: { $link: cid }, mimeType: ct, size: bytes.length }, 'content-type': ct };
  }
  return { name, cid: `bafyrei${letter.repeat(52)}`, manifest: { name, sizing: { width: 480, height: 440 }, resources }, blobs, poll: true };
}
const counterHtml = '<!doctype html><meta charset="utf-8"><body style="font:16px system-ui"><button id="b">0</button><script>b.onclick=()=>{b.textContent=String(+b.textContent+1)}</script>';
const TILES = {
  poll: await realTile('Live poll', 'p'),
  poll2: await realTile('Live poll 2', 'o'),
  counter: await (async () => {
    const bytes = Buffer.from(counterHtml);
    const cid = await rawCid(new Uint8Array(bytes));
    return { name: 'Counter', cid: `bafyrei${'c'.repeat(52)}`, blobs: { [cid]: bytes }, manifest: { name: 'Counter', sizing: { width: 400, height: 220 }, resources: { '/': { src: { $type: 'blob', ref: { $link: cid }, mimeType: 'text/html', size: bytes.length }, 'content-type': 'text/html' } } } };
  })(),
};
const uriOf = (rkey) => `at://${DID}/ing.dasl.masl/${rkey}`;
async function standIns(ctx) {
  const json = (route, body, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await ctx.route('https://plc.directory/**', (route) => json(route, { id: DID, alsoKnownAs: ['at://tiles.test'], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] }));
  await ctx.route(`${PDS}/**`, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/xrpc/com.atproto.repo.getRecord') {
      const t = TILES[u.searchParams.get('rkey')];
      if (!t) return json(route, { error: 'RecordNotFound' }, 400);
      return json(route, { uri: uriOf(u.searchParams.get('rkey')), cid: t.cid, value: { $type: 'ing.dasl.masl', cid: t.cid, tile: t.manifest, createdAt: '2026-10-24T12:00:00.000Z' } });
    }
    if (u.pathname === '/xrpc/com.atproto.sync.getBlob') {
      const cid = u.searchParams.get('cid');
      const t = Object.values(TILES).find((x) => x.blobs[cid]);
      if (!t) return route.fulfill({ status: 404, headers: CORS, body: '' });
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': '*/*' }, body: t.blobs[cid] });
    }
    return route.fulfill({ status: 404, headers: CORS, body: '' });
  });
  await ctx.route(HIDE_LIST_URL, (route) => json(route, { version: 1, salt: 'lexicographer.space hide list v1', accounts: [], tiles: [] }));
  await ctx.route('https://public.api.bsky.app/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/xrpc/com.atproto.identity.resolveHandle') return u.searchParams.get('handle') === 'tiles.test' ? json(route, { did: DID }) : json(route, { error: 'InvalidRequest', message: 'Unable to resolve handle' }, 400);
    return json(route, { did: u.searchParams.get('actor'), handle: 'tiles.test', labels: [] });
  });
}
// The stand-in tile loader: every file through the page's pinned loader (so a wrong file is refused), then
// the tile in a sealed frame. The poll's frame shows the files the dev server serves from tiles/poll, which
// are the same bytes the record names.
const STANDIN_TILE_HOST = () => {
  window.__roomsLabTileHost = {
    async render({ uri, manifest, loader }) {
      for (const path of Object.keys(manifest.resources)) { const r = await loader.resolvePath(path); if (!r.ok) return null; }
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      if (/\/(poll|poll2)$/.test(uri)) f.src = '/tiles/poll/index.html';
      else { const r = await loader.resolvePath('/'); f.srcdoc = new TextDecoder().decode(r.body); }
      return f;
    },
  };
};
// Every message a page gives the relay, recorded (the relay must never see what's done in a live tile).
const RECORD_RELAY = () => {
  window.__relayOut = [];
  const wrap = () => {
    const r = window.__roomsLab?.room;
    if (!r?.link || r.link.__wrapped) return;
    for (const k of ['to', 'all']) { const f = r.link[k].bind(r.link); r.link[k] = (...a) => { window.__relayOut.push(JSON.stringify(a)); return f(...a); }; }
    r.link.__wrapped = true;
  };
  setInterval(wrap, 20);
};

async function person(name) {
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1100, height: 1600 } });
  await standIns(ctx);
  await ctx.addInitScript(STANDIN_TILE_HOST);
  await ctx.addInitScript(RECORD_RELAY);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().includes(DATA_JS) || (m.location()?.url || '').includes(DATA_JS)) return;
    // The handle resolver answers 400 for a handle it can't find (the real one does too); the browser logs it.
    if ((m.location()?.url || '').includes('/xrpc/com.atproto.identity.resolveHandle?handle=nobody.test')) return;
    errors.push(`${name} console: ${m.text()}`);
  });
  return { name, ctx, page };
}
const until = (p, fn, arg, ms = 20000) => p.page.waitForFunction(fn, arg, { timeout: ms, polling: 100 });
const room = (p, fn, arg) => p.page.evaluate(fn, arg);
async function join(p, link, button) {
  await p.page.goto(link);
  await p.page.fill('.rl-name', p.name);
  await p.page.click(`button:has-text("${button}")`);
  await until(p, () => window.__roomsLab.room?.link.joined === true);
}
const card = (p, rkey) => p.page.locator(`.rl-tile[data-uri="${uriOf(rkey)}"]`);
const cardState = (p, rkey, st) => until(p, ([u, s]) => document.querySelector(`.rl-tile[data-uri="${u}"]`)?.dataset.state === s, [uriOf(rkey), st]);
const tileFrame = async (p, rkey) => (await card(p, rkey).locator('iframe').elementHandle()).contentFrame();
const poll = async (p, rkey, fn, arg) => (await tileFrame(p, rkey)).evaluate(fn, arg);
const pollUntil = async (p, rkey, fn, arg, ms = 20000) => (await tileFrame(p, rkey)).waitForFunction(fn, arg, { timeout: ms, polling: 100 });
const statusOf = (p, rkey) => poll(p, rkey, () => document.getElementById('status').textContent);
const counts = (p, rkey) => poll(p, rkey, () => [...document.querySelectorAll('.count')].map((c) => +c.textContent));
const button = (p, rkey, text) => card(p, rkey).locator('.rl-tile-actions button', { hasText: text });
const visible = async (loc) => (await loc.count()) > 0 && loc.first().isVisible();
async function openForEveryone(host, rkey, address = uriOf(rkey)) {
  await host.page.fill('.rl-tile-input', address);
  await host.page.click('.rl-tile-preview-go');
  await cardState(host, rkey, 'open');
  await card(host, rkey).locator('button', { hasText: 'Open for everyone' }).click();
  await until(host, (u) => !document.querySelector(`.rl-tile[data-uri="${u}"]`)?.classList.contains('rl-tile-preview'), uriOf(rkey));
}
async function vote(p, rkey, option) { (await tileFrame(p, rkey)).locator('.vote').nth(option).click(); }

try {
  const nick = await person('Nick'), robin = await person('Robin'), ted = await person('Ted'), zoe = await person('Zoe');

  step('the lobby says what live sharing does (honest wording)');
  await nick.page.goto(PAGE);
  assert.match(await nick.page.locator('.rl-honest').textContent(), /A tile shared live sends what people do in it to the other copies of the same tile only.*never through the relay.*random ids.*Nothing is kept\./);

  step('Nick makes a room; the house is ready and knows "live"; Robin and Ted join; direct connections come up');
  await join(nick, PAGE, 'New room');
  await until(nick, () => document.querySelector('.rl-house-line').dataset.house === 'ready');
  assert.deepEqual(await room(nick, () => window.__roomsLab.room.house.wishes), ['see-screen', 'present', 'open-tile', 'live']);
  const invite = await nick.page.inputValue('.rl-invite');
  await join(robin, invite, 'Join room');
  await join(ted, invite, 'Join room');
  for (const p of [nick, robin, ted]) await until(p, () => document.querySelectorAll('.rl-person').length === 3 && document.querySelectorAll('.rl-conn').length === 0);
  const nickPeer = await room(nick, () => window.__roomsLab.room.me);
  for (const p of [robin, ted]) await until(p, (h) => window.__roomsLab.room.mesh.channelOpen(h), nickPeer);

  step('addresses as Raku and the viewers show them: an unknown handle is refused with a reason; nothing is opened');
  await nick.page.fill('.rl-tile-input', 'at://nobody.test/ing.dasl.masl/poll');
  await nick.page.click('.rl-tile-preview-go');
  await until(nick, () => /Couldn’t find the account @nobody\.test\./.test(document.querySelector('.rl-status').textContent));
  assert.equal(await nick.page.locator('.rl-tile').count(), 0);
  await nick.page.fill('.rl-tile-input', 'https://example.com/not-a-tile');
  await nick.page.click('.rl-tile-preview-go');
  await until(nick, () => /not other web pages/.test(document.querySelector('.rl-status').textContent));

  step('Nick opens the poll (from a lexicographer.space link) and a counter (at:// with the handle, as Raku shows it) for everyone; each page runs its own copy; not live yet: every copy is "Just you"');
  await openForEveryone(nick, 'poll', 'https://lexicographer.space/@tiles.test/poll');
  await openForEveryone(nick, 'counter', 'at://tiles.test/ing.dasl.masl/counter');
  const tileMsgs = await room(nick, () => window.__relayOut.filter((m) => m.includes('"tile"')).join('\n'));
  assert.ok(tileMsgs.includes(uriOf('poll')) && tileMsgs.includes(uriOf('counter')), 'the room was sent the DID form');
  assert.ok(!/tiles\.test|lexicographer/.test(tileMsgs), 'never the handle or the link');
  for (const p of [nick, robin, ted]) { await cardState(p, 'poll', 'open'); await cardState(p, 'counter', 'open'); }
  for (const p of [nick, robin, ted]) await pollUntil(p, 'poll', () => /^Just you\./.test(document.getElementById('status').textContent));
  assert.equal(await poll(robin, 'poll', () => document.documentElement.dataset.live), 'room', 'a page answered (not a lone copy)');

  step('the switches: the host\'s card offers "Share live with the room", a guest\'s "Ask to share live"; the counter (no live) neither');
  await until(nick, (u) => !document.querySelector(`.rl-tile[data-uri="${u}"] .rl-tile-live-on`).hidden, uriOf('poll'));
  assert.equal(await visible(button(nick, 'poll', 'Share live with the room')), true);
  assert.equal(await visible(button(nick, 'poll', 'Ask to share live')), false);
  await until(robin, (u) => !document.querySelector(`.rl-tile[data-uri="${u}"] .rl-tile-live-ask`).hidden, uriOf('poll'));
  assert.equal(await visible(button(robin, 'poll', 'Share live with the room')), false);
  for (const p of [nick, robin]) for (const t of ['Share live with the room', 'Ask to share live', 'Stop sharing live']) assert.equal(await visible(button(p, 'counter', t)), false, `${p.name} counter: ${t}`);
  assert.equal(await card(nick, 'poll').locator('.rl-tile-live').isVisible(), false);

  step('before it\'s live, Robin picks a ready-made poll and votes: only her copy has it');
  const rf = await tileFrame(robin, 'poll');
  await rf.selectOption('select', '3');
  assert.equal(await rf.inputValue('#q'), 'Tea or coffee?');
  await rf.click('button:has-text("Start poll")');
  await pollUntil(robin, 'poll', () => document.querySelector('.poll h1')?.textContent === 'Tea or coffee?');
  await vote(robin, 'poll', 1);
  await pollUntil(robin, 'poll', () => document.querySelector('.mine .label')?.textContent === 'Coffee');
  assert.equal(await poll(nick, 'poll', () => !!document.querySelector('.poll')), false, 'Nick\'s copy has no poll');
  assert.equal(await poll(ted, 'poll', () => !!document.querySelector('.poll')), false);

  step('Nick shares it live: the house allows the host\'s own; every card says so; each copy "Live · 3 here"; Robin\'s poll becomes everyone\'s, with her vote. Step 9b: Ted\'s first joins are lost on the way (as the owner\'s phone\'s was): his card says "Joining the live room…" and his page keeps asking until he\'s counted');
  await room(ted, () => {
    const m = window.__roomsLab.room.mesh;
    const real = m.sendData.bind(m);
    window.__dropJoins = true;
    m.sendData = (peer, obj) => (window.__dropJoins && obj?.kind === 'live-join' ? true : real(peer, obj));   // "sent", but lost
  });
  await button(nick, 'poll', 'Share live with the room').click();
  for (const p of [nick, robin, ted]) await until(p, (u) => !document.querySelector(`.rl-tile[data-uri="${u}"] .rl-tile-live`).hidden, uriOf('poll'));
  await until(ted, (u) => { const n = document.querySelector(`.rl-tile[data-uri="${u}"] .rl-tile-joining`); return n && !n.hidden && n.textContent === 'Joining the live room…'; }, uriOf('poll'), 10000);
  await pollUntil(nick, 'poll', () => document.getElementById('status').textContent === 'Live · 2 here');
  assert.equal(await room(robin, (u) => document.querySelector(`.rl-tile[data-uri="${u}"] .rl-tile-joining`).hidden, uriOf('poll')), true, 'Robin was counted: no note');
  await room(ted, () => { window.__dropJoins = false; });
  await until(ted, (u) => document.querySelector(`.rl-tile[data-uri="${u}"] .rl-tile-joining`).hidden, uriOf('poll'), 10000);
  assert.ok(await room(nick, () => window.__roomsLab.room.log.some((l) => /⌂ You: live \("Live poll"\): allow — The host may share tiles live\./.test(l))), 'the house decided');
  for (const p of [nick, robin, ted]) await pollUntil(p, 'poll', () => document.getElementById('status').textContent === 'Live · 3 here');
  for (const p of [nick, robin, ted]) await pollUntil(p, 'poll', () => document.querySelector('.poll h1')?.textContent === 'Tea or coffee?');
  for (const p of [nick, ted]) assert.deepEqual(await counts(p, 'poll'), [0, 1, 0, 0]);
  assert.equal(await visible(button(nick, 'poll', 'Stop sharing live')), true);
  assert.equal(await visible(button(robin, 'poll', 'Ask to share live')), false, 'nothing to ask once it\'s live');

  step('Ted and Nick vote; every copy shows the same tally, in the same order; Ted\'s copy marks his vote');
  await vote(ted, 'poll', 0);
  await vote(nick, 'poll', 1);
  for (const p of [nick, robin, ted]) await pollUntil(p, 'poll', () => [...document.querySelectorAll('.count')].map((c) => +c.textContent).join() === '1,2,0,0');
  assert.equal(await poll(ted, 'poll', () => document.querySelector('.mine .label').textContent), 'Tea');
  assert.match(await poll(ted, 'poll', () => document.querySelector('.tally').textContent), /^3 votes · 3 here$/);
  await vote(ted, 'poll', 3);                         // Ted changes his mind
  for (const p of [nick, robin, ted]) await pollUntil(p, 'poll', () => [...document.querySelectorAll('.count')].map((c) => +c.textContent).join() === '0,2,0,1');
  const states = await Promise.all([nick, robin, ted].map((p) => poll(p, 'poll', () => JSON.stringify(window.__poll.state))));
  assert.equal(new Set(states).size, 1, 'the three copies are identical');
  const ids = await Promise.all([nick, robin, ted].map((p) => poll(p, 'poll', () => window.__poll.you)));
  const peers = await Promise.all([nick, robin, ted].map((p) => room(p, () => window.__roomsLab.room.me)));
  assert.equal(new Set(ids).size, 3);
  assert.ok(ids.every((id) => /^[a-z0-9]{16}$/.test(id) && !peers.includes(id)), 'random ids, never the room\'s own peer ids');
  assert.ok(!states[0].includes('Robin') && !states[0].includes('Nick'), 'no names in what the copies share');
  assert.equal(await poll(robin, 'poll', () => [...document.querySelectorAll('.row button')].map((b) => b.textContent).join()), 'Close poll,New poll', 'the asker can close it or start a new one');
  assert.equal(await poll(ted, 'poll', () => [...document.querySelectorAll('.row button')].map((b) => b.textContent).join()), '', 'nobody else, while she\'s here');

  step('nothing done in the live poll went through the relay (every page\'s relay messages recorded)');
  for (const p of [nick, robin, ted]) {
    const out = await room(p, () => window.__relayOut.join('\n'));
    assert.ok(!/Tea or coffee|Coffee|"t":"vote"|live-msg|live-send|live-here/.test(out), `${p.name}: tile content in a relay message`);
  }
  assert.ok((await room(nick, () => window.__relayOut.join('\n'))).includes('"tile-live"'), 'only the switch itself went through the relay');

  step('only the host\'s page speaks for the room: a live message forged by Robin\'s page (over its direct connection to Ted) is ignored');
  const tedPeer = await room(ted, () => window.__roomsLab.room.me);
  await until(robin, (t) => window.__roomsLab.room.mesh.channelOpen(t), tedPeer);
  await room(robin, ([t, u, id]) => {
    window.__roomsLab.room.mesh.sendData(t, { kind: 'live-msg', uri: u, n: 99, from: id, data: { t: 'vote', poll: 'x'.repeat(16), option: 0, k: 1 } });
    window.__roomsLab.room.mesh.sendData(t, { kind: 'live-here', uri: u, here: [id] });
  }, [tedPeer, uriOf('poll'), ids[1]]);
  await until(ted, () => window.__roomsLab.room.log.filter((l) => /live: live-(msg|here) not from the host: ignored/.test(l)).length === 2);
  assert.equal(await statusOf(ted, 'poll'), 'Live · 3 here');

  step('only copies of the same tile: a second poll (another record) opened for everyone hears nothing of the first');
  await openForEveryone(nick, 'poll2');
  for (const p of [nick, ted]) await cardState(p, 'poll2', 'open');
  await pollUntil(ted, 'poll2', () => /^Just you\./.test(document.getElementById('status').textContent));
  await vote(ted, 'poll', 1);
  for (const p of [nick, ted]) await pollUntil(p, 'poll', () => [...document.querySelectorAll('.count')].map((c) => +c.textContent).join() === '0,3,0,0');
  for (const p of [nick, ted]) assert.equal(await poll(p, 'poll2', () => JSON.stringify(window.__poll.state)), '{"poll":null,"votes":{}}', `${p.name}'s second poll heard nothing at all`);

  step('Zoe joins late: her copy gets the live poll as it stands (from the copies already live)');
  await join(zoe, invite, 'Join room');
  await cardState(zoe, 'poll', 'open');
  await pollUntil(zoe, 'poll', () => document.getElementById('status').textContent === 'Live · 4 here');
  await pollUntil(zoe, 'poll', () => [...document.querySelectorAll('.count')].map((c) => +c.textContent).join() === '0,3,0,0');
  assert.equal(await poll(zoe, 'poll', () => document.querySelector('.mine')), null, 'Zoe hasn\'t voted');
  for (const p of [nick, robin, ted]) await pollUntil(p, 'poll', () => document.getElementById('status').textContent === 'Live · 4 here');

  step('Robin (the asker) leaves: the others still see her vote; now anyone may start a new poll; Ted does, everyone gets it');
  await room(robin, () => window.__roomsLab.leave());
  for (const p of [nick, ted, zoe]) await pollUntil(p, 'poll', () => document.getElementById('status').textContent === 'Live · 3 here');
  assert.deepEqual(await counts(ted, 'poll'), [0, 3, 0, 0], 'her vote is kept');
  await pollUntil(ted, 'poll', () => [...document.querySelectorAll('.row button')].some((b) => b.textContent === 'New poll'));
  const tf = await tileFrame(ted, 'poll');
  await tf.click('button:has-text("New poll")');
  await tf.selectOption('select', '0');
  await tf.click('button:has-text("Start poll")');
  for (const p of [nick, ted, zoe]) await pollUntil(p, 'poll', () => document.querySelector('.poll h1')?.textContent === 'How’s the sound?');
  for (const p of [nick, zoe]) assert.deepEqual(await counts(p, 'poll'), [0, 0, 0]);

  step('a guest asks to share a tile live: Zoe\'s "Ask to share live" on the second poll; Nick\'s approval card with the house\'s reason; Allow');
  await cardState(zoe, 'poll2', 'open');
  await until(zoe, (u) => !document.querySelector(`.rl-tile[data-uri="${u}"] .rl-tile-live-ask`).hidden, uriOf('poll2'));
  await button(zoe, 'poll2', 'Ask to share live').click();
  const ask = nick.page.locator('.rl-approval', { hasText: 'Zoe asks to share “Live poll 2” live with the room.' });
  await ask.waitFor();
  assert.match(await ask.textContent(), /House: The host approves tiles shared live\. If you allow it, every copy of it sends what people do in it to the others/);
  await ask.locator('button', { hasText: 'Allow' }).click();
  for (const p of [nick, ted, zoe]) await pollUntil(p, 'poll2', () => document.getElementById('status').textContent === 'Live · 3 here');
  await until(zoe, () => /The host shared the tile live with the room\./.test(document.querySelector('.rl-status').textContent));

  step('too many messages: the sender\'s copy says so (and the others never see the extras)');
  await poll(zoe, 'poll', () => { for (let i = 0; i < 45; i++) window.parent.postMessage({ action: 'tiles-protocol-up-live-payload', payload: { v: 1, kind: 'send', data: { t: 'noise', i } } }, '*'); });
  await pollUntil(zoe, 'poll', () => /Slow down a little/.test(document.getElementById('notice').textContent));

  step('the host away: live copies pause ("Paused…"), then Nick comes back as host and they resume');
  await nick.page.reload();
  await nick.page.waitForSelector('button:has-text("Rejoin as host")');
  for (const p of [ted, zoe]) await pollUntil(p, 'poll', () => document.getElementById('status').textContent === 'Paused: waiting for the room to come back');
  assert.equal(await poll(ted, 'poll', () => document.querySelector('.vote').disabled), true, 'no voting while paused');
  await nick.page.click('button:has-text("Rejoin as host")');
  await until(nick, () => window.__roomsLab.room?.link.joined === true);
  await cardState(nick, 'poll', 'open');
  for (const rk of ['poll', 'counter', 'poll2']) assert.equal(await card(nick, rk).locator('.rl-tile-by').textContent(), 'opened by You', `after his reload, ${rk} is still Nick's own (not "Someone")`);
  for (const p of [nick, ted, zoe]) await pollUntil(p, 'poll', () => document.getElementById('status').textContent === 'Live · 3 here', undefined, 30000);
  await pollUntil(ted, 'poll', () => document.querySelector('.poll h1')?.textContent === 'How’s the sound?');
  await pollUntil(nick, 'poll', () => document.querySelector('.poll h1')?.textContent === 'How’s the sound?', undefined, 10000);
  await vote(zoe, 'poll', 2);
  for (const p of [nick, ted, zoe]) await pollUntil(p, 'poll', () => [...document.querySelectorAll('.count')].map((c) => +c.textContent).join() === '0,0,1');

  step('Stop sharing live: the badge goes, each copy is "Just you" again and keeps its poll; votes stay on each page');
  await button(nick, 'poll', 'Stop sharing live').click();
  for (const p of [nick, ted, zoe]) await pollUntil(p, 'poll', () => /^Just you\./.test(document.getElementById('status').textContent));
  for (const p of [nick, ted, zoe]) assert.equal(await card(p, 'poll').locator('.rl-tile-live').isVisible(), false);
  for (const p of [nick, ted, zoe]) assert.deepEqual(await counts(p, 'poll'), [0, 0, 1], `${p.name} keeps what it had`);
  await vote(ted, 'poll', 0);
  await pollUntil(ted, 'poll', () => [...document.querySelectorAll('.count')].map((c) => +c.textContent).join() === '1,0,1');
  await nick.page.waitForTimeout(800);
  assert.deepEqual(await counts(nick, 'poll'), [0, 0, 1], 'Ted\'s vote stays on his own copy now');
  assert.equal(await visible(button(nick, 'poll', 'Share live with the room')), true, 'and it can be shared live again');

  step('phone width: no sideways scroll with live cards');
  await zoe.page.setViewportSize({ width: 390, height: 900 });
  // (wait for the page's resize handling: measuring straight after the resize sometimes caught the staged card at its old width)
  await zoe.page.waitForFunction(() => document.documentElement.scrollWidth <= window.innerWidth, undefined, { timeout: 3000, polling: 100 }).catch(() => {});
  assert.equal(await room(zoe, () => document.documentElement.scrollWidth <= window.innerWidth), true);
  await card(nick, 'poll2').screenshot({ path: '/tmp/claude-0/live-card-nick.png' });
  await zoe.page.screenshot({ path: '/tmp/claude-0/live-zoe-phone.png' });

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nAll live-tile steps passed.');
} catch (e) {
  console.error('\nFAILED:', e.message);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  await dev.close();
}
