// check_turn.mjs: TURN in the browser (build step 7; claude/rooms-lab-step7.md).
//
// Runs the real relay and the lab's dev page (dev/serve.mjs) with a stand-in for Cloudflare's credentials
// API (the relay's `turn`), and a tiny real TURN server (turn-standin.mjs) in place of turn.cloudflare.com,
// so Chromium really sends media through TURN when told to:
//   - with TURN on: each page asks the relay once, gets credentials, connects directly when it can ("direct");
//     no note; the invite link never carries the test switch;
//   - credentials running out: the next rejoin asks for fresh ones, and the connections take them;
//   - &turn=only on Ted's page: everything goes through TURN; both people see "via relay"; voice still
//     arrives; the TURN server really relayed packets; Robin's own address keeps the switch; the note says so;
//   - a relay blip doesn't ask Cloudflare again (the credentials still have hours to run);
//   - TURN off (no secrets): the "fallback relay isn't available" note; rooms still connect directly;
//   - TURN off and &turn=only: the page says it can't connect, and it doesn't;
//   - a malformed answer from the relay: refused by the page, treated as unavailable.
//
//   node test/browser/check_turn.mjs           (needs Playwright with Chromium; not part of npm test)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { startDev } from '../../dev/serve.mjs';
import { startTurnStandin } from './turn-standin.mjs';
import { NET_NOTES } from '../../src/room-page.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import('playwright')); }

const ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const step = (s) => console.log(`- ${s}`);
const errors = [];

const turnServer = await startTurnStandin({ host: '127.0.0.1', users: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`tester${i + 1}`, `secret${i + 1}`])) });
// The stand-in for Cloudflare's credentials API, as the relay sees it (turn.js's createTurn shape).
const cloudflare = { asks: 0, on: true, async get() { this.asks += 1; return { iceServers: turnServer.servers(`tester${this.asks}`), ttl: 14400 }; } };
const withTurn = await startDev({ port: 0, relayPort: 0, quiet: true, turn: cloudflare });
const noTurn = await startDev({ port: 0, relayPort: 0, quiet: true, turn: { on: false, get: async () => null } });
// A relay whose answer is malformed (as if Cloudflare's format changed, or something got in between).
const oddTurn = await startDev({ port: 0, relayPort: 0, quiet: true, turn: { on: true, get: async () => ({ iceServers: [{ urls: ['turn:not a host:3478', 'https://example.com/'], username: 'x', credential: 'y' }], ttl: 14400 }) } });
const pageOf = (dev) => `${dev.url}?relay=${encodeURIComponent(dev.relayUrl)}&house=off`;
const browser = await chromium.launch({ args: ARGS });

async function person(name) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  return { name, ctx, page };
}
const until = (p, fn, arg, ms = 20000) => p.page.waitForFunction(fn, arg, { timeout: ms, polling: 100 });
const room = (p, fn, arg) => p.page.evaluate(fn, arg);
const row = (p, name) => p.page.locator('.rl-person', { has: p.page.locator('.rl-who', { hasText: name }) });
const routeTag = (p, name) => row(p, name).locator('.rl-route');
const net = (p) => p.page.evaluate(() => { const e = document.querySelector('.rl-net'); return e && !e.hidden ? e.textContent : ''; });
async function join(p, link, button) {
  await p.page.goto(link);
  await p.page.fill('.rl-name', p.name);
  await p.page.click(`button:has-text("${button}")`);
  await until(p, () => window.__roomsLab.room?.link.joined === true);
}
const audioIn = (p, who) => p.page.evaluate(async (w) => {
  const r = window.__roomsLab.room;
  const peer = [...r.people.values()].find((x) => x.name === w)?.peer;
  const pc = r.mesh.connection(peer);
  if (!pc) return -1;
  let n = 0;
  (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') n += s.bytesReceived || 0; });
  return n;
}, who);
async function hears(p, who) {
  const a = await audioIn(p, who);
  await p.page.waitForTimeout(1500);
  return (await audioIn(p, who)) > a && a >= 0;
}
const unmute = async (p) => { await p.page.click('.rl-mic'); await until(p, () => window.__roomsLab.room.micTrack?.enabled === true); };

try {
  {
    step('TURN on: each page asks once and gets credentials; people still connect directly when they can; no note');
    const nick = await person('Nick'), robin = await person('Robin');
    await join(nick, pageOf(withTurn), 'New room');
    const invite = await nick.page.inputValue('.rl-invite');
    await join(robin, invite, 'Join room');
    await until(nick, () => window.__roomsLab.room.ice.state === 'on');
    await until(robin, () => window.__roomsLab.room.ice.state === 'on');
    assert.equal(cloudflare.asks, 2);
    await routeTag(nick, 'Robin').waitFor({ timeout: 20000 });
    assert.equal(await routeTag(nick, 'Robin').textContent(), 'direct');
    assert.equal(await routeTag(robin, 'Nick').textContent(), 'direct');
    assert.equal(await net(nick), '');
    const cfg = await room(nick, () => { const r = window.__roomsLab.room; return r.mesh.connection(r.mesh.ids[0]).getConfiguration(); });
    assert.equal(cfg.iceTransportPolicy, 'all');
    assert.ok(cfg.iceServers.some((s) => (s.urls || []).some?.((u) => u.startsWith('turn:')) || String(s.urls).startsWith('turn:')), 'the connection knows the TURN server');
    assert.ok(cfg.iceServers.some((s) => String(s.urls).includes('stun:')), 'and still the STUN servers');
    assert.match(await room(nick, () => window.__roomsLab.room.log.join('\n')), /TURN relay is ready/);

    step('a relay blip: the page rejoins without asking Cloudflare again (hours left on the credentials)');
    await room(robin, () => window.__roomsLab.room.link.blip());
    await until(robin, () => window.__roomsLab.room.link.joined === false, undefined, 5000).catch(() => {});
    await until(robin, () => window.__roomsLab.room.link.joined === true);
    await robin.page.waitForTimeout(500);
    assert.equal(cloudflare.asks, 2);

    step('credentials running out (3 hours on): the next rejoin asks for fresh ones and every connection gets them');
    const oldUser = await room(robin, () => window.__roomsLab.room.ice.servers.find((s) => s.username).username);
    await room(robin, () => { window.__roomsLab.room.ice.at = Date.now() - 3.5 * 3600_000; window.__roomsLab.room.link.blip(); });
    await until(robin, () => window.__roomsLab.room.ice.at > Date.now() - 60_000);
    assert.equal(cloudflare.asks, 3);
    const newUser = await room(robin, () => window.__roomsLab.room.ice.servers.find((s) => s.username).username);
    assert.notEqual(newUser, oldUser);
    const inPc = await room(robin, () => { const r = window.__roomsLab.room; return r.mesh.connection(r.mesh.ids[0]).getConfiguration().iceServers.find((s) => s.username).username; });
    assert.equal(inPc, newUser, 'the live connection took the fresh credentials');

    step('&turn=only on Ted\'s page: everything goes through TURN, both people see "via relay", voice still arrives');
    const relayedBefore = turnServer.stats().relayedOut;
    const ted = await person('Ted');
    await join(ted, `${invite}&turn=only`, 'Join room');
    assert.match(ted.page.url(), /&turn=only$/, 'Ted\'s own address keeps the switch');
    assert.equal(await ted.page.inputValue('.rl-invite'), invite, 'the invite link he would send doesn\'t carry it');
    assert.equal(await net(ted), NET_NOTES.turnOnly);
    await until(ted, () => window.__roomsLab.room.ice.state === 'on');
    await routeTag(ted, 'Nick').waitFor({ timeout: 25000 });
    assert.equal(await routeTag(ted, 'Nick').textContent(), 'via relay');
    await routeTag(nick, 'Ted').waitFor({ timeout: 25000 });
    assert.equal(await routeTag(nick, 'Ted').textContent(), 'via relay', 'Nick sees it too: the connection to Ted goes through TURN');
    assert.equal(await routeTag(nick, 'Robin').textContent(), 'direct', 'Nick and Robin still connect directly');
    const tedCfg = await room(ted, () => { const r = window.__roomsLab.room; return r.mesh.connection(r.mesh.ids[0]).getConfiguration().iceTransportPolicy; });
    assert.equal(tedCfg, 'relay');
    await unmute(nick);
    assert.ok(await hears(ted, 'Nick'), 'Ted hears Nick through TURN');
    await unmute(ted);
    assert.ok(await hears(nick, 'Ted'), 'Nick hears Ted through TURN');
    assert.ok(turnServer.stats().relayedOut > relayedBefore + 20, 'the TURN server really relayed packets');
    assert.ok(turnServer.stats().allocations >= 1);
    await Promise.all([nick, robin, ted].map((p) => p.ctx.close()));
  }

  {
    step('TURN off (no secrets on the relay): the note says the fallback relay isn\'t available; people still connect directly');
    const ann = await person('Ann'), bo = await person('Bo');
    await join(ann, pageOf(noTurn), 'New room');
    await until(ann, () => window.__roomsLab.room.ice.state === 'off');
    assert.equal(await net(ann), NET_NOTES.unavailable);
    const invite = await ann.page.inputValue('.rl-invite');
    await join(bo, invite, 'Join room');
    await routeTag(ann, 'Bo').waitFor({ timeout: 20000 });
    assert.equal(await routeTag(ann, 'Bo').textContent(), 'direct');
    assert.equal(await net(bo), NET_NOTES.unavailable);

    step('TURN off and &turn=only: the page says it can\'t connect, and it doesn\'t');
    const cy = await person('Cy');
    await join(cy, `${invite}&turn=only`, 'Join room');
    await until(cy, () => window.__roomsLab.room.ice.state === 'off');
    assert.equal(await net(cy), NET_NOTES.turnOnlyNone);
    await cy.page.waitForTimeout(6000);
    assert.equal(await routeTag(cy, 'Ann').count(), 0, 'no route: nothing connected');
    assert.notEqual(await room(cy, () => { const r = window.__roomsLab.room; return r.mesh.state(r.mesh.ids[0]); }), 'connected');
    await Promise.all([ann, bo, cy].map((p) => p.ctx.close()));
  }

  {
    step('a malformed answer from the relay is refused by the page: treated as unavailable, the note shows, connections start without it');
    const dee = await person('Dee');
    await join(dee, pageOf(oddTurn), 'New room');
    await until(dee, () => window.__roomsLab.room.ice.state === 'unavailable');
    assert.equal(await net(dee), NET_NOTES.unavailable);
    assert.equal(await room(dee, () => window.__roomsLab.room.mesh.iceReady), true);
    await dee.ctx.close();
  }

  step('the relay never put the TURN key in a page (only the credentials the stand-in made)');
  assert.ok(!(await (await fetch(withTurn.url + 'src/config.js')).text()).includes('TURN_KEY'), 'no key in the page\'s files');

  assert.deepEqual(errors, [], 'no errors in the pages');
  console.log('\nAll TURN checks passed.');
} catch (e) {
  console.error('\nFAILED:', e);
  if (errors.length) console.error('page errors:', errors);
  process.exitCode = 1;
} finally {
  await browser.close();
  await withTurn.close();
  await noTurn.close();
  await oddTurn.close();
  turnServer.close();
}
