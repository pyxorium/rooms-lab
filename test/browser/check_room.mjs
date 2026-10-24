// check_room.mjs: build step 2's browser check (the chat sandbox; rooms-lab-plan.md, section 9).
//
// Runs the real relay and the lab's dev page (dev/serve.mjs), then three Chromium pages with a fake
// microphone (a beep) and a fake screen, each in its own browser profile (own storage), like three
// computers:
//   Nick makes a room; Robin joins from the invite link. Both unmute: each hears the other (audio bytes
//   arriving) and sees the other talking. Robin asks to see Nick's screen: Nick's page shows the prompt and
//   shares NOTHING until Nick clicks; then the picker (faked), and Nick's screen is on Robin's stage, sharp
//   ("detail"). Ted joins late and gets the stage too. Two screens can't be shared at once. Nick stops;
//   Nick asks Robin, Robin says "Not now". Nick's page goes away: Robin and Ted see "Waiting for Nick…";
//   Nick comes back with "Rejoin as host" and voice comes back. Nick removes Ted, then ends the room.
// WebRTC between pages in one sandbox connects locally without STUN: this can't show how home networks
// behave; the owner's two-computer test is the real proof.
//
//   node test/browser/check_room.mjs           (needs Playwright with Chromium; not part of npm test)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { startDev } from '../../dev/serve.mjs';

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

async function person(name) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  return { name, ctx, page };
}
const until = async (p, fn, arg, ms = 15000) => p.page.waitForFunction(fn, arg, { timeout: ms, polling: 100 });
const status = (p) => p.page.locator('.rl-status').first().textContent();
const waitStatus = (p, re, ms) => until(p, (src) => new RegExp(src).test(document.querySelector('.rl-status')?.textContent || ''), re.source, ms);
const row = (p, name) => p.page.locator('.rl-person', { has: p.page.locator('.rl-who', { hasText: name }) });
const room = (p, expr) => p.page.evaluate(expr);

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

try {
  const nick = await person('Nick'), robin = await person('Robin'), ted = await person('Ted');

  step('the lobby says what the lab is (honest wording)');
  await nick.page.goto(PAGE);
  const honest = await nick.page.locator('.rl-honest').textContent();
  for (const t of ['not checked', 'Nothing is recorded', 'stores nothing', 'directly between the computers', 'no TURN']) assert.ok(honest.includes(t), t);

  step('Nick makes a room; the invite link has the room code; Robin joins with it');
  await join(nick, PAGE, 'New room');
  const invite = await nick.page.inputValue('.rl-invite');
  assert.match(invite, /#r=[a-z2-9]{12}$/);
  assert.ok(!invite.includes('&k='), 'the invite link carries no host key');
  await join(robin, invite, 'Join room');
  await until(nick, () => document.querySelectorAll('.rl-person').length === 2);
  await until(robin, () => document.querySelectorAll('.rl-person').length === 2);
  assert.equal(await row(robin, 'Nick').locator('.rl-tag-host').count(), 1, 'Robin sees Nick as host');
  assert.equal(await nick.page.locator('.rl-host-tools').isVisible(), true);
  assert.equal(await robin.page.locator('.rl-host-tools').isVisible(), false);

  step('the direct connection comes up before anyone unmutes (the data channel)');
  await until(robin, () => [...document.querySelectorAll('.rl-conn')].length === 0, undefined, 15000);
  assert.equal(await room(nick, () => window.__roomsLab.room.micTrack), null, 'mic off on joining');

  step('both unmute: each hears the other, and sees them talking');
  await nick.page.click('.rl-mic');
  await robin.page.click('.rl-mic');
  await until(nick, () => document.querySelector('.rl-mic').getAttribute('aria-pressed') === 'true');
  assert.ok(await hears(robin, 'Nick'), 'Robin receives Nick\'s voice');
  assert.ok(await hears(nick, 'Robin'), 'Nick receives Robin\'s voice');
  await until(robin, () => [...document.querySelectorAll('.rl-person')].some((li) => li.textContent.includes('Nick') && li.querySelector('.rl-talking')), undefined, 10000);

  step('mute: Nick\'s track switches off (nothing sent while muted)');
  await nick.page.click('.rl-mic');
  assert.equal(await room(nick, () => window.__roomsLab.room.micTrack.enabled), false);
  await nick.page.click('.rl-mic');
  assert.equal(await room(nick, () => window.__roomsLab.room.micTrack.enabled), true);

  step('Robin asks to see Nick\'s screen: Nick gets the prompt and nothing is shared until Nick clicks');
  await row(robin, 'Nick').locator('.rl-ask').click();
  await until(nick, () => !document.querySelector('.rl-prompt').hidden);
  const q = await nick.page.locator('.rl-prompt-q').textContent();
  assert.equal(q, 'Robin asks to see your screen. Share with 1 person?');
  assert.match(await nick.page.locator('.rl-prompt').textContent(), /one window or tab/);
  await nick.page.waitForTimeout(1500);
  assert.equal(await room(nick, () => window.__roomsLab.room.screenTrack), null, 'no share without the person\'s click');
  assert.equal(await room(robin, () => window.__roomsLab.room.presenter), null);

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
  for (const p of [robin, ted]) await until(p, () => document.querySelector('.rl-video').hidden && /Nobody is sharing/.test(document.querySelector('.rl-caption').textContent));
  assert.equal(await room(nick, () => window.__roomsLab.room.screenTrack), null);

  step('Nick asks Robin; Robin says "Not now"; Nick hears so, and nothing is shared');
  await row(nick, 'Robin').locator('.rl-ask').click();
  await until(robin, () => !document.querySelector('.rl-prompt').hidden);
  assert.equal(await robin.page.locator('.rl-prompt-q').textContent(), 'Nick asks to see your screen. Share with 2 people?');
  await robin.page.click('button:has-text("Not now")');
  await waitStatus(nick, /Robin said not now/);
  assert.equal(await room(robin, () => window.__roomsLab.room.screenTrack), null);

  step('Ted shares on his own (Share my screen); then Robin can\'t start a second share');
  await ted.page.click('.rl-share');
  await stageShows(robin);
  assert.equal(await robin.page.locator('.rl-caption').textContent(), 'Ted’s screen');
  assert.equal(await robin.page.locator('.rl-share').isDisabled(), true);
  assert.equal(await row(robin, 'Nick').locator('.rl-ask').isDisabled(), true, 'no asking while someone presents');
  await ted.page.click('.rl-share');
  await until(robin, () => document.querySelector('.rl-video').hidden);

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

  step('Robin and Ted press Share at the same moment: one keeps the stage, the other\'s share stops, all pages agree');
  await Promise.all([robin.page.click('.rl-share'), ted.page.click('.rl-share')]);
  await nick.page.waitForTimeout(2500);
  const who = await Promise.all([nick, robin, ted].map((p) => room(p, () => window.__roomsLab.room.presenter)));
  assert.ok(who[0] && who.every((x) => x === who[0]), `everyone agrees on the presenter (${who})`);
  const sharing = await Promise.all([robin, ted].map((p) => room(p, () => !!window.__roomsLab.room.screenTrack)));
  assert.equal(sharing.filter(Boolean).length, 1, 'exactly one screen is shared');
  const winner = sharing[0] ? robin : ted;
  await stageShows(nick);
  await winner.page.click('.rl-share');
  await until(nick, () => document.querySelector('.rl-video').hidden);

  step('at phone width the page has no sideways scroll');
  await robin.page.setViewportSize({ width: 375, height: 760 });
  assert.equal(await robin.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await robin.page.setViewportSize({ width: 1280, height: 720 });

  step('Nick\'s page goes away: Robin and Ted stay and see "Waiting for Nick…"; Nick comes back as host');
  await nick.page.goto('about:blank');
  for (const p of [robin, ted]) {
    await waitStatus(p, /Waiting for Nick to come back/);
    await until(p, () => [...document.querySelectorAll('.rl-person')].some((li) => li.textContent.includes('Nick') && li.textContent.includes('away')));
  }
  await nick.page.goBack();
  await nick.page.waitForSelector('button:has-text("Rejoin as host")');
  await nick.page.click('button:has-text("Rejoin as host")');
  await waitStatus(nick, /You're the host/);
  await waitStatus(robin, /The host is back/);
  await until(robin, () => document.querySelectorAll('.rl-person').length === 3 && ![...document.querySelectorAll('.rl-person')].some((li) => li.textContent.includes('away')));
  await nick.page.click('.rl-mic');
  assert.ok(await (async () => { for (let i = 0; i < 10; i++) { if (await hears(robin, 'Nick')) return true; } return false; })(), 'Nick\'s voice is back for Robin');

  step('Nick removes Ted: Ted is told; the others see two people');
  await row(nick, 'Ted').locator('.rl-remove').click();
  await waitStatus(ted, /The host took you out of the room/);
  await until(robin, () => document.querySelectorAll('.rl-person').length === 2);

  step('Nick ends the room: Robin is told it ended');
  await nick.page.click('button:has-text("End room")');
  await waitStatus(robin, /The host ended the room/);
  await waitStatus(nick, /The host ended the room/);

  step('names are shown as typed, never as markup');
  const sneaky = await person('<b>Bold</b>');
  await join(sneaky, PAGE, 'New room');
  assert.equal(await sneaky.page.locator('.rl-who').first().textContent(), '<b>Bold</b>');
  assert.equal(await sneaky.page.locator('.rl-who b').count(), 0);

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
