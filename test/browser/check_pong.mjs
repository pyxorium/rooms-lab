// check_pong.mjs: Live Pong (tiles/pong) in the Rooms lab page, in the chat sandbox (rooms-pong-plan.md).
//
// The real relay and the lab's dev page (dev/serve.mjs) with the house tile, and Chromium profiles like
// separate computers: Nick (host), Robin, Ted, later Zoe (a phone held upright). Live Pong runs for real, in a
// sealed frame, fed by the page's own pinned file loader from a stand-in author's server. The players' copies
// play themselves (window.__pong.autopilot: "good" returns every ball, "miss" misses), so whole games run.
//   - opened for everyone, before it's live: each copy plays the computer
//   - shared live: the play list ("I'd like to play", typed names or "Player N"), the first two play; every copy
//     reaches the same list, game, score and result with no referee copy; players see themselves on the left
//   - nothing played goes through the relay; watchers have no Pause; the ball waits at a player's line for
//     their call (never drawn past it while the rally is on)
//   - pause between points; the speed readout and "Copy numbers"; the paddle rate stepped up to 20
//   - the dev page's delay knob (?livedelay=100): host vs guest, then guest vs guest: the round trips and the
//     "stick" grow as they should (one hop, two hops), and play goes on
//   - a late joiner gets the game as it stands; a player reloads mid-rally (the point is played again);
//     the host reloads (the room pauses, then play goes on); a player leaves for good (the other wins by default)
//   - a phone held upright: the court turns
//
//   node test/browser/check_pong.mjs      (needs Playwright with Chromium; not part of npm test; about 3 minutes)
//   PONG_SHOTS=folder node test/browser/check_pong.mjs      also saves a few pictures of the cards there
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join as pathJoin } from 'node:path';
import assert from 'node:assert/strict';
import { startDev } from '../../dev/serve.mjs';
import { rawCid } from '../../scripts/lib/cid.js';
import { HIDE_LIST_URL } from '../../src/hide-check.js';
import { ROOT, TILES as OWN_TILES } from '../../scripts/tiles.mjs';
import { planeOf } from '../../tiles/pong/pong-physics.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import('playwright')); }

const t0 = Date.now();
const SHOTS = process.env.PONG_SHOTS || null;
const step = (s) => console.log(`- ${s}  (${Math.round((Date.now() - t0) / 1000)} s)`);
const dev = await startDev({ port: 0, relayPort: 0, quiet: true });
const PAGE = `${dev.url}?relay=${encodeURIComponent(dev.relayUrl)}`;
// (no throttling of pages that aren't in front: every page here is a computer of its own, drawing its court)
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required',
  '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'] });
const errors = [];
const DATA_JS = '/.well-known/web-tiles/data.js';

// ---- Stand-ins for the tile's server (the real servers' CORS headers) ----
const DID = 'did:plc:tiletiletiletiletiletile';
const PDS = 'https://pds.tiles.test';
const CORS = { 'access-control-allow-origin': '*' };
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
async function realTile(name, letter) {          // Live Pong's own files, as publish.mjs would publish them
  const resources = {}, blobs = {};
  for (const f of [...OWN_TILES.pong.files, 'icon.png', 'banner.png']) {
    const bytes = readFileSync(pathJoin(ROOT, 'tiles', 'pong', f));
    const cid = await rawCid(new Uint8Array(bytes));
    const ct = types[f.slice(f.lastIndexOf('.'))];
    blobs[cid] = bytes;
    resources[f === 'index.html' ? '/' : `/${f}`] = { src: { $type: 'blob', ref: { $link: cid }, mimeType: ct, size: bytes.length }, 'content-type': ct };
  }
  return { name, cid: `bafyrei${letter.repeat(52)}`, manifest: { name, sizing: OWN_TILES.pong.sizing, resources }, blobs };
}
const TILES = { pong: await realTile('Live Pong', 'q') };
const uriOf = (rkey) => `at://${DID}/ing.dasl.masl/${rkey}`;
async function standIns(ctx) {
  const json = (route, body, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await ctx.route('https://plc.directory/**', (route) => json(route, { id: DID, alsoKnownAs: ['at://tiles.test'], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] }));
  await ctx.route(`${PDS}/**`, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/xrpc/com.atproto.repo.getRecord') {
      const t = TILES[u.searchParams.get('rkey')];
      if (!t) return json(route, { error: 'RecordNotFound' }, 400);
      return json(route, { uri: uriOf(u.searchParams.get('rkey')), cid: t.cid, value: { $type: 'ing.dasl.masl', cid: t.cid, tile: t.manifest, createdAt: '2026-11-05T12:00:00.000Z' } });
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
    return json(route, { did: u.searchParams.get('actor'), handle: 'tiles.test', labels: [] });
  });
}
// The stand-in tile loader: every file through the page's pinned loader, then the tile in a sealed frame.
const STANDIN_TILE_HOST = () => {
  window.__roomsLabTileHost = {
    async render({ manifest, loader }) {
      for (const path of Object.keys(manifest.resources)) { const r = await loader.resolvePath(path); if (!r.ok) return null; }
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.src = '/tiles/pong/index.html';
      return f;
    },
  };
};
const RECORD_RELAY = () => {
  window.__relayOut = [];
  setInterval(() => {
    const r = window.__roomsLab?.room;
    if (!r?.link || r.link.__wrapped) return;
    for (const k of ['to', 'all']) { const f = r.link[k].bind(r.link); r.link[k] = (...a) => { window.__relayOut.push(JSON.stringify(a)); return f(...a); }; }
    r.link.__wrapped = true;
  }, 20);
};

async function person(name, viewport = { width: 1100, height: 1500 }) {
  const ctx = await browser.newContext({ permissions: ['microphone'], viewport });
  await standIns(ctx);
  await ctx.addInitScript(STANDIN_TILE_HOST);
  await ctx.addInitScript(RECORD_RELAY);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.text().includes(DATA_JS) || (m.location()?.url || '').includes(DATA_JS)) return;
    errors.push(`${name} console: ${m.text()}`);
  });
  return { name, ctx, page };
}
const until = (p, fn, arg, ms = 30000) => p.page.waitForFunction(fn, arg, { timeout: ms, polling: 100 });
const room = (p, fn, arg) => p.page.evaluate(fn, arg);
async function join(p, link, button) {
  await p.page.goto(link);
  await p.page.fill('.rl-name', p.name);
  await p.page.click(`button:has-text("${button}")`);
  await until(p, () => window.__roomsLab.room?.link.joined === true);
}
const card = (p) => p.page.locator(`.rl-tile[data-uri="${uriOf('pong')}"]`);
const cardState = (p, st) => until(p, ([u, s]) => document.querySelector(`.rl-tile[data-uri="${u}"]`)?.dataset.state === s, [uriOf('pong'), st]);
const frame = async (p) => (await card(p).locator('iframe').elementHandle()).contentFrame();
const pong = async (p, fn, arg) => (await frame(p)).evaluate(fn, arg);
const pongUntil = async (p, fn, arg, ms = 30000) => (await frame(p)).waitForFunction(fn, arg, { timeout: ms, polling: 100 });
const S = (p) => pong(p, () => JSON.stringify(window.__pong.state));
const shot = async (p, name) => { if (SHOTS) await card(p).screenshot({ path: `${SHOTS}/${name}.png` }); };
async function same(ps, what = 'the copies agree') {
  // they agree once the last message has reached everyone: wait for a moment where all are equal
  const deadline = Date.now() + 10000;
  let states;
  while (Date.now() < deadline) {
    states = await Promise.all(ps.map(S));
    if (new Set(states).size === 1) return JSON.parse(states[0]);
    await new Promise((r) => setTimeout(r, 150));
  }
  assert.fail(`${what}: ${states.join('\n')}`);
}
async function openForEveryone(host, address) {
  await host.page.fill('.rl-tile-input', address);
  await host.page.click('.rl-tile-preview-go');
  await cardState(host, 'open');
  await card(host).locator('button', { hasText: 'Open for everyone' }).click();
  await until(host, (u) => !document.querySelector(`.rl-tile[data-uri="${u}"]`)?.classList.contains('rl-tile-preview'), uriOf('pong'));
}
async function wantToPlay(p, name) {
  const f = await frame(p);
  await f.click('#playBtn');
  await f.fill('#nameBox', name);
  await f.click('#joinBtn');
  await pongUntil(p, () => window.__pong.state.list.includes(window.__pong.you) || !!(window.__pong.state.game && [window.__pong.state.game.a, window.__pong.state.game.b].includes(window.__pong.you)));
}
const auto = (p, how) => pong(p, (h) => { window.__pong.autopilot = h; }, how);
const statusOf = (p) => pong(p, () => document.getElementById('status').textContent);
async function setupRoom(people, link) {
  await join(people[0], link, 'New room');
  await until(people[0], () => document.querySelector('.rl-house-line').dataset.house === 'ready');
  const invite = await people[0].page.inputValue('.rl-invite');
  return invite;
}
// The ball as a watcher draws it, sampled while the rally is on: never past a paddle's line (P17).
async function sampleWatcher(p, ms) {
  return pong(p, (ms2) => new Promise((resolve) => {
    let worst = 0, n = 0;
    const timer = setInterval(() => {
      const st = window.__pong.state, b = window.__pong.ball;
      if (st.game?.rally && b) { n += 1; worst = Math.max(worst, b.s - 762, 38 - b.s); }
    }, 5);
    setTimeout(() => { clearInterval(timer); resolve({ worst, n }); }, ms2);
  }), ms);
}

try {
  // ======== Part 1: a room with no added delay ========
  const nick = await person('Nick'), robin = await person('Robin'), ted = await person('Ted');
  step('Nick makes a room; Robin and Ted join; direct connections come up');
  const invite = await setupRoom([nick], PAGE);
  await join(robin, invite, 'Join room');
  await join(ted, invite, 'Join room');
  const nickPeer = await room(nick, () => window.__roomsLab.room.me);
  for (const p of [robin, ted]) await until(p, (h) => window.__roomsLab.room.mesh.channelOpen(h), nickPeer);

  step('Nick opens Live Pong for everyone; not live yet: every copy plays the computer');
  await openForEveryone(nick, `at://${DID}/ing.dasl.masl/pong`);
  for (const p of [nick, robin, ted]) { await cardState(p, 'open'); await pongUntil(p, () => window.__pong?.mode === 'alone'); }
  assert.equal(await statusOf(robin), 'Just you, playing the computer');
  assert.equal(await pong(robin, () => document.getElementById('playBtn')?.textContent), 'Play');
  await (await frame(robin)).click('#playBtn');
  await pongUntil(robin, () => window.__pong.state.game?.b === 'computer');
  await pongUntil(robin, () => !!window.__pong.state.game?.rally, undefined, 10000);
  assert.equal(await pong(nick, () => window.__pong.state.game), null, 'Robin\'s game against the computer is hers alone');

  step('keys move your paddle; the mouse doesn\'t (P10)');
  const rbox = await card(robin).locator('iframe').boundingBox();
  const p0 = await pong(robin, () => window.__pong.myPaddle);
  for (let i = 0; i < 12; i++) await robin.page.mouse.move(rbox.x + 60, rbox.y + 120 + i * 25);
  assert.equal(await pong(robin, () => window.__pong.myPaddle), p0, 'the mouse moved nothing');
  await robin.page.mouse.click(rbox.x + rbox.width / 2, rbox.y + rbox.height / 2);     // the court gets the keys
  await robin.page.keyboard.down('ArrowDown');
  await new Promise((r) => setTimeout(r, 250));
  await robin.page.keyboard.up('ArrowDown');
  const p1 = await pong(robin, () => window.__pong.myPaddle);
  assert.ok(p1 > p0 + 40, `↓ moved the paddle down (${p0} → ${p1})`);
  await robin.page.keyboard.down('w');
  await new Promise((r) => setTimeout(r, 150));
  await robin.page.keyboard.up('w');
  assert.ok(await pong(robin, () => window.__pong.myPaddle) < p1, 'W moved it up');

  step('Nick shares it live: every copy is live and starts afresh ("Live · 3 here"); Robin\'s game against the computer is set aside');
  await until(nick, (u) => !document.querySelector(`.rl-tile[data-uri="${u}"] .rl-tile-live-on`).hidden, uriOf('pong'));
  await card(nick).locator('.rl-tile-actions button', { hasText: 'Share live with the room' }).click();
  for (const p of [nick, robin, ted]) await pongUntil(p, () => window.__pong?.mode === 'live' && window.__pong.synced && document.getElementById('status').textContent === 'Live · 3 here');
  await same([nick, robin, ted]);
  assert.equal(JSON.parse(await S(robin)).game, null);

  step('the play list: Robin taps "I\'d like to play" with her name; everyone sees "Waiting for a second player"; Nick joins with no name ("Player 1"): the game starts, Robin vs Player 1');
  await wantToPlay(robin, 'Robin');
  for (const p of [nick, robin, ted]) await pongUntil(p, () => window.__pong.state.list.length === 1);
  assert.match(await pong(ted, () => document.getElementById('line').textContent), /Next: Robin/);
  await wantToPlay(nick, '');
  let st = await same([nick, robin, ted]);
  assert.ok(st.game, 'two on the list: a game');
  const ids = Object.fromEntries(await Promise.all([nick, robin, ted].map(async (p) => [p.name, await pong(p, () => window.__pong.you)])));
  assert.equal(st.game.a, ids.Robin);
  assert.equal(st.game.b, ids.Nick);
  assert.equal(st.names[ids.Nick], 'Player 1');
  assert.equal(st.names[ids.Robin], 'Robin');
  assert.ok(!JSON.stringify(st).includes('Nick') && !JSON.stringify(st).includes('Ted'), 'the room\'s own names never reach the tile');
  assert.match(await pong(ted, () => document.getElementById('line').textContent), /Playing: Robin vs Player 1 · Nobody else on the list · 1 watching/);

  step('players see themselves on the left (Nick plays B: his court is turned round); Ted (watching) has no Pause; the players do');
  assert.deepEqual(await pong(nick, () => window.__pong.view), { portrait: false, me: 'b' });
  assert.deepEqual(await pong(robin, () => window.__pong.view), { portrait: false, me: 'a' });
  assert.deepEqual(await pong(ted, () => window.__pong.view), { portrait: false, me: 'a' });
  assert.equal(await pong(ted, () => document.getElementById('pauseBtn').hidden), true);
  for (const p of [nick, robin]) assert.equal(await pong(p, () => document.getElementById('pauseBtn').hidden), false);

  step('a rally: both return everything; the server serves after a short wait; every copy has the same rally; watchers never draw the ball past a paddle\'s line');
  await auto(robin, 'good'); await auto(nick, 'good');
  await pongUntil(ted, () => (window.__pong.state.game?.rally?.hits ?? 0) >= 4, undefined, 40000);
  await shot(ted, 'watching'); await shot(nick, 'playing-b');
  const w = await sampleWatcher(ted, 3000);
  assert.ok(w.n > 50 && w.worst <= 1, `the ball stays within the paddles' lines on a watcher's screen (${JSON.stringify(w)})`);
  await same([nick, robin, ted], 'mid-rally');

  step('nothing played goes through the relay (every page\'s relay messages recorded)');
  for (const p of [nick, robin, ted]) {
    const out = await room(p, () => window.__relayOut.join('\n'));
    assert.ok(!/"t":"(pad|hit|serve|list|ping|state)"|live-msg|live-send/.test(out), `${p.name}: game content in a relay message`);
  }

  step('the speed readout: Robin opens the gauge: round trips measured, the other paddle\'s updates arriving; Copy numbers');
  const rf = await frame(robin);
  await rf.click('#gaugeBtn');
  await pongUntil(robin, () => /ms typical/.test(document.getElementById('g-rtt')?.textContent || ''), undefined, 15000);
  await pongUntil(robin, () => window.__pong.numbers().arriving > 2, undefined, 15000);
  await rf.click('#copyBtn');
  await pongUntil(robin, () => { const t = document.querySelector('#gauge textarea'); return t && !t.hidden && /^Live Pong numbers\nRole: playing; 3 here\nRound trip: typical \d+ ms, worst \d+ ms/.test(t.value); });
  const text = await pong(robin, () => document.querySelector('#gauge textarea').value);
  await shot(robin, 'gauge');
  assert.match(text, /Paddle rate setting: 10 a second; sent [\d.]+ a second; held back \d+/);
  assert.match(text, /Room limits: \d+ \(rate \d+, room \d+, other \d+\)/);
  assert.match(text, /Messages this game: \d+/);
  assert.ok(!text.includes(ids.Robin) && !text.includes('Robin'), 'no ids or names in the numbers');
  console.log(text.split('\n').map((l) => `    ${l}`).join('\n'));

  step('the paddle rate stepped up to 20: the tile holds updates back to stay inside the room\'s limit, and the game\'s own messages still get through');
  await rf.click('.rates button[data-rate="20"]');
  await auto(robin, 'busy');                                        // her paddle never keeps still
  const hitsBefore = await pong(robin, () => (window.__pong.state.game?.rally?.hits ?? 0));
  await new Promise((r) => setTimeout(r, 9000));
  const n20 = await pong(robin, () => window.__pong.numbers());
  console.log(`    at 20 a second: sent ${n20.sent}, held back ${n20.heldBack}, room limits ${JSON.stringify(n20.limits)}; Robin's frames every ${await pong(robin, () => window.__pong.frameMs)} ms`);
  assert.equal(n20.limits.rate + n20.limits.room, 0, 'the room never had to refuse a message: the tile kept inside its limit (10 a second, bursts of 30)');
  assert.ok(n20.heldBack > 0, 'asked for 20 a second, the tile held some updates back');
  assert.ok((await pong(robin, () => (window.__pong.state.game?.rally?.hits ?? 0))) > hitsBefore || (await pong(robin, () => window.__pong.state.game?.pt)) > 1, 'play went on');
  await rf.click('.rates button[data-rate="10"]');
  await auto(robin, 'good');

  step('pause between points: Robin pauses; the rally plays out, then "Paused by Robin" and no serve; Nick resumes; the next serve comes');
  await (await frame(robin)).click('#pauseBtn');
  await pongUntil(ted, () => window.__pong.state.game?.pauseBy);
  await auto(nick, 'miss');                                         // end the rally
  await pongUntil(ted, () => window.__pong.state.game && !window.__pong.state.game.rally, undefined, 30000);
  await auto(nick, 'good');
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(await pong(ted, () => !!window.__pong.state.game.rally), false, 'no serve while paused');
  assert.equal(await pong(nick, () => document.getElementById('pauseBtn').textContent), 'Resume');
  await (await frame(nick)).click('#pauseBtn');
  await pongUntil(ted, () => !!window.__pong.state.game?.rally, undefined, 10000);
  st = await same([nick, robin, ted], 'after the pause');
  assert.equal(st.game.score.a, 1, 'Robin won the point Nick missed');

  step('a whole game: Nick misses everything: Robin wins 7–1; every copy has the same result; the players are off the list (tap again)');
  await auto(nick, 'miss');
  await pongUntil(ted, () => !!window.__pong.state.last, undefined, 120000);
  st = await same([nick, robin, ted], 'after the game');
  assert.equal(st.last.winner, 'a');
  assert.equal(st.last.score.a, 7);
  assert.equal(st.game, null);
  assert.deepEqual(st.list, []);
  assert.match(await pong(ted, () => window.__pong.center), /^Robin wins 7–\d$/);
  assert.equal(await pong(robin, () => document.getElementById('playBtn')?.textContent), 'I’d like to play', 'Robin taps again to play again');

  // ======== Part 2: the delay knob: guest vs guest, a late joiner, comings and goings ========
  step('a new room with ?livedelay=100 on every page (the dev page only): every live message between computers leaves 100 ms late');
  for (const p of [nick, robin, ted]) await room(p, () => window.__roomsLab.leave?.());
  const slow = (link) => link.replace('?', '?livedelay=100&');
  const invite2 = await setupRoom([nick], slow(PAGE));
  await join(robin, slow(invite2), 'Join room');
  await join(ted, slow(invite2), 'Join room');
  const nickPeer2 = await room(nick, () => window.__roomsLab.room.me);
  for (const p of [robin, ted]) await until(p, (h) => window.__roomsLab.room.mesh.channelOpen(h), nickPeer2);
  await openForEveryone(nick, `at://${DID}/ing.dasl.masl/pong`);
  for (const p of [nick, robin, ted]) await cardState(p, 'open');
  await until(nick, (u) => !document.querySelector(`.rl-tile[data-uri="${u}"] .rl-tile-live-on`).hidden, uriOf('pong'));
  await card(nick).locator('.rl-tile-actions button', { hasText: 'Share live with the room' }).click();
  for (const p of [nick, robin, ted]) await pongUntil(p, () => window.__pong?.mode === 'live' && window.__pong.synced && window.__pong.here.length === 3);

  step('host vs guest (one hop): Nick and Robin play; Robin\'s round trip ≈ 200 ms; the stick ≈ 200 ms on both screens; the rally goes on');
  await wantToPlay(nick, 'Nick'); await wantToPlay(robin, 'Robin');
  await same([nick, robin, ted]);
  for (const p of [nick, robin, ted]) await (await frame(p)).click('#gaugeBtn');
  await auto(nick, 'good'); await auto(robin, 'good');
  await pongUntil(ted, () => (window.__pong.state.game?.rally?.hits ?? 0) >= 5, undefined, 60000);
  const one = {
    robinRtt: (await pong(robin, () => window.__pong.numbers().rtt)).typical,
    nickRtt: (await pong(nick, () => window.__pong.numbers().rtt))?.typical ?? 0,
    nickStick: await pong(nick, () => window.__pong.stickMs), robinStick: await pong(robin, () => window.__pong.stickMs),
  };
  console.log(`    host vs guest at 100 ms a hop: ${JSON.stringify(one)}; frames every ${await pong(nick, () => window.__pong.frameMs)} / ${await pong(robin, () => window.__pong.frameMs)} ms`);
  assert.ok(one.robinRtt >= 180 && one.robinRtt < 450, 'a guest\'s round trip: two hops');
  assert.ok(one.nickRtt < 120, 'the host\'s own copy is next to the hub');
  assert.ok(one.nickStick >= 160 && one.nickStick < 500 && one.robinStick >= 160 && one.robinStick < 500, 'the stick: the round trip between the two players');
  await same([nick, robin, ted], 'one hop');
  await auto(nick, 'miss');
  await pongUntil(ted, () => !!window.__pong.state.last, undefined, 150000);
  await same([nick, robin, ted], 'after the one-hop game');

  step('guest vs guest (two hops): Robin and Ted play, Nick watches; each round trip ≈ 200 ms; the stick ≈ 400 ms; the rally goes on');
  await auto(nick, null);
  await wantToPlay(robin, 'Robin'); await wantToPlay(ted, 'Ted');
  await auto(robin, 'good'); await auto(ted, 'good');
  await pongUntil(nick, () => (window.__pong.state.game?.rally?.hits ?? 0) >= 5, undefined, 60000);
  const two = {
    robinRtt: (await pong(robin, () => window.__pong.numbers().rtt)).typical, tedRtt: (await pong(ted, () => window.__pong.numbers().rtt)).typical,
    robinStick: await pong(robin, () => window.__pong.stickMs), tedStick: await pong(ted, () => window.__pong.stickMs), nickStick: await pong(nick, () => window.__pong.stickMs),
  };
  console.log(`    guest vs guest at 100 ms a hop: ${JSON.stringify(two)}`);
  assert.ok(two.robinStick >= 340 && two.robinStick < 800 && two.tedStick >= 340 && two.tedStick < 800, 'the stick: four hops between the players');
  await same([nick, robin, ted], 'two hops');

  step('Zoe joins late, on a phone held upright: her copy gets the game as it stands; her court is turned (the players at top and bottom)');
  const zoe = await person('Zoe', { width: 390, height: 1400 });
  await join(zoe, slow(invite2), 'Join room');
  await cardState(zoe, 'open');
  await pongUntil(zoe, () => window.__pong?.mode === 'live' && window.__pong.synced, undefined, 30000);
  await same([nick, robin, ted, zoe], 'the late joiner');
  assert.equal((await pong(zoe, () => window.__pong.view)).portrait, true);
  await shot(zoe, 'phone-upright');

  step('Robin reloads mid-rally: her copy keeps its id, catches up and says it\'s back; the point is played again; the score is kept');
  const before = JSON.parse(await S(nick)).game;
  const robinId = await pong(robin, () => window.__pong.you);
  await robin.page.reload();                               // the same tab: its live ids are kept
  await robin.page.fill('.rl-name', 'Robin');
  await robin.page.click('button:has-text("Join room")');
  await until(robin, () => window.__roomsLab.room?.link.joined === true);
  await cardState(robin, 'open');
  await pongUntil(robin, () => window.__pong?.mode === 'live' && window.__pong.synced, undefined, 30000);
  await pongUntil(nick, (b) => window.__pong.state.game?.backs > b, before.backs, 30000);
  st = await same([nick, robin, ted, zoe], 'after Robin\'s reload');
  assert.equal(await pong(robin, () => window.__pong.you), robinId, 'the same copy id after the reload');
  assert.equal(st.game.a, robinId, 'still playing');
  assert.ok(st.game && st.game.score.a + st.game.score.b >= before.score.a + before.score.b, 'the score is kept');
  assert.equal(st.game.g, before.g, 'the same game');
  await auto(robin, 'good');
  await pongUntil(nick, () => (window.__pong.state.game?.rally?.hits ?? 0) >= 2, undefined, 60000);

  step('the host reloads: everyone\'s copy pauses ("Paused"), then Nick rejoins as host; the rally is served again; play goes on, the score kept');
  const pre = JSON.parse(await S(ted)).game;
  await nick.page.reload();
  await nick.page.waitForSelector('button:has-text("Rejoin as host")');
  for (const p of [robin, ted]) await pongUntil(p, () => window.__pong.roomPaused === true, undefined, 15000);
  await nick.page.click('button:has-text("Rejoin as host")');
  await until(nick, () => window.__roomsLab.room?.link.joined === true);
  await cardState(nick, 'open');
  for (const p of [robin, ted]) await pongUntil(p, () => window.__pong.roomPaused === false, undefined, 30000);
  await pongUntil(nick, () => window.__pong?.mode === 'live' && window.__pong.synced, undefined, 30000);
  await pongUntil(ted, (r) => window.__pong.state.game?.rally && window.__pong.state.game.rally.r !== r, pre.rally?.r ?? -1, 30000);
  await pongUntil(ted, () => (window.__pong.state.game?.rally?.hits ?? 0) >= 2, undefined, 60000);
  st = await same([nick, robin, ted, zoe], 'after the host\'s reload');
  assert.equal(st.game.g, pre.g);
  assert.ok(st.game.score.a + st.game.score.b >= pre.score.a + pre.score.b);

  step('Ted leaves for good mid-game: Robin\'s copy waits ~15 s ("Waiting for Ted to come back…"), then claims the game: Robin wins by default, on every copy');
  await room(ted, () => window.__roomsLab.leave());
  await pongUntil(robin, () => window.__pong.here.length === 3, undefined, 15000);
  await pongUntil(robin, () => window.__pong.center === 'Waiting for Ted to come back…', undefined, 10000);
  await pongUntil(nick, () => window.__pong.state.last?.how === 'claim', undefined, 40000);
  st = await same([nick, robin, zoe], 'after the claim');
  assert.equal(st.last.winner, 'a');
  assert.equal(st.last.a, await pong(robin, () => window.__pong.you));

  step('Stop sharing live: every copy goes back to playing the computer');
  await card(nick).locator('.rl-tile-actions button', { hasText: 'Stop sharing live' }).click();
  for (const p of [nick, robin, zoe]) await pongUntil(p, () => window.__pong?.mode === 'alone');

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`\nAll Live Pong steps passed (${Math.round((Date.now() - t0) / 1000)} s).`);
} catch (e) {
  console.error(e);
  if (errors.length) console.error('Page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await dev.close();
}
