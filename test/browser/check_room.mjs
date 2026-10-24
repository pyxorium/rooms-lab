// check_room.mjs: the Rooms lab page's browser check (the chat sandbox; rooms-lab-plan.md, section 9),
// build steps 2 and 3.
//
// Runs the real relay and the lab's dev page (dev/serve.mjs), with the house tile in a sealed frame on the
// host's page, then Chromium pages with a fake microphone (a beep) and a fake screen, each in its own
// browser profile (own storage), like separate computers:
//   step 2: Nick makes a room; Robin joins. Voice both ways, who's talking, mute. Robin asks to see Nick's
//   screen: Nick's prompt, nothing shared until Nick clicks, then the picker and the stage ("detail"). Ted
//   joins late and gets the stage. "Not now". A relay drop doesn't cut the call. Two at once: one stage.
//   Nick's page goes away and comes back as host. Remove, End room. Names as typed.
//   step 3: the house decides. Robin asks to see Ted's screen: Nick approves or denies; Ted still decides
//   in his own prompt. Ted asks to present: Nick allows, Ted gets "The host said you can present" and
//   shares only on his click. The host's own requests go straight on. A guest can't skip the house (asks
//   and go-aheads not from the host are ignored). Nothing can be asked while the host is away; the house
//   comes back with the host. A room with no house: the host approves each request. The house tile on its
//   own shows its card.
//   step 4: Nick, presenting, opens a tile for everyone: his share gives the stage to the tile, and every
//   page opens its own copy (clicks in one copy don't reach the others). A tile on Raku's hide list is
//   refused by the host's page, and by each page for itself if sent anyway. Robin asks to open a tile; Nick
//   approves. A tile changed after it was opened, or a file that isn't what the record says, is refused on
//   every page. Close for everyone; Hide for me. A newcomer gets the open tiles; so does the host after a
//   reload. A page with no tile loader says so. The tiles' servers (plc.directory, the author's PDS, the hide
//   list, Bluesky) are stand-ins answering with the real servers' CORS headers; tiles open in a stand-in
//   for the tile loader (a sealed frame of the tile's page), fed by the page's own pinned file loader.
// WebRTC between pages in one sandbox connects locally without STUN: this can't show how home networks
// behave; the owner's two-computer test is the real proof.
//
//   node test/browser/check_room.mjs           (needs Playwright with Chromium; not part of npm test)
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
  counter1: { name: 'Counter', letter: 'q' }, counter2: { name: 'Counter Two', letter: 'r' }, hidden1: { name: 'Hidden', letter: 's' },
  changing1: { name: 'Changing', letter: 't', changing: true }, badblob1: { name: 'Broken file', letter: 'u', badBlob: true },
};
for (const [rkey, t] of Object.entries(TILES)) {
  t.bytes = new TextEncoder().encode(counterPage(t.name));
  t.blobCid = await rawCid(t.bytes);
  t.cid = `bafyrei${t.letter.repeat(52)}`;
}
const uriOf = (rkey) => `at://${TILE_DID}/ing.dasl.masl/${rkey}`;
const HIDE_LIST = { version: 1, salt: SALT, accounts: [], tiles: [await sha256Hex(tileKey(SALT, TILE_DID, 'hidden1'))] };
const recordReads = new Map();
const CORS = { 'access-control-allow-origin': '*' };
async function standIns(ctx) {
  const json = (route, body, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await ctx.route('https://plc.directory/**', (route) => json(route, { id: TILE_DID, service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: TILE_PDS }] }));
  await ctx.route(`${TILE_PDS}/**`, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/xrpc/com.atproto.repo.getRecord') {
      const rkey = u.searchParams.get('rkey'), t = TILES[rkey];
      if (!t) return json(route, { error: 'RecordNotFound' }, 400);
      const n = (recordReads.get(rkey) || 0) + 1;
      recordReads.set(rkey, n);
      const cid = t.changing && n > 1 ? `bafyrei${'v'.repeat(52)}` : t.cid;    // changed after the host's first read
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
  await ctx.route('https://public.api.bsky.app/**', (route) => json(route, { did: new URL(route.request().url()).searchParams.get('actor'), handle: 'someone.test', labels: [] }));
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
const stageClear = (p) => until(p, () => document.querySelector('.rl-video').hidden && /Nobody is sharing/.test(document.querySelector('.rl-caption').textContent));

try {
  const nick = await person('Nick'), robin = await person('Robin'), ted = await person('Ted');

  step('the lobby says what the lab is (honest wording)');
  await nick.page.goto(PAGE);
  const honest = await nick.page.locator('.rl-honest').textContent();
  for (const t of ['not checked', 'Nothing is recorded', 'stores nothing', 'directly between the computers', 'no TURN', "runs on each person's own computer"]) assert.ok(honest.includes(t), t);

  step('Nick makes a room: his page holds the house, sealed (scripts only, no origin of its own), and it says it\'s ready');
  await join(nick, PAGE, 'New room');
  await until(nick, () => document.querySelector('.rl-house-line').dataset.house === 'ready');
  assert.match(await nick.page.locator('.rl-house-line').textContent(), /House: the room’s rules \(host-approves\)/);
  assert.equal(await nick.page.locator('.rl-house iframe').getAttribute('sandbox'), 'allow-scripts');
  const invite = await nick.page.inputValue('.rl-invite');
  assert.match(invite, /#r=[a-z2-9]{12}$/);
  assert.ok(!invite.includes('&k='), 'the invite link carries no host key');

  step('Robin joins; only the host\'s page holds a house');
  await join(robin, invite, 'Join room');
  await until(nick, () => document.querySelectorAll('.rl-person').length === 2);
  await until(robin, () => document.querySelectorAll('.rl-person').length === 2);
  assert.equal(await row(robin, 'Nick').locator('.rl-tag-host').count(), 1, 'Robin sees Nick as host');
  assert.equal(await robin.page.locator('.rl-house iframe').count(), 0);
  assert.equal(await robin.page.locator('.rl-house-line').isVisible(), false);
  assert.equal(await robin.page.locator('.rl-host-tools').isVisible(), false);

  step('the direct connection comes up before anyone unmutes (the data channel)');
  await until(robin, () => [...document.querySelectorAll('.rl-conn')].length === 0, undefined, 15000);
  assert.equal(await room(nick, () => window.__roomsLab.room.micTrack), null, 'mic off on joining');

  step('both unmute: each hears the other, and sees them talking; mute switches the track off');
  await nick.page.click('.rl-mic');
  await robin.page.click('.rl-mic');
  await until(nick, () => document.querySelector('.rl-mic').getAttribute('aria-pressed') === 'true');
  assert.ok(await hears(robin, 'Nick'), 'Robin receives Nick\'s voice');
  assert.ok(await hears(nick, 'Robin'), 'Nick receives Robin\'s voice');
  await until(robin, () => [...document.querySelectorAll('.rl-person')].some((li) => li.textContent.includes('Nick') && li.querySelector('.rl-talking')), undefined, 10000);
  await nick.page.click('.rl-mic');
  assert.equal(await room(nick, () => window.__roomsLab.room.micTrack.enabled), false);
  await nick.page.click('.rl-mic');
  assert.equal(await room(nick, () => window.__roomsLab.room.micTrack.enabled), true);

  step('Robin asks to see Nick\'s (the host\'s) screen: the house sends it straight to Nick\'s prompt; nothing shared until Nick clicks');
  await row(robin, 'Nick').locator('.rl-ask').click();
  await promptShown(nick);
  assert.equal(await nick.page.locator('.rl-prompt-q').textContent(), 'Robin asks to see your screen. Share with 1 person?');
  assert.match(await nick.page.locator('.rl-prompt').textContent(), /one window or tab/);
  assert.ok(await logHas(nick, /⌂ Robin: see-screen .*allow — The host answers for their own screen\./), 'the house\'s decision is in the room\'s messages');
  assert.equal(await approval(nick, 'Robin').count(), 0, 'no approval card for the host\'s own screen');
  await nick.page.waitForTimeout(1500);
  assert.equal(await sharing(nick), false, 'no share without the person\'s click');

  step('Nick clicks "Choose what to share…": the picker (faked), and Nick\'s screen is on Robin\'s stage');
  await nick.page.click('button:has-text("Choose what to share")');
  await stageShows(robin);
  assert.equal(await robin.page.locator('.rl-caption').textContent(), 'Nick’s screen');
  assert.equal(await room(nick, () => window.__roomsLab.room.screenTrack.contentHint), 'detail');
  assert.equal(await nick.page.locator('.rl-share').textContent(), 'Stop sharing');
  assert.equal(await robin.page.locator('.rl-share').textContent(), 'Nick is presenting');
  assert.equal(await robin.page.locator('.rl-share').isDisabled(), true, 'one screen at a time');
  assert.equal(await row(robin, 'Nick').locator('.rl-tag-on').count(), 1, 'Nick marked presenting');
  assert.ok(await hears(robin, 'Nick'), 'voice carries on while sharing');

  step('Ted joins late: he sees the host, who\'s presenting, and gets the screen');
  await join(ted, invite, 'Join room');
  await until(ted, () => document.querySelectorAll('.rl-person').length === 3);
  await stageShows(ted);
  assert.equal(await ted.page.locator('.rl-caption').textContent(), 'Nick’s screen');
  assert.equal(await status(ted), 'Nick is presenting.');

  step('Nick stops sharing: the stage clears for everyone');
  await nick.page.click('.rl-share');
  for (const p of [robin, ted]) await stageClear(p);
  assert.equal(await sharing(nick), false);

  step('the host asks Robin (his own request goes on); Robin says "Not now"; nothing is shared');
  await row(nick, 'Robin').locator('.rl-ask').click();
  await promptShown(robin);
  assert.equal(await robin.page.locator('.rl-prompt-q').textContent(), 'Nick asks to see your screen. Share with 2 people?');
  assert.doesNotMatch(await robin.page.locator('.rl-prompt').textContent(), /The host allowed/);
  await robin.page.click('button:has-text("Not now")');
  await waitStatus(nick, /Robin said not now/);
  assert.equal(await sharing(robin), false);

  step('Robin asks to see Ted\'s screen: the house says the host approves; Nick denies; Ted is never asked');
  await row(robin, 'Ted').locator('.rl-ask').click();
  await waitStatus(robin, /Asked the host if you can see Ted’s screen/);
  await approval(nick, 'Robin asks to see Ted’s screen.').waitFor();
  assert.match(await approval(nick, 'Robin asks to see Ted’s screen.').textContent(), /House: The host approves screen requests\. If you allow it, Ted still chooses whether to share\./);
  await approval(nick, 'Robin asks to see Ted’s screen.').locator('button', { hasText: 'Deny' }).click();
  await waitStatus(robin, /The host said no\./);
  assert.equal(await ted.page.locator('.rl-prompt').isHidden(), true, 'Ted never sees a denied request');
  assert.equal(await approval(nick, 'Robin').count(), 0, 'the card closes');

  step('Robin asks again; Nick allows; Ted still decides in his own prompt, then shares');
  await until(robin, () => !document.querySelector('.rl-person .rl-ask').disabled);
  await row(robin, 'Ted').locator('.rl-ask').click();
  await approval(nick, 'Robin asks to see Ted’s screen.').locator('button', { hasText: 'Allow' }).click();
  await waitStatus(robin, /The host allowed it\. Waiting for Ted/);
  await promptShown(ted);
  assert.equal(await ted.page.locator('.rl-prompt-q').textContent(), 'Robin asks to see your screen. Share with 2 people?');
  assert.match(await ted.page.locator('.rl-prompt').textContent(), /The host allowed this request; you decide\./);
  await ted.page.waitForTimeout(1000);
  assert.equal(await sharing(ted), false, 'the host\'s Allow doesn\'t share anything');
  await ted.page.click('button:has-text("Choose what to share")');
  await stageShows(robin);
  assert.equal(await robin.page.locator('.rl-caption').textContent(), 'Ted’s screen');
  await ted.page.click('.rl-share');
  await stageClear(robin);

  step('Ted asks to present (Share my screen): Nick allows; Ted gets "The host said you can present" and shares only on his click');
  await ted.page.click('.rl-share');
  assert.equal(await ted.page.locator('.rl-share').textContent(), 'Asked the host…');
  await approval(nick, 'Ted asks to present their screen.').locator('button', { hasText: 'Allow' }).click();
  await promptShown(ted);
  assert.equal(await ted.page.locator('.rl-prompt-q').textContent(), 'The host said you can present. Share with 2 people?');
  assert.equal(await status(ted), 'The host said you can present.');
  await ted.page.waitForTimeout(1000);
  assert.equal(await sharing(ted), false, 'nothing shared before Ted\'s click');
  await ted.page.click('.rl-share');                    // Share my screen, while the prompt is open: the picker, no second request
  await stageShows(robin);
  assert.equal(await robin.page.locator('.rl-caption').textContent(), 'Ted’s screen');
  assert.equal(await approval(nick, 'Ted').count(), 0, 'no second request reached the host');
  assert.equal(await row(robin, 'Nick').locator('.rl-ask').isDisabled(), true, 'no asking while someone presents');
  assert.equal(await robin.page.locator('.rl-share').isDisabled(), true);

  step('a wish sent anyway while Ted presents (Robin\'s page, around its disabled button): the house denies it');
  const nickId = await room(nick, () => window.__roomsLab.room.me);
  await room(robin, (id) => window.__roomsLab.room.link.to(id, { kind: 'wish', id: 'sneaky1', wish: 'present' }), nickId);
  await until(nick, () => window.__roomsLab.room.log.some((l) => /⌂ Robin: present: deny — Someone is presenting\. One screen at a time\./.test(l)));
  assert.ok(await logHas(robin, /wish-result deny: Someone is presenting/));
  assert.equal(await approval(nick, 'Robin').count(), 0);
  await ted.page.click('.rl-share');
  await stageClear(robin);

  step('a guest can\'t skip the house: an ask, a go-ahead or a result sent straight from Robin to Ted is ignored');
  const tedId = await room(ted, () => window.__roomsLab.room.me);
  await room(robin, (id) => {
    const l = window.__roomsLab.room.link;
    l.to(id, { kind: 'ask-screen', id: 'forged1', asker: window.__roomsLab.room.me });
    l.to(id, { kind: 'go-ahead', id: 'forged2' });
    l.to(id, { kind: 'wish-result', id: 'forged3', decision: 'allow' });
  }, tedId);
  await until(ted, () => window.__roomsLab.room.log.filter((l) => /not from the host: ignored/.test(l)).length === 3);
  assert.equal(await ted.page.locator('.rl-prompt').isHidden(), true);
  assert.equal(await sharing(ted), false);

  step('the host\'s own Share goes straight to the picker (the house allows it, his click still fresh)');
  await nick.page.click('.rl-share');
  await stageShows(robin);
  assert.equal(await nick.page.locator('.rl-prompt').isHidden(), true);
  await nick.page.click('.rl-share');
  await stageClear(robin);

  const tileState = (p, rkey) => room(p, (u) => document.querySelector(`.rl-tile[data-uri="${u}"]`)?.dataset.state ?? null, uriOf(rkey));
  const tileIs = (p, rkey, state) => until(p, ([u, st]) => document.querySelector(`.rl-tile[data-uri="${u}"]`)?.dataset.state === st, [uriOf(rkey), state], 20000);
  const tileCard = (p, rkey) => p.page.locator(`.rl-tile[data-uri="${uriOf(rkey)}"]`);
  const counter = (p, rkey) => p.page.frameLocator(`.rl-tile[data-uri="${uriOf(rkey)}"] iframe`).locator('#b');
  async function openTile(p, rkey) { await p.page.fill('.rl-tile-input', uriOf(rkey)); await p.page.click('.rl-tile-open'); }

  step('step 4: Nick, presenting, opens a tile for everyone: the house allows it, the tile takes the stage from his share, and every page opens its own copy');
  await nick.page.click('.rl-share');
  await stageShows(robin);
  assert.equal(await nick.page.locator('.rl-tile-open').textContent(), 'Open for everyone');
  assert.equal(await robin.page.locator('.rl-tile-open').textContent(), 'Ask to open for everyone');
  await openTile(nick, 'counter1');
  for (const p of [nick, robin, ted]) await tileIs(p, 'counter1', 'open');
  assert.equal(await tileCard(robin, 'counter1').locator('.rl-tile-name').textContent(), 'Counter');
  assert.equal(await tileCard(robin, 'counter1').locator('.rl-tile-by').textContent(), 'opened by Nick');
  await stageClear(robin);
  assert.equal(await sharing(nick), false, 'the tile took the stage');
  assert.ok(await logHas(nick, /⌂ You: open-tile \("Counter"\): allow — The host may open tiles for everyone\./));
  assert.ok(await logHas(robin, /← Nick: tile counter1 \(opened by Nick\)/));

  step('each person plays with their own copy: clicks in one copy don\'t reach the others');
  for (let i = 0; i < 3; i++) await counter(robin, 'counter1').click();
  await counter(ted, 'counter1').click();
  assert.equal(await counter(robin, 'counter1').textContent(), '3');
  assert.equal(await counter(ted, 'counter1').textContent(), '1');
  assert.equal(await counter(nick, 'counter1').textContent(), '0');

  step('Robin asks to open a tile on Raku\'s hide list: the host\'s page refuses it; nothing opens anywhere');
  await openTile(robin, 'hidden1');
  await waitStatus(robin, /That tile isn’t shown here\./);
  assert.equal(await approval(nick, 'Robin').count(), 0);
  for (const p of [nick, robin, ted]) assert.equal(await tileState(p, 'hidden1'), null);

  step('the same tile sent anyway (from the host\'s page itself): each page checks for itself and doesn\'t show it');
  await room(nick, ([u, c]) => { const r = window.__roomsLab.room; r.link.all({ kind: 'tile', uri: u, cid: c, by: r.me }); }, [uriOf('hidden1'), TILES.hidden1.cid]);
  for (const p of [robin, ted]) {
    await tileIs(p, 'hidden1', 'hidden');
    assert.equal(await tileCard(p, 'hidden1').locator('.rl-tile-status').textContent(), 'This tile isn’t shown here.');
    assert.equal(await tileCard(p, 'hidden1').locator('iframe').count(), 0);
    await tileCard(p, 'hidden1').locator('.rl-tile-hide').click();
  }

  step('a tile sent by a guest\'s page (not the host\'s) is ignored everywhere');
  await room(robin, ([u, c]) => { const r = window.__roomsLab.room; r.link.all({ kind: 'tile', uri: u, cid: c, by: r.me }); }, [uriOf('counter2'), TILES.counter2.cid]);
  await ted.page.waitForTimeout(1500);
  for (const p of [nick, ted]) assert.equal(await tileState(p, 'counter2'), null);

  step('Robin asks to open another tile: Nick approves; everyone gets it; Robin hears so');
  await openTile(robin, 'counter2');
  await approval(nick, 'Robin asks to open “Counter Two” for everyone.').waitFor();
  assert.match(await approval(nick, 'Counter Two').textContent(), /House: The host approves tiles opened for everyone\. If you allow it, each person’s page checks the tile and opens its own copy\./);
  await approval(nick, 'Counter Two').locator('button', { hasText: 'Allow' }).click();
  await waitStatus(robin, /The host opened the tile for everyone\./);
  for (const p of [nick, robin, ted]) await tileIs(p, 'counter2', 'open');
  assert.equal(await tileCard(ted, 'counter2').locator('.rl-tile-by').textContent(), 'opened by Robin');

  step('a tile that changed after it was opened is refused on every page (everyone runs the same version, or nobody does)');
  await openTile(nick, 'changing1');
  for (const p of [nick, robin, ted]) await tileIs(p, 'changing1', 'changed');
  assert.match(await tileCard(robin, 'changing1').locator('.rl-tile-status').textContent(), /has changed since it was opened for everyone/);

  step('a file that isn\'t what the record says is refused (the page checks every file\'s address)');
  await openTile(nick, 'badblob1');
  for (const p of [robin, ted]) await tileIs(p, 'badblob1', 'failed');
  for (const p of [robin, ted]) assert.equal(await tileCard(p, 'badblob1').locator('iframe').count(), 0, 'no empty frame under the refusal');

  if (process.env.SHOTS) {
    await nick.page.screenshot({ path: `${process.env.SHOTS}/step4-nick.png`, fullPage: true });
    await robin.page.screenshot({ path: `${process.env.SHOTS}/step4-robin.png`, fullPage: true });
    await tileCard(robin, 'counter1').screenshot({ path: `${process.env.SHOTS}/step4-robin-tile.png` });
  }
  step('Close for everyone (the host) takes a tile off every strip; Hide for me only off your own');
  assert.equal(await tileCard(robin, 'changing1').locator('.rl-tile-close').isVisible(), false, 'only the host closes for everyone');
  await tileCard(nick, 'changing1').locator('.rl-tile-close').click();
  for (const p of [nick, robin, ted]) await until(p, (u) => !document.querySelector(`.rl-tile[data-uri="${u}"]`), uriOf('changing1'));
  await tileCard(robin, 'counter2').locator('.rl-tile-hide').click();
  assert.equal(await tileState(robin, 'counter2'), null);
  assert.equal(await tileState(ted, 'counter2'), 'open');

  step('a newcomer gets the tiles already open; at phone width the strip fits');
  const zoe = await person('Zoe');
  await join(zoe, invite, 'Join room');
  await tileIs(zoe, 'counter1', 'open');
  await tileIs(zoe, 'counter2', 'open');
  assert.equal(await counter(zoe, 'counter1').textContent(), '0', 'her own copy');
  await zoe.page.setViewportSize({ width: 375, height: 760 });
  assert.equal(await zoe.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  if (process.env.SHOTS) await zoe.page.screenshot({ path: `${process.env.SHOTS}/step4-zoe-phone.png`, fullPage: true });
  await zoe.ctx.close();
  await until(nick, () => document.querySelectorAll('.rl-person').length === 3);

  step('Robin\'s link to the relay drops: voice carries on, and the page rejoins by itself');
  await robin.page.click('.rl-mic');                                   // Robin unmuted earlier; keep sending
  await robin.page.click('.rl-mic');
  const robinId = await room(robin, () => window.__roomsLab.room.me);
  const bytesFrom = (id) => nick.page.evaluate(async (peer) => {
    const pc = window.__roomsLab.room.mesh.connection(peer);
    if (!pc) return -1;
    let n = 0;
    (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') n += s.bytesReceived || 0; });
    return n;
  }, id);
  await nick.page.evaluate((peer) => { window.__keptPc = window.__roomsLab.room.mesh.connection(peer); }, robinId);
  await room(robin, () => window.__roomsLab.room.link.blip());
  const b1 = await bytesFrom(robinId);
  await nick.page.waitForTimeout(1200);
  const b2 = await bytesFrom(robinId);
  assert.ok(b1 >= 0 && b2 > b1, `Robin's voice keeps arriving while her relay link is down (${b1} → ${b2})`);
  await until(robin, () => window.__roomsLab.room.link.joined === true && /You're in the room/.test(document.querySelector('.rl-status').textContent));
  await until(nick, () => document.querySelectorAll('.rl-person').length === 3);
  assert.equal(await nick.page.evaluate((peer) => window.__roomsLab.room.mesh.connection(peer) === window.__keptPc, robinId), true, 'the same direct connection, never dropped');

  step('Robin and Ted both ask to present; Nick allows both; they press Choose at the same moment: one stage, all pages agree');
  await robin.page.click('.rl-share');
  await ted.page.click('.rl-share');
  await approval(nick, 'Robin asks to present').locator('button', { hasText: 'Allow' }).click();
  await approval(nick, 'Ted asks to present').locator('button', { hasText: 'Allow' }).click();
  await promptShown(robin); await promptShown(ted);
  await Promise.all([robin.page.click('button:has-text("Choose what to share")'), ted.page.click('button:has-text("Choose what to share")')]);
  await nick.page.waitForTimeout(2500);
  const who = await Promise.all([nick, robin, ted].map((p) => room(p, () => window.__roomsLab.room.presenter)));
  assert.ok(who[0] && who.every((x) => x === who[0]), `everyone agrees on the presenter (${who})`);
  const both = await Promise.all([robin, ted].map(sharing));
  assert.equal(both.filter(Boolean).length, 1, 'exactly one screen is shared');
  const winner = both[0] ? robin : ted;
  await stageShows(nick);
  await winner.page.click('.rl-share');
  await until(nick, () => document.querySelector('.rl-video').hidden);

  step('at phone width the page has no sideways scroll (an approval card showing)');
  await robin.page.click('.rl-share');
  await approval(nick, 'Robin asks to present').waitFor();
  await nick.page.setViewportSize({ width: 375, height: 760 });
  assert.equal(await nick.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await nick.page.setViewportSize({ width: 1280, height: 720 });
  await approval(nick, 'Robin asks to present').locator('button', { hasText: 'Deny' }).click();
  await waitStatus(robin, /The host said no/);

  step('Nick\'s page goes away: Robin and Ted see "Waiting for Nick…" and can\'t ask anything; Nick comes back as host, with the house');
  await nick.page.goto('about:blank');
  for (const p of [robin, ted]) {
    await waitStatus(p, /Waiting for Nick to come back/);
    await until(p, () => [...document.querySelectorAll('.rl-person')].some((li) => li.textContent.includes('Nick') && li.textContent.includes('away')));
  }
  assert.equal(await robin.page.locator('.rl-share').isDisabled(), true, 'no wishes while the host is away');
  assert.equal(await row(robin, 'Ted').locator('.rl-ask').isDisabled(), true);
  await nick.page.goBack();
  await nick.page.waitForSelector('button:has-text("Rejoin as host")');
  await nick.page.click('button:has-text("Rejoin as host")');
  await waitStatus(nick, /You're the host/);
  await until(nick, () => document.querySelector('.rl-house-line').dataset.house === 'ready');
  await tileIs(nick, 'counter1', 'open');                                     // the host's tiles, back after the reload
  await waitStatus(robin, /The host is back/);
  await until(robin, () => document.querySelectorAll('.rl-person').length === 3 && ![...document.querySelectorAll('.rl-person')].some((li) => li.textContent.includes('away')));
  await nick.page.click('.rl-mic');
  assert.ok(await (async () => { for (let i = 0; i < 10; i++) { if (await hears(robin, 'Nick')) return true; } return false; })(), 'Nick\'s voice is back for Robin');
  await row(robin, 'Ted').locator('.rl-ask').click();
  await approval(nick, 'Robin asks to see Ted’s screen.').waitFor();         // the new house decides
  await approval(nick, 'Robin asks to see Ted’s screen.').locator('button', { hasText: 'Deny' }).click();

  step('Nick removes Ted: Ted is told; the others see two people');
  await row(nick, 'Ted').locator('.rl-remove').click();
  await waitStatus(ted, /The host took you out of the room/);
  await until(robin, () => document.querySelectorAll('.rl-person').length === 2);

  step('Nick ends the room: Robin is told it ended');
  await nick.page.click('button:has-text("End room")');
  await waitStatus(robin, /The host ended the room/);
  await waitStatus(nick, /The host ended the room/);

  step('a room with no house (?house=off): the host approves each request');
  const host2 = await person('Ana'), guest2 = await person('Ben');
  const guest3 = await person('Cal', { tiles: false });
  await join(host2, `${PAGE}&house=off`, 'New room');
  assert.equal(await host2.page.locator('.rl-house-line').textContent(), 'No house tile: you approve each request yourself.');
  assert.equal(await host2.page.locator('.rl-house iframe').count(), 0);
  await join(guest2, await host2.page.inputValue('.rl-invite'), 'Join room');
  await until(host2, () => document.querySelectorAll('.rl-person').length === 2);
  await guest2.page.click('.rl-share');
  await approval(host2, 'Ben asks to present their screen.').waitFor();
  assert.match(await approval(host2, 'Ben asks').textContent(), /No house: The host approves each request\. If you allow it, Ben still chooses what to share\./);
  await approval(host2, 'Ben asks').locator('button', { hasText: 'Allow' }).click();
  await promptShown(guest2);
  assert.equal(await guest2.page.locator('.rl-prompt-q').textContent(), 'The host said you can present. Share with 1 person?');
  await join(guest3, await host2.page.inputValue('.rl-invite'), 'Join room');
  await openTile(host2, 'counter1');
  await tileIs(host2, 'counter1', 'open');
  await tileIs(guest3, 'counter1', 'no-loader');
  assert.equal(await tileCard(guest3, 'counter1').locator('.rl-tile-status').textContent(), 'This page can’t open tiles (it has no tile loader).');

  step('names are shown as typed, never as markup');
  const sneaky = await person('<b>Bold</b>');
  await join(sneaky, PAGE, 'New room');
  assert.equal(await sneaky.page.locator('.rl-who').first().textContent(), '<b>Bold</b>');
  assert.equal(await sneaky.page.locator('.rl-who b').count(), 0);

  step('the house tile opened on its own shows what it is');
  const alone = await person('alone');
  await alone.page.goto(`${dev.url}tiles/house/index.html`);
  await alone.page.waitForSelector('#card:not([hidden])', { timeout: 5000 });
  assert.match(await alone.page.locator('#card figcaption').textContent(), /holds the room's rules/);
  assert.equal(await alone.page.evaluate(() => document.querySelector('#card-pic').naturalWidth), 1280);

  assert.deepEqual(errors, [], 'no errors on the pages');
  console.log('\nAll room checks passed.');
} catch (e) {
  console.error('\nFAILED:', e.message);
  if (errors.length) console.error('Page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await dev.close();
}
