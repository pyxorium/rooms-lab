// check_signin.mjs: optional sign-in on the Rooms lab page (build step 8; claude/rooms-signin-plan.md), in Chromium.
//
// The real relay (relay/server.js) and the lab's dev page, with:
//   - the relay's real sign-in check (relay/signin.js: createPassChecker around Bluesky's verifyJwt, then the
//     handle both ways), its account keys and handle lookups answered by stand-ins;
//   - each page's sign-in library a stand-in (signin-standin.js) that keeps sessions in the library's own
//     IndexedDB store, as the real one does; the accounts' server (https://pds.standin.test) answered here in
//     Node, signing real passes with Bluesky's code (createServiceJwt and real keys) and refusing any other
//     audience or method, as a real server does when the permission wasn't granted.
// Each person is a separate browser profile (own storage), like separate computers.
//
//   the lobby (the approved mockup): two panels; "You'll appear in the room as …" updates as you type; a typed
//   name starting with "@" is refused there; sign in → the Signed in panel; the honest line.
//   Nick signs in and makes a room: everyone sees "@nick.test ✓" (host); Robin types her name: "Robin
//   (unverified)". No page ever receives an account's DID. The house is told verified yes/no only.
//   A relay drop: the page rejoins with a fresh pass (each works once) and stays verified.
//   Nick on another device (Ted's profile), signed in as Nick, without the host key: he's the host there; the
//   first page says "You joined this room from another tab or device." with "Join here instead".
//   An account whose handle doesn't lead back: "Your handle couldn't be confirmed…", "Try again"; then signed
//   out, typing a name works.
//   The clash: an account signed in to Daisy in this browser gets "This replaces @robin.test's Daisy sign-in in
//   this browser. Daisy will need you to sign in again before it can save or use the lounge." before any window
//   opens; Continue again signs in (Daisy's sign-in is replaced, as for real). A handle that can't be looked up:
//   the "may" line. No clash: no line.
//   Kept: a reload stays signed in (no window); Sign out goes back to the two panels. Sign out after Seven-Up
//   signed in later as the same account leaves Seven-Up's sign-in alone (only a Rooms sign-in is cancelled).
//   A page without the sign-in library: just the name, as before step 8.
//
// Needs Playwright with Chromium and Bluesky's code: relay\'s npm install (@atproto/crypto, @atproto/xrpc-server),
// or ROOMS_ATPROTO_BUNDLE naming a bundle of the same code (the build chat's sandbox).
//   node test/browser/check_signin.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startDev } from '../../dev/serve.mjs';
import { createPassChecker, createSignInCheck, AUDIENCE, JOIN_LXM } from '../../relay/signin.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = await import('playwright')); }

async function loadAtproto() {
  if (process.env.ROOMS_ATPROTO_BUNDLE) return import(process.env.ROOMS_ATPROTO_BUNDLE);
  const relayRequire = createRequire(new URL('../../relay/package.json', import.meta.url));
  const crypto = await import(relayRequire.resolve('@atproto/crypto'));
  const { verifyJwt, createServiceJwt } = await import(relayRequire.resolve('@atproto/xrpc-server'));
  return { crypto, verifyJwt, createServiceJwt };
}
const atp = await loadAtproto();
const step = (s) => console.log(`- ${s}`);

// ---- Accounts ----
const ACCOUNTS = {
  'nick.test': 'did:plc:nicknicknicknicknicknick',
  'robin.test': 'did:plc:robinrobinrobinrobinrobi',
  'liar.test': 'did:plc:liarliarliarliarliarliar',      // its handle leads to someone else
  'webby.test': 'did:web:webby.test',                   // a did:web account: refused (did:plc only)
};
const keys = {};
for (const did of Object.values(ACCOUNTS)) keys[did] = await atp.crypto.Secp256k1Keypair.create();
const handleOfDid = Object.fromEntries(Object.entries(ACCOUNTS).map(([h, d]) => [d, h]));
const passesSigned = [];
const relayChecks = [];
const webLookups = [];
const checkPass = createPassChecker({ verifyJwt: atp.verifyJwt, getSigningKey: async (did) => { if (did.startsWith('did:web:')) webLookups.push(did); if (!keys[did]) throw new Error('unknown'); return keys[did].did(); } });
const realCheck = createSignInCheck({
  checkPass,
  handleOf: async (did) => handleOfDid[did] || null,
  didOfHandle: async (h) => (h === 'liar.test' ? ACCOUNTS['robin.test'] : ACCOUNTS[h] || null),
});
const signIn = async (pass) => { relayChecks.push(pass); return realCheck(pass); };

const dev = await startDev({ port: 0, relayPort: 0, quiet: true, signIn, signInLib: null, tileHost: null });
const PAGE = `${dev.url}?relay=${encodeURIComponent(dev.relayUrl)}`;
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const STANDIN = readFileSync(new URL('./signin-standin.js', import.meta.url), 'utf8');
const errors = [];
const DATA_JS = '/.well-known/web-tiles/data.js';
const CORS = { 'access-control-allow-origin': '*' };
// Step 9: the handle suggestions' service (typeahead.waow.tech, as Raku's) and Bluesky's picture server.
const suggestQueries = [];
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

async function person(name, { lib = true } = {}) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  if (lib) {
    await ctx.addInitScript(`window.__standinAccounts = ${JSON.stringify(ACCOUNTS)};`);
    await ctx.addInitScript(STANDIN);
  }
  const json = (route, body, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  // The accounts' server: real passes, signed with the account's key, only for this relay and this method.
  await ctx.route('https://pds.standin.test/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname !== '/xrpc/com.atproto.server.getServiceAuth') return json(route, { error: 'MethodNotImplemented' }, 501);
    const did = u.searchParams.get('standin_did');
    const aud = u.searchParams.get('aud'), lxm = u.searchParams.get('lxm'), exp = Number(u.searchParams.get('exp'));
    if (aud !== AUDIENCE || lxm !== JOIN_LXM) return json(route, { error: 'ScopeMissingError', message: 'Missing required scope' }, 403);
    const token = await atp.createServiceJwt({ iss: did, aud, lxm, exp, keypair: keys[did] });
    passesSigned.push({ did, token });
    return json(route, { token });
  });
  await ctx.route('https://typeahead.waow.tech/**', (route) => {
    const u = new URL(route.request().url());
    const q = u.searchParams.get('q') || '';
    suggestQueries.push({ who: name, q, client: route.request().headers()['x-client'] });
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-headers': 'x-client' } });
    const actors = Object.keys(ACCOUNTS).filter((h) => h.startsWith(q.toLowerCase()))
      .map((handle) => ({ handle, displayName: handle === 'robin.test' ? '<b>Robin</b>' : '', avatar: `https://cdn.bsky.app/img/avatar/plain/${handle}.png` }));
    return route.fulfill({ status: 200, headers: { ...CORS, 'access-control-allow-headers': 'x-client', 'content-type': 'application/json' }, body: JSON.stringify({ actors }) });
  });
  await ctx.route('https://cdn.bsky.app/**', (route) => route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'image/png' }, body: PNG }));
  // The handle lookup the page uses before the sign-in window (the clash check).
  await ctx.route('https://bsky.social/xrpc/com.atproto.identity.resolveHandle**', (route) => {
    const h = new URL(route.request().url()).searchParams.get('handle');
    if (h === 'offline.test') return route.fulfill({ status: 502, headers: CORS, body: '' });
    return ACCOUNTS[h] ? json(route, { did: ACCOUNTS[h] }) : json(route, { error: 'InvalidRequest', message: 'Unable to resolve handle' }, 400);
  });
  const page = await ctx.newPage();
  const frames = [];
  page.on('websocket', (ws) => ws.on('framereceived', (f) => frames.push(String(f.payload))));
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (t.includes(DATA_JS) || (m.location()?.url || '').includes(DATA_JS) || /ERR_FAILED|CORS policy/.test(t)) return;
    if (/Failed to load resource: the server responded with a status of (400|502)/.test(t)) return;   // the handle lookups that fail on purpose
    errors.push(`${name} console: ${t}`);
  });
  return { name, ctx, page, frames };
}
const until = (p, fn, arg, ms = 15000) => p.page.waitForFunction(fn, arg, { timeout: ms, polling: 100 });
const text = (p, sel) => p.page.locator(sel).first().textContent();
const waitStatus = (p, re, ms) => until(p, (src) => new RegExp(src).test(document.querySelector('.rl-status')?.textContent || ''), re.source, ms);
const whoTexts = (p) => p.page.evaluate(() => [...document.querySelectorAll('.rl-person .rl-who')].map((e) => e.textContent).sort());
const log = (p) => p.page.evaluate(() => window.__standinLog || []);

async function signInAs(p, handle, { expectClash = null } = {}) {
  await p.page.click('button.rl-signin');
  await p.page.fill('.rl-handle', handle);
  await p.page.waitForTimeout(1000);                                  // the clash look-up once typing pauses
  await p.page.click('button.rl-continue');
  if (expectClash) {
    await until(p, () => !!document.querySelector('.rl-clash')?.textContent);
    assert.equal(await text(p, '.rl-clash'), expectClash);
    assert.equal(await p.page.locator('[data-signed-in]').count(), 0, 'not signed in yet');
    await p.page.click('button.rl-continue');
  }
  await p.page.waitForSelector('[data-signed-in]', { timeout: 8000 });
}

try {
  step('the lobby: two panels (sign in, or type a name), "You\'ll appear in the room as" follows the typing, the honest line');
  const nick = await person('Nick');
  await nick.page.goto(PAGE);
  await nick.page.waitForSelector('button.rl-signin');
  assert.equal(await text(nick, 'button.rl-signin'), 'Sign in with your account');
  assert.equal(await text(nick, '.rl-way-signin .rl-help'), 'Your handle will appear in the room as verified. Optional.');
  assert.equal(await text(nick, '.rl-way-name h3'), 'Or type a name');
  await nick.page.fill('.rl-name', 'Nicky');
  assert.equal(await text(nick, '.rl-appear-label'), 'You’ll appear in the room as');
  assert.equal(await text(nick, '.rl-appear-who'), 'Nicky (unverified)');
  await nick.page.fill('.rl-name', '@alice.bsky.social');
  assert.equal(await text(nick, '.rl-appear-as .rl-problem'), 'A typed name can’t start with “@”. Sign in to show a handle.');
  assert.equal(await nick.page.locator('button:has-text("New room")').isDisabled(), true, 'can\'t join as "@…"');
  assert.match(await text(nick, '.rl-honest'), /✓ means the handle was checked through sign-in; other names are typed\./);
  assert.deepEqual((await log(nick)).find((l) => l[0] === 'load').slice(1, 3),
    [`http://localhost?redirect_uri=${encodeURIComponent(`${new URL(dev.url).origin}/`)}&scope=${encodeURIComponent('atproto include:cafe.thunderbird.rooms.authJoin?aud=did:web:relay.rooms.thunderbird.cafe%23rooms_relay')}`, 'https://bsky.social'],
    'a loopback sign-in on this computer, asking for the Rooms set only');

  step('pressing "Sign in with your account": the handle box with Continue and Cancel; the name panel steps aside; Cancel brings it back');
  await nick.page.click('button.rl-signin');
  assert.equal(await nick.page.locator('.rl-handle').isVisible(), true);
  assert.equal(await nick.page.locator('.rl-way-name').isVisible(), false);
  await nick.page.click('button.rl-cancel');
  assert.equal(await nick.page.locator('.rl-way-name').isVisible(), true);

  step('step 9: handle suggestions in the sign-in box (pick with the mouse or the keyboard), names shown as text; none in the typed-name box');
  await nick.page.click('button.rl-signin');
  await nick.page.locator('.rl-handle').pressSequentially('ro', { delay: 30 });
  await nick.page.waitForSelector('.rl-ta-list:not([hidden]) .rl-ta-item');
  assert.deepEqual(await nick.page.evaluate(() => [...document.querySelectorAll('.rl-ta-handle')].map((e) => e.textContent)), ['@robin.test']);
  assert.equal(await text(nick, '.rl-ta-name'), '<b>Robin</b>', 'a display name is text, never markup');
  assert.equal(await nick.page.locator('.rl-ta-name b').count(), 0);
  assert.match(await nick.page.locator('.rl-ta-pic img').getAttribute('src'), /^https:\/\/cdn\.bsky\.app\//);
  assert.equal(await nick.page.locator('.rl-handle').getAttribute('aria-expanded'), 'true');
  await nick.page.locator('.rl-ta-item').first().click();
  assert.equal(await nick.page.inputValue('.rl-handle'), 'robin.test');
  assert.equal(await nick.page.locator('.rl-ta-list').isHidden(), true);
  await nick.page.fill('.rl-handle', '');
  await nick.page.locator('.rl-handle').pressSequentially('ni', { delay: 30 });
  await nick.page.waitForSelector('.rl-ta-list:not([hidden]) .rl-ta-item');
  await nick.page.keyboard.press('ArrowDown');
  await nick.page.keyboard.press('Enter');
  assert.equal(await nick.page.inputValue('.rl-handle'), 'nick.test');
  assert.equal(await nick.page.locator('[data-signed-in]').count(), 0, 'choosing a suggestion doesn\'t sign in by itself');
  assert.ok(suggestQueries.every((x) => x.client === 'thunderbird.cafe'), 'the client label');
  await nick.page.click('button.rl-cancel');
  const before = suggestQueries.length;
  await nick.page.fill('.rl-name', '');
  await nick.page.locator('.rl-name').pressSequentially('ro', { delay: 30 });
  await nick.page.waitForTimeout(500);
  assert.equal(suggestQueries.length, before, 'the typed-name box asks nobody');
  assert.equal(await nick.page.locator('.rl-way-name .rl-ta-list').count(), 0);
  assert.equal(await nick.page.locator('.rl-name').getAttribute('role'), null);
  await nick.page.fill('.rl-name', '');

  step('Nick signs in: one "Signed in" panel ("as @nick.test · Sign out"), and he\'ll appear as "@nick.test ✓"; no clash line for an account with no other sign-in here');
  await signInAs(nick, 'Nick.Test');
  assert.equal(await nick.page.locator('.rl-clash').count(), 0, 'the panel moved on');
  assert.equal(await text(nick, '[data-signed-in] h3'), 'Signed in');
  assert.equal((await text(nick, '.rl-signed-as')).trim(), 'as @nick.test · Sign out');
  assert.equal(await text(nick, '.rl-appear-who'), '@nick.test ✓');
  assert.equal(await nick.page.locator('.rl-name').count(), 0, 'no typed-name box while signed in');
  assert.ok((await log(nick)).some((l) => l[0] === 'signInPopup' && l[1] === 'nick.test' && l[2] === 'atproto include:cafe.thunderbird.rooms.authJoin?aud=did:web:relay.rooms.thunderbird.cafe%23rooms_relay'));

  step('Nick makes a room: he\'s "@nick.test ✓" and the host; the relay checked a real pass from his server');
  await nick.page.click('button:has-text("New room")');
  await until(nick, () => window.__roomsLab.room?.link.joined === true);
  assert.deepEqual(await whoTexts(nick), ['@nick.test ✓']);
  assert.equal(passesSigned.length, 1);
  assert.equal(relayChecks[0], passesSigned[0].token);
  const invite = await nick.page.inputValue('.rl-invite');

  step('Robin (no sign-in) types her name: "Robin (unverified)"; both pages agree; the house hears verified yes/no only');
  const robin = await person('Robin');
  await robin.page.goto(invite);
  await robin.page.fill('.rl-name', 'Robin');
  assert.equal(await text(robin, '.rl-appear-who'), 'Robin (unverified)');
  await robin.page.click('button:has-text("Join room")');
  await until(robin, () => document.querySelectorAll('.rl-person').length === 2);
  await until(nick, () => document.querySelectorAll('.rl-person').length === 2);
  assert.deepEqual(await whoTexts(robin), ['@nick.test ✓', 'Robin (unverified)']);
  assert.deepEqual(await whoTexts(nick), ['@nick.test ✓', 'Robin (unverified)']);
  const hs = await nick.page.evaluate(() => window.__roomsLab.houseState);
  assert.deepEqual(hs.peers.map((p) => [p.name, p.verified, Object.keys(p).sort().join(',')]).sort(),
    [['Robin', false, 'host,name,peer,verified'], ['nick.test', true, 'host,name,peer,verified']]);
  assert.match(await robin.page.locator('.rl-person', { hasText: 'nick.test' }).locator('.rl-check').getAttribute('title'), /checked through sign-in/);

  step('a relay drop: Nick\'s page rejoins with a fresh pass (each works once) and is still "@nick.test ✓", still the host');
  await nick.page.evaluate(() => window.__roomsLab.room.link.blip());
  for (let i = 0; i < 100 && passesSigned.length < 2; i++) await nick.page.waitForTimeout(100);   // (keeps the stand-in server answering)
  await until(nick, () => window.__roomsLab.room.link.joined === true && document.querySelectorAll('.rl-person').length === 2, undefined, 15000);
  assert.equal(passesSigned.length, 2, 'a second pass for the rejoin');
  assert.notEqual(passesSigned[1].token, passesSigned[0].token);
  assert.equal(await nick.page.evaluate(() => window.__roomsLab.room.host), true);
  assert.deepEqual(await whoTexts(robin), ['@nick.test ✓', 'Robin (unverified)']);

  step('Nick on another device (Ted\'s computer), signed in as Nick, no host key: he\'s the host there; the first page is told and offers "Join here instead"');
  const other = await person('Nick elsewhere');
  await other.page.goto(invite);
  await other.page.waitForSelector('button.rl-signin');
  await signInAs(other, 'nick.test');
  await other.page.click('button:has-text("Join room")');
  await until(other, () => window.__roomsLab.room?.link.joined === true);
  assert.equal(await other.page.evaluate(() => window.__roomsLab.room.host), true, 'the host by account');
  await waitStatus(nick, /You joined this room from another tab or device\./);
  assert.equal(await nick.page.locator('button.rl-again').textContent(), 'Join here instead');
  await until(robin, () => document.querySelectorAll('.rl-person').length === 2);
  assert.deepEqual(await whoTexts(robin), ['@nick.test ✓', 'Robin (unverified)'], 'one @nick.test in the list');

  step('an account whose handle doesn\'t lead back: refused with a reason and "Try again"; signed out, typing a name works');
  const dee = await person('Dee');
  await dee.page.goto(invite);
  await dee.page.waitForSelector('button.rl-signin');
  await signInAs(dee, 'liar.test');
  await dee.page.click('button:has-text("Join room")');
  await waitStatus(dee, /Your handle couldn’t be confirmed/);
  assert.equal(await dee.page.locator('button.rl-again').textContent(), 'Try again');
  await dee.page.click('button.rl-again');
  await dee.page.click('button.rl-signout');
  await dee.page.waitForSelector('button.rl-signin');
  await dee.page.fill('.rl-name', 'Dee');
  await dee.page.click('button:has-text("Join room")');
  await until(robin, () => document.querySelectorAll('.rl-person').length === 3);
  assert.deepEqual(await whoTexts(robin), ['@nick.test ✓', 'Dee (unverified)', 'Robin (unverified)']);

  step('a did:web account: the relay refuses it before looking anything up, and the page says so (did:plc only)');
  const checksBefore = relayChecks.length;
  const webby = await person('Webby');
  await webby.page.goto(invite);
  await webby.page.waitForSelector('button.rl-signin');
  await signInAs(webby, 'webby.test');
  await webby.page.click('button:has-text("Join room")');
  await waitStatus(webby, /Sign-in here works with most accounts, but not this kind yet\. Type a name to join\./);
  assert.equal(await webby.page.locator('button.rl-again').textContent(), 'Try again');
  assert.equal(relayChecks.length, checksBefore + 1);
  assert.deepEqual(webLookups, [], 'no key or DID document looked up for did:web');

  step('the clash: Robin\'s account is signed in to Daisy in this browser → the warning before any window; Continue again signs in, and Daisy\'s sign-in is gone (as with the real library)');
  const ann = await person('Ann');
  await ann.page.goto(PAGE);
  await ann.page.waitForSelector('button.rl-signin');
  await ann.page.evaluate((did) => window.__standinPutSession(did, 'atproto include:cafe.thunderbird.daisy.authPlay'), ACCOUNTS['robin.test']);
  const popupsBefore = ann.ctx.pages().length;
  await signInAs(ann, 'robin.test', { expectClash: 'This replaces @robin.test\u2019s Daisy sign-in in this browser. Daisy will need you to sign in again before it can save or use the lounge.' });
  assert.match(await ann.page.evaluate((did) => window.__standinScopeOf(did), ACCOUNTS['robin.test']), /cafe\.thunderbird\.rooms\.join/);
  assert.ok(ann.ctx.pages().length <= popupsBefore + 1);

  step('Sign out after Seven-Up signed in later as the same account: Rooms forgets the account, Seven-Up\'s sign-in stays');
  await ann.page.evaluate((did) => window.__standinPutSession(did, 'atproto repo:cafe.thunderbird.sevenup.match'), ACCOUNTS['robin.test']);
  await ann.page.click('button.rl-signout');
  await ann.page.waitForSelector('button.rl-signin');
  assert.equal(await ann.page.evaluate((did) => window.__standinScopeOf(did), ACCOUNTS['robin.test']), 'atproto repo:cafe.thunderbird.sevenup.match', 'Seven-Up\'s sign-in untouched');
  assert.ok(!(await log(ann)).some((l) => l[0] === 'revoke'), 'nothing cancelled');

  step('a handle that can\'t be looked up right now: the "may" line; a handle with no other sign-in: no line');
  await ann.page.click('button.rl-signin');
  await ann.page.fill('.rl-handle', 'offline.test');
  await ann.page.waitForTimeout(600);
  await ann.page.click('button.rl-continue');
  await until(ann, () => !!document.querySelector('.rl-clash')?.textContent);
  assert.equal(await text(ann, '.rl-clash'), 'Signing in here may replace this account\u2019s Daisy or Seven-Up sign-in in this browser. They\u2019d need you to sign in again before saving.');
  await ann.page.fill('.rl-handle', 'nick.test');
  assert.equal(await text(ann, '.rl-clash'), '', 'typing again clears it');

  step('kept: a reload stays signed in without a window; Sign out goes back to the two panels');
  await other.page.reload();
  await other.page.waitForSelector('[data-signed-in]');
  assert.equal((await text(other, '.rl-signed-as')).trim(), 'as @nick.test · Sign out');
  assert.ok((await log(other)).some((l) => l[0] === 'restore'), 'restored quietly');
  await other.page.click('button.rl-signout');
  await other.page.waitForSelector('button.rl-signin');
  assert.equal(await other.page.locator('.rl-name').count(), 1);
  assert.ok((await log(other)).some((l) => l[0] === 'revoke'), 'its own (Rooms) sign-in is cancelled');
  assert.equal(await other.page.evaluate((did) => window.__standinScopeOf(did), ACCOUNTS['nick.test']), null);

  step('no page ever received an account\'s DID from the relay');
  for (const p of [nick, robin, other, dee]) for (const f of p.frames) for (const did of Object.values(ACCOUNTS)) assert.ok(!f.includes(did), `${p.name} got a DID`);
  for (const p of [nick, robin, other, dee]) for (const f of p.frames) assert.ok(!/"pass"/.test(f), 'no pass echoed back');

  step('a page without the sign-in library: just the name, as before step 8');
  const plain = await person('Plain', { lib: false });
  await plain.page.goto(PAGE);
  await plain.page.waitForSelector('.rl-name');
  assert.equal(await plain.page.locator('button.rl-signin').count(), 0);
  assert.equal(await plain.page.locator('.rl-way-name h3').count(), 0);
  await plain.page.fill('.rl-name', 'Pat');
  assert.equal(await text(plain, '.rl-appear-who'), 'Pat (unverified)');

  step('phone width: the lobby has no sideways scroll');
  await ann.page.setViewportSize({ width: 360, height: 760 });
  assert.equal(await ann.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nAll sign-in checks passed.');
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  await dev.close();
}
