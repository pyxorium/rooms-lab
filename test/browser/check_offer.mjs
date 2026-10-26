// check_offer.mjs: the new-tile offer (0.10.0; claude/rooms-new-tile-offer-plan.md), in Chromium.
//
// The real relay with its real sign-in check (as check_signin.mjs: passes signed with Bluesky's code by a stand-in
// account server), the lab's dev page, the sign-in library stand-in, and one stand-in server for the accounts'
// tiles (plc.directory, listRecords, getRecord, getBlob), where the check "publishes" tiles while people are in
// the room. Each person is a separate browser profile.
//
//   Nick (signed in) makes a room; Robin (signed in) and Ted (typed name) join. The tile box's new help line.
//   Robin publishes "Twilight Sprite" while the room's tab is hidden; coming back: "Twilight Sprite is now saved
//   in your account." on her page only. Nobody else's page asked about her account; Ted's page asks nothing.
//   Preview it: the same private preview as pasting the address (a dashed card, "Only you can see this", "Ask to
//   open for everyone"); the offer goes; asking reaches Nick.
//   Several: "Glass d12 and +1 more are now saved in your account."; "+1 more" lists Beach Sprite with its own
//   Preview it; Not now drops them, a return doesn't bring them back; a newer tile is offered alone.
//   The slow check (shortened to 1.5 s here): a tile published with the tab visible is offered without a return;
//   while an offer waits no more looks; while hidden none at all.
//   A tile already open for everyone isn't offered. Nick's tile from before joining is never offered; his new one
//   is, and his preview says "Open for everyone". Phone width: no sideways scroll, the offer wraps.
//
// Needs Playwright with Chromium and Bluesky's code (relay\'s npm install, or ROOMS_ATPROTO_BUNDLE).
//   node test/browser/check_offer.mjs
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { startDev } from '../../dev/serve.mjs';
import { createPassChecker, createSignInCheck, AUDIENCE, JOIN_LXM } from '../../relay/signin.js';
import { rawCid } from '../../scripts/lib/cid.js';
import { HIDE_LIST_URL } from '../../src/hide-check.js';
import { TILE_HELP } from '../../src/room-page.js';

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

// ---- Accounts and their tiles ----
const ACCOUNTS = { 'nick.test': 'did:plc:nicknicknicknicknicknick', 'robin.test': 'did:plc:robinrobinrobinrobinrobi' };
const NICK = ACCOUNTS['nick.test'], ROBIN = ACCOUNTS['robin.test'];
const keys = {};
for (const did of Object.values(ACCOUNTS)) keys[did] = await atp.crypto.Secp256k1Keypair.create();
const handleOfDid = Object.fromEntries(Object.entries(ACCOUNTS).map(([h, d]) => [d, h]));
const checkPass = createPassChecker({ verifyJwt: atp.verifyJwt, getSigningKey: async (did) => keys[did].did() });
const signIn = createSignInCheck({ checkPass, handleOf: async (did) => handleOfDid[did] || null, didOfHandle: async (h) => ACCOUNTS[h] || null });

const S32 = '234567abcdefghijklmnopqrstuvwxyz';
function tid(ms) {
  let v = (BigInt(Math.round(ms * 1000)) << 10n) | BigInt(Math.floor(Math.random() * 1024));
  let out = '';
  for (let i = 0; i < 13; i++) { out = S32[Number(v & 31n)] + out; v >>= 5n; }
  return out;
}
const PDS = 'https://pds.standin.test';
const published = { [NICK]: [], [ROBIN]: [] };   // newest last
let cidN = 0;
async function publish(did, name, at = Date.now()) {
  const bytes = new TextEncoder().encode(`<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;margin:12px"><p>${name}</p>`);
  const t = { rkey: tid(at), name, bytes, blobCid: await rawCid(bytes), cid: `bafyrei${'abcdefghijklmnopqrstuvwxyz'[cidN++ % 26].repeat(52)}`, at };
  published[did].push(t);
  return `at://${did}/ing.dasl.masl/${t.rkey}`;
}
const listAsks = [];      // { who, repo }

const dev = await startDev({ port: 0, relayPort: 0, quiet: true, signIn, signInLib: null });
const PAGE = `${dev.url}?relay=${encodeURIComponent(dev.relayUrl)}`;
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const STANDIN = readFileSync(new URL('./signin-standin.js', import.meta.url), 'utf8');
const errors = [];
const DATA_JS = '/.well-known/web-tiles/data.js';
const CORS = { 'access-control-allow-origin': '*' };
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

async function person(name, { pollMs = 1500 } = {}) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  await ctx.addInitScript(`window.__standinAccounts = ${JSON.stringify(ACCOUNTS)}; window.__roomsLabTimes = { newTilePollMs: ${pollMs} };`);
  await ctx.addInitScript(STANDIN);
  await ctx.addInitScript(STANDIN_TILE_HOST);
  // A controllable "is the room's tab visible?" (Playwright pages are always visible).
  await ctx.addInitScript(() => {
    let state = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => state, configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => state === 'hidden', configurable: true });
    window.__setVisible = (on) => { state = on ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')); };
  });
  const json = (route, body, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await ctx.route('https://plc.directory/**', (route) => {
    const did = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    return json(route, { id: did, alsoKnownAs: handleOfDid[did] ? [`at://${handleOfDid[did]}`] : [], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }] });
  });
  await ctx.route(`${PDS}/**`, async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/xrpc/com.atproto.server.getServiceAuth') {
      const did = u.searchParams.get('standin_did');
      const aud = u.searchParams.get('aud'), lxm = u.searchParams.get('lxm'), exp = Number(u.searchParams.get('exp'));
      if (aud !== AUDIENCE || lxm !== JOIN_LXM) return json(route, { error: 'ScopeMissingError' }, 403);
      return json(route, { token: await atp.createServiceJwt({ iss: did, aud, lxm, exp, keypair: keys[did] }) });
    }
    if (u.pathname === '/xrpc/com.atproto.repo.listRecords') {
      const repo = u.searchParams.get('repo');
      listAsks.push({ who: name, repo, collection: u.searchParams.get('collection') });
      const recs = [...(published[repo] || [])].reverse().slice(0, Number(u.searchParams.get('limit')) || 50)
        .map((t) => ({ uri: `at://${repo}/ing.dasl.masl/${t.rkey}`, cid: t.cid, value: { $type: 'ing.dasl.masl', tile: { name: t.name }, createdAt: new Date(t.at).toISOString() } }));
      return json(route, { records: recs });
    }
    if (u.pathname === '/xrpc/com.atproto.repo.getRecord') {
      const repo = u.searchParams.get('repo'), rkey = u.searchParams.get('rkey');
      const t = (published[repo] || []).find((x) => x.rkey === rkey);
      if (!t) return json(route, { error: 'RecordNotFound' }, 400);
      const manifest = { name: t.name, sizing: { width: 400, height: 160 }, resources: { '/': { src: { $type: 'blob', ref: { $link: t.blobCid }, mimeType: 'text/html', size: t.bytes.length }, 'content-type': 'text/html' } } };
      return json(route, { uri: `at://${repo}/ing.dasl.masl/${rkey}`, cid: t.cid, value: { $type: 'ing.dasl.masl', cid: t.cid, tile: manifest, createdAt: new Date(t.at).toISOString() } });
    }
    if (u.pathname === '/xrpc/com.atproto.sync.getBlob') {
      const t = Object.values(published).flat().find((x) => x.blobCid === u.searchParams.get('cid'));
      return t ? route.fulfill({ status: 200, headers: { ...CORS, 'content-type': '*/*' }, body: Buffer.from(t.bytes) }) : route.fulfill({ status: 404, headers: CORS, body: '' });
    }
    return json(route, { error: 'MethodNotImplemented' }, 501);
  });
  await ctx.route(HIDE_LIST_URL, (route) => json(route, { version: 1, salt: 'lexicographer.space hide list v1', accounts: [], tiles: [] }));
  await ctx.route('https://public.api.bsky.app/**', (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/xrpc/com.atproto.identity.resolveHandle') return json(route, { did: ACCOUNTS[u.searchParams.get('handle')] || 'did:plc:nobodynobodynobodynobody' });
    return json(route, { did: u.searchParams.get('actor'), labels: [] });
  });
  await ctx.route('https://bsky.social/xrpc/com.atproto.identity.resolveHandle**', (route) => {
    const h = new URL(route.request().url()).searchParams.get('handle');
    return ACCOUNTS[h] ? json(route, { did: ACCOUNTS[h] }) : json(route, { error: 'InvalidRequest' }, 400);
  });
  await ctx.route('https://typeahead.waow.tech/**', (route) => json(route, { actors: [] }));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (t.includes(DATA_JS) || (m.location()?.url || '').includes(DATA_JS) || /ERR_FAILED|CORS policy/.test(t)) return;
    if (/Failed to load resource: the server responded with a status of (400|404)/.test(t)) return;
    errors.push(`${name} console: ${t}`);
  });
  return { name, ctx, page };
}
const until = (p, fn, arg, ms = 15000) => p.page.waitForFunction(fn, arg, { timeout: ms, polling: 100 });
const text = (p, sel) => p.page.locator(sel).first().textContent();
const offerShown = (p) => p.page.evaluate(() => { const o = document.querySelector('.rl-offer'); return !!o && !o.hidden; });
const offerText = (p) => p.page.evaluate(() => document.querySelector('.rl-offer:not([hidden]) .rl-offer-text')?.textContent ?? null);
const waitOffer = (p, ms) => until(p, () => { const o = document.querySelector('.rl-offer'); return !!o && !o.hidden; }, null, ms);
const asksBy = (who) => listAsks.filter((a) => a.who === who).length;
const settle = (p, ms) => p.page.waitForTimeout(ms);
async function signInAs(p, handle) {
  await p.page.click('button.rl-signin');
  await p.page.fill('.rl-handle', handle);
  await p.page.waitForTimeout(900);
  await p.page.click('button.rl-continue');
  await p.page.waitForSelector('[data-signed-in]', { timeout: 8000 });
}
const joined = (p) => until(p, () => window.__roomsLab.room?.link.joined === true);

try {
  const beforeNick = await publish(NICK, 'Old Lantern', Date.now() - 10 * 60_000);   // from before joining: never offered

  step('Nick (signed in) makes a room; Robin (signed in) and Ted (typed name) join; the tile box\'s one help line');
  // Nick's slow check is a minute here, so his offers can only come from the look on coming back to the tab.
  const nick = await person('Nick', { pollMs: 60_000 });
  await nick.page.goto(PAGE);
  await signInAs(nick, 'nick.test');
  await nick.page.click('button:has-text("New room")');
  await joined(nick);
  const invite = await nick.page.inputValue('.rl-invite');
  const robin = await person('Robin');
  await robin.page.goto(invite);
  await signInAs(robin, 'robin.test');
  await robin.page.click('button:has-text("Join room")');
  await joined(robin);
  const ted = await person('Ted');
  await ted.page.goto(invite);
  await ted.page.fill('.rl-name', 'Ted');
  await ted.page.click('button:has-text("Join room")');
  await joined(ted);
  for (const p of [nick, robin, ted]) {
    assert.equal(await text(p, '.rl-tile-help'), 'Paste a tile’s address (at://… or a tile link), preview it here, and then open it for everyone.');
    assert.equal(await text(p, '.rl-tile-help'), TILE_HELP);
    assert.equal(await p.page.locator('.rl-tiles .rl-help').count(), 1, 'one help line');
    assert.equal(await offerShown(p), false, 'nothing offered at first');
  }

  step('Robin publishes "Twilight Sprite" with the room\'s tab hidden; coming back: the offer, on her page only');
  await robin.page.evaluate(() => window.__setVisible(false));
  const twilight = await publish(ROBIN, 'Twilight Sprite');
  await settle(robin, 2500);
  assert.equal(await offerShown(robin), false, 'hidden: nothing yet');
  const asksHidden = asksBy('Robin');
  await robin.page.evaluate(() => window.__setVisible(true));
  await waitOffer(robin, 5000);
  assert.equal(asksBy('Robin'), asksHidden + 1, 'one look on coming back');
  assert.equal(await offerText(robin), 'Twilight Sprite is now saved in your account.');
  assert.equal(await text(robin, '.rl-offer'), 'Twilight Sprite is now saved in your account.Preview itNot now', 'nothing else in the offer');
  assert.equal(await robin.page.locator('.rl-offer b').first().textContent(), 'Twilight Sprite');
  assert.deepEqual(await robin.page.evaluate(() => [...document.querySelectorAll('.rl-offer-actions button')].map((b) => b.textContent)), ['Preview it', 'Not now']);
  assert.equal(await robin.page.getAttribute('.rl-offer', 'role'), 'status');
  assert.equal(await offerShown(nick), false);
  assert.equal(await offerShown(ted), false);
  assert.ok(listAsks.every((a) => (a.who === 'Robin' ? a.repo === ROBIN : a.who === 'Nick' ? a.repo === NICK : false)), 'each page looks at its own account only');
  assert.ok(listAsks.every((a) => a.collection === 'ing.dasl.masl'));
  assert.equal(asksBy('Ted'), 0, 'a typed name: no looks at all');

  step('Preview it: the same private preview as pasting the address; the offer goes; asking reaches Nick');
  await robin.page.click('.rl-offer-actions button:has-text("Preview it")');
  await until(robin, (u) => !!document.querySelector(`.rl-tile[data-uri="${u}"]`), twilight);
  const card = robin.page.locator(`.rl-tile[data-uri="${twilight}"]`);
  assert.match(await card.getAttribute('class'), /rl-tile-preview/);
  assert.equal(await card.locator('.rl-tile-private').textContent(), 'Only you can see this (unless you’re sharing your whole screen).');
  await until(robin, (u) => document.querySelector(`.rl-tile[data-uri="${u}"]`)?.dataset.state === 'open', twilight);
  assert.equal(await card.locator('.rl-tile-name').textContent(), 'Twilight Sprite');
  assert.equal(await card.locator('.rl-tile-author').textContent(), 'by @robin.test');
  assert.deepEqual(await card.locator('.rl-tile-actions button').allTextContents(), ['Ask to open for everyone', 'Cancel']);
  assert.equal(await offerShown(robin), false, 'the offer is gone');
  assert.equal(await nick.page.locator(`.rl-tile[data-uri="${twilight}"]`).count(), 0, 'nobody else has it yet');
  await card.locator('button:has-text("Ask to open for everyone")').click();
  await until(nick, () => !!document.querySelector('.rl-approval'));
  assert.match(await text(nick, '.rl-approval'), /@robin\.test/);
  // Nick decides another time; Robin cancels her preview so the rest of the check starts clean.
  await nick.page.locator('.rl-approval button', { hasText: /Deny|No/ }).first().click().catch(() => {});
  await robin.page.locator(`.rl-tile[data-uri="${twilight}"] button:has-text("Cancel")`).click().catch(() => {});
  await robin.page.evaluate(() => { window.__setVisible(false); window.__setVisible(true); });
  await settle(robin, 1200);
  assert.equal(await offerShown(robin), false, 'a previewed tile isn\'t offered again');

  step('several: "Glass d12 and +1 more are now saved in your account."; +1 more lists the other; Not now drops them for this visit');
  await robin.page.evaluate(() => window.__setVisible(false));
  await publish(ROBIN, 'Beach Sprite');
  await new Promise((r) => setTimeout(r, 20));
  await publish(ROBIN, 'Glass d12');
  await robin.page.evaluate(() => window.__setVisible(true));
  await waitOffer(robin, 5000);
  assert.equal(await offerText(robin), 'Glass d12 and +1 more are now saved in your account.');
  assert.doesNotMatch(await text(robin, '.rl-offer'), /null|undefined/);
  assert.equal(await robin.page.locator('.rl-offer-list').count(), 0, 'the list starts closed');
  await robin.page.click('.rl-offer-more');
  assert.deepEqual(await robin.page.locator('.rl-offer-list .rl-offer-name').allTextContents(), ['Beach Sprite']);
  assert.doesNotMatch(await text(robin, '.rl-offer'), /null|undefined/);
  assert.equal(await robin.page.getAttribute('.rl-offer-more', 'aria-expanded'), 'true');
  assert.equal(await robin.page.locator('.rl-offer-list button:has-text("Preview it")').count(), 1);
  await robin.page.click('.rl-offer-actions button:has-text("Not now")');
  assert.equal(await offerShown(robin), false);
  await robin.page.evaluate(() => { window.__setVisible(false); window.__setVisible(true); });
  await settle(robin, 2500);
  assert.equal(await offerShown(robin), false, 'Not now: not offered again on a return or by the slow check');
  await robin.page.evaluate(() => window.__setVisible(false));
  await publish(ROBIN, 'Snow Sprite');
  await robin.page.evaluate(() => window.__setVisible(true));
  await waitOffer(robin, 5000);
  assert.equal(await offerText(robin), 'Snow Sprite is now saved in your account.', 'a newer tile, offered alone');

  step('the slow check: offered without a return while visible; no more looks while an offer waits; none while hidden');
  await robin.page.click('.rl-offer-actions button:has-text("Not now")');
  await publish(ROBIN, 'Side by Side');
  await waitOffer(robin, 6000);
  assert.equal(await offerText(robin), 'Side by Side is now saved in your account.');
  const waiting = asksBy('Robin');
  await settle(robin, 4000);
  assert.equal(asksBy('Robin'), waiting, 'paused while the offer waits');
  await robin.page.click('.rl-offer-actions button:has-text("Not now")');
  await robin.page.evaluate(() => window.__setVisible(false));
  const hiddenAt = asksBy('Robin');
  await publish(ROBIN, 'While Away');
  await settle(robin, 4000);
  assert.equal(asksBy('Robin'), hiddenAt, 'hidden: no looks');
  assert.equal(await offerShown(robin), false);
  await robin.page.evaluate(() => window.__setVisible(true));
  await waitOffer(robin, 5000);
  assert.equal(await offerText(robin), 'While Away is now saved in your account.');
  await robin.page.click('.rl-offer-actions button:has-text("Not now")');

  step('a tile already open for everyone isn\'t offered; Nick\'s tile from before joining never is; his new one is, with "Open for everyone"');
  const shared = await publish(ROBIN, 'Shared Already');
  await nick.page.fill('.rl-tile-input', shared);
  await nick.page.click('.rl-tile-preview-go');
  await until(nick, (u) => document.querySelector(`.rl-tile[data-uri="${u}"]`)?.dataset.state === 'open', shared);
  await nick.page.locator(`.rl-tile[data-uri="${shared}"] button:has-text("Open for everyone")`).click();
  await until(robin, (u) => !!document.querySelector(`.rl-tile[data-uri="${u}"]:not(.rl-tile-preview)`), shared);
  await robin.page.evaluate(() => { window.__setVisible(false); window.__setVisible(true); });
  await settle(robin, 2500);
  assert.equal(await offerShown(robin), false, 'already open for everyone: not offered');
  await settle(nick, 2000);
  assert.equal(await offerShown(nick), false, `Nick's tile from before joining (${beforeNick.split('/').pop()}) isn't offered`);
  await nick.page.evaluate(() => window.__setVisible(false));
  const nickNew = await publish(NICK, 'Host Lantern');
  await nick.page.evaluate(() => window.__setVisible(true));
  await waitOffer(nick, 5000);
  assert.equal(await offerText(nick), 'Host Lantern is now saved in your account.', 'offered on coming back (his slow check is a minute away)');
  await nick.page.click('.rl-offer-actions button:has-text("Preview it")');
  await until(nick, (u) => document.querySelector(`.rl-tile[data-uri="${u}"]`)?.dataset.state === 'open', nickNew);
  assert.deepEqual(await nick.page.locator(`.rl-tile[data-uri="${nickNew}"] .rl-tile-actions button`).allTextContents(), ['Open for everyone', 'Cancel']);
  assert.equal(await offerShown(robin), false, 'nobody else hears of Nick\'s tile');
  assert.equal(asksBy('Ted'), 0, 'Ted\'s page never looked at anyone');

  step('phone width: the offer wraps, no sideways scroll');
  await robin.page.setViewportSize({ width: 375, height: 800 });
  await robin.page.evaluate(() => window.__setVisible(false));
  await publish(ROBIN, 'A Tile With Quite A Long Name For A Phone Screen');
  await robin.page.evaluate(() => window.__setVisible(true));
  await waitOffer(robin, 5000);
  assert.equal(await robin.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const box = await robin.page.locator('.rl-offer').boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 375, 'the offer fits');
  await robin.page.locator('.rl-tiles').scrollIntoViewIfNeeded();
  if (process.env.OFFER_SHOT) await robin.page.screenshot({ path: process.env.OFFER_SHOT });

  assert.deepEqual(errors, [], 'no page errors');
  console.log('\nAll new-tile offer checks passed.');
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  await dev.close();
}
