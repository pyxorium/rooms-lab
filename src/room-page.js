// room-page.js: the Rooms lab page (rooms-lab-plan.md, section 7): voice and one presenter's screen between
// 2 to 6 people (build step 2), with the house tile deciding who may ask (step 3). Framework-free, in Raku's
// plain style, so Raku can import it later (R3).
//
// mountRoomPage(root, options) draws the page into `root`:
// - the lobby: "Sign in with your account" (optional, step 8: the room shows your verified handle) or "Or type
//   a name" (shown as typed, marked unverified), with "You'll appear in the room as …", then "New room",
//   "Join room" (from an invite link) or "Rejoin as host" (this tab made the room, or opened the host link);
// - the room: the stage (the presenter's screen), Unmute / Share my screen, the people here (the host,
//   who's presenting, who's talking, each direct connection), "Ask to see screen", the host's Remove and
//   End room, and the room's messages.
//
// Wishes (step 3; R1): a screen-share wish has three jobs.
//   asking     "Ask to see screen" or "Share my screen" on anyone's page: the wish goes to the host's page;
//   mediating  the host's page asks the house tile (house-bridge.js), which answers allow, deny or
//              ask-host (then the host's page shows Allow / Deny). No house: the host approves each request;
//   granting   always the person: their page's prompt ("Choose what to share…"), then the browser's picker.
// A page takes "someone asks to see your screen" and "you may present" only from the host's page (the relay
// says who sent what, and can't be fooled by a page).
//
// Consent: a screen is only ever captured from a click by the person sharing. The browser's own picker
// comes next, and its "Stop sharing" bar stays up while sharing. No page and no house tile can start
// someone's share. Nothing is recorded.
//
// Open for everyone (step 4): anyone pastes a tile's address; the wish goes to the host's page, which reads
// the tile's record (its CID: this exact version), checks Raku's hide list, and asks the house (the host may
// open tiles; anyone else, the host approves). Then the host's page sends the address and CID to everyone,
// and each page checks the tile again for itself and opens its own copy in the strip (tile-strip.js).
// Preview first (step 4b): the address box only previews. Whoever opens a tile (or asks to) runs it on their
// own page first, privately, after the same checks; the host can preview a guest's request from its approval
// card. What's sent is the version previewed (a request carries its CID; the host refuses another), and the
// preview becomes that person's card in place, still running.
//
// Live tiles (live.js; rooms-live-tiles-plan.md): a tile that speaks the live protocol can be shared live
// with the room: its copies then send each other what people do in them, through the host's page (which
// numbers every message in one order), over the direct data channels only. It's a wish like the others:
// the host's own goes ahead; a guest's "Ask to share live" goes to the host's approval card (the house
// decides which; a house that doesn't know "live" leaves it to the page, with the same answer). The host
// turns it off again with "Stop sharing live". While the host is away, live tiles pause.
//
// Optional sign-in (step 8; signin.js; claude/rooms-signin-plan.md): a label, not a gate. Someone who signs in
// joins with a pass, and the relay (it alone vouches) shows their handle to the room with a check mark; a typed
// name shows "(unverified)" and can't start with "@". Sign-in happens before joining only; signing out takes
// effect on the next join. The host signed in can come back by account (another device, no host key); one live
// connection per account (an older tab hears "You joined this room from another tab or device"). The house
// learns only verified yes/no per person; tiles learn nothing about it.
//
// The stage (step 9; stage.js; claude/rooms-lab-step9.md): one thing at a time, a screen or a tile, in a box that
// keeps one size. The host's page decides which tile is on it (tiles the host opens go there at once; anyone
// else's goes to the list, and the host can "Put on stage") and tells everyone; a newcomer learns it with the
// tile list. A new screen share takes the stage back. The page's own badge says "Screen" or "Tile" (a tile names
// itself, so it can't pass for a screen). A staged tile's card is laid over the stage, never moved (a browser
// reloads a frame that moves). Handle suggestions in the sign-in box (typeahead.js, Raku's copy).
//
// Hosted by another page (0.11.0; Raku's room tab, claude/raku-rooms-plan.md): with `joinScreen` and `links`
// the room never reads or rewrites the page's own address (Raku keeps its tabs there). The host page draws its
// own join screen into the room's view (joinScreen({ view, note, enter, again })) and calls enter() with the
// code, the name and (signed in) the pass; `links` builds the invite and host links; `chrome: false` leaves out
// the lab's heading and footer; onJoined / onPeople / onOver tell the host page how the room is going. The lab
// page passes none of these and behaves as before.
import { connectRoom } from './room-link.js';
import { createMesh } from './mesh.js';
import { createLevels } from './levels.js';
import { readPeerData, readIceServers } from './messages.js';
import { afterAnnounce, afterPeople } from './presenting.js';
import { cleanName, newRoomCode, readRoomHash, inviteLink, hostLink } from './formats.js';
import { cleanHandle } from './signin.js';
import { createHouseBridge } from './house-bridge.js';
import { createTileRecords, parseTileUri } from './tile-records.js';
import { createHideCheck } from './hide-check.js';
import { createTileStrip, MAX_TILES } from './tile-strip.js';
import { relayUrl, ICE_SERVERS, TIMES } from './config.js';
import { createLiveTiles, readPeerLive } from './live.js';
import { parseAddress, HINT } from './address.js';
import { whatsOnStage, afterPresenterChange, stageLines, EMPTY_LINE, EMPTY_HINT_HOST, EMPTY_HINT_GUEST, fullScreenCall, fullScreenNow, leaveFullScreen } from './stage.js';
import { attachTypeahead } from './typeahead.js';
import { createNewTileWatcher, offerWords, POLL_MS as NEW_TILE_POLL_MS, LIST_LIMIT as NEW_TILE_LIST } from './new-tiles.js';

export const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
};

const PHONE_UPRIGHT = '(orientation: portrait) and (max-width: 700px)';   // step 9b: the tall tile stage
export const NAME_KEY = 'rooms-lab-name';          // localStorage: your typed name, for next time (Raku's join screen too)
// The tile box's help (0.10.0, owner's words): one line for everyone.
export const TILE_HELP = 'Paste a tile\u2019s address (at://\u2026 or a tile link), preview it here, and then open it for everyone.';
const hostKeyKey = (room) => `rooms-lab-host:${room}`;   // sessionStorage: this tab's host key for a room
const tilesKey = (room) => `rooms-lab-tiles:${room}`;    // sessionStorage: the host's tiles open for everyone (a reload keeps them)
const meKey = (room) => `rooms-lab-me:${room}`;          // sessionStorage: this tab's peer id last time (a reload gets a new one)

// The host's house line (0.11.1, RR14): the house tile is the room's rules.
export const HOUSE_LINES = Object.freeze({
  ready: 'House rules: when a guest asks for something, you decide.',
  loading: 'Loading the house rules\u2026',
  none: 'The house rules couldn\u2019t load, so you decide every request yourself.',
});

export const HONEST = [
  'This is a lab: a try-out, not a finished app.',
  '\u2713 means the handle was checked through sign-in; other names are typed.',
  'Nothing is recorded or stored.',
  'The relay only introduces the people in a room and passes their messages; it stores nothing.',
  "Voice and screens go directly between computers when they can. When a network blocks that, they pass through Cloudflare's relay, still encrypted; Cloudflare sees addresses and timing, not what's said or shown.",
  "To find each other, each computer asks a public STUN server (Google's or Cloudflare's) for its own address.",
  "A tile opened for everyone runs on each person's own computer, from its author's account; each page first checks it (Raku's hide list, and that it's the same version for everyone).",
  "A tile shared live sends what people do in it to the other copies of the same tile only: through the host's page, directly between the computers (encrypted, never through the relay), with random ids instead of names. Nothing is kept.",
];

const DEFAULTS = {
  loc: globalThis.location,
  storage: (() => { try { return globalThis.localStorage; } catch { return null; } })(),
  session: (() => { try { return globalThis.sessionStorage; } catch { return null; } })(),
  history: globalThis.history,
  WebSocketImpl: globalThis.WebSocket,
  RTCPeerConnectionImpl: globalThis.RTCPeerConnection,
  AudioContextImpl: globalThis.AudioContext,
  mediaDevices: globalThis.navigator?.mediaDevices,
  clipboard: globalThis.navigator?.clipboard,
  iceServers: ICE_SERVERS,
  times: TIMES,
  // The house tile's frame, made for the host's page (see house-bridge.js); null: no house, the host
  // approves each request.
  loadHouse: null,
  houseTimes: undefined,
  // The tile loader for tiles opened for everyone: { render({ uri, manifest, loader, height, name }) → frame }.
  // null: this page can't open tiles (the strip says so). records / hideCheck: swappable for the checks.
  tileHost: null,
  records: null,
  hideCheck: null,
  // Is the person's click still "fresh"? Browsers only open the screen picker straight from a click.
  activation: () => !!globalThis.navigator?.userActivation?.isActive,
  // Optional sign-in (signin.js createSignIn, already started), or null: typed names only.
  signIn: null,
  // Handle suggestions in the sign-in box (typeahead.js): the fetch they use (the checks swap it); null: none.
  suggestFetch: globalThis.fetch ? (...a) => globalThis.fetch(...a) : null,
  // Hosted by another page (0.11.0, Raku): see the top of this file. null: the lab page's own ways.
  joinScreen: null,        // ({ view, note, again, enter }) → draws the join screen into view; enter({ code, name, create, hostKey, getPass, did })
  links: null,             // { invite(code) → link, host(code, key) → link }
  chrome: true,            // the lab's heading ("Rooms lab") and its footer
  turnOnly: false,         // the &turn=only test switch, when the page's address isn't the room's
  onJoined: null,          // ({ code, host }) each time the relay lets this page in
  onPeople: null,          // ([{ peer, name, verified, host, away, me }]) whenever the people here change
  onOver: null,            // ({ code, why, again, reason }) when this page leaves the room (or is taken out)
};

const get = (s, k) => { try { return s?.getItem(k) ?? null; } catch { return null; } };
const put = (s, k, v) => { try { if (v == null) s?.removeItem(k); else s?.setItem(k, v); } catch { /* private window */ } };
// A host key kept for one room in this tab (sessionStorage), for a host page with its own join screen (Raku).
export const keepHostKey = (session, room, key) => put(session, hostKeyKey(room), key || null);
export const keptHostKey = (session, room) => get(session, hostKeyKey(room));

// A person's label: "@handle ✓" (checked through sign-in) or "Name (unverified)".
export function whoLabel(name, verified) {
  return verified
    ? [`@${name}`, ' ', h('span', { class: 'rl-check', title: 'Handle checked through sign-in' }, '✓')]
    : [name, ' ', h('span', { class: 'rl-unv' }, '(unverified)')];
}

export const NET_NOTES = {
  unavailable: "The fallback relay isn't available right now, so people on strict networks may not be able to connect.",
  turnOnly: 'Test switch on (turn=only): this page sends everything through the TURN relay.',
  turnOnlyNone: "Test switch on (turn=only), but the TURN relay isn't available, so this page can't connect to anyone.",
};

// The clash line (owner's wording, Oct 25): the other page still looks signed in afterwards (it borrows this
// sign-in), so say what really changes: it will need a new sign-in before it can save.
export function clashLine(hd, r) {
  if (r.unknown) return 'Signing in here may replace this account\u2019s Daisy or Seven-Up sign-in in this browser. They\u2019d need you to sign in again before saving.';
  if (r.page === 'Daisy') return `This replaces @${hd}\u2019s Daisy sign-in in this browser. Daisy will need you to sign in again before it can save or use the lounge.`;
  if (r.page === 'Seven-Up') return `This replaces @${hd}\u2019s Seven-Up sign-in in this browser. Seven-Up will need you to sign in again before it can save.`;
  return `This replaces @${hd}\u2019s sign-in for another page on this site. That page will need you to sign in again.`;
}

export function mountRoomPage(root, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const url = o.relayUrl || relayUrl(o.loc);
  // The lab page keeps the room in its own address; a host page (Raku) keeps it itself (o.links, o.joinScreen).
  const ownAddress = !o.links && !o.joinScreen;
  const links = o.links || { invite: (code) => inviteLink(o.loc, code), host: (code, key) => hostLink(o.loc, code, key) };
  // The &turn=only test switch (step 7): read once, kept in this tab's own address, never in the invite link.
  let turnOnly = ownAddress ? readRoomHash(o.loc?.hash).turnOnly : !!o.turnOnly;
  const ownLink = (code) => inviteLink(o.loc, code) + (turnOnly ? '&turn=only' : '');
  const records = o.records || createTileRecords();
  const hideCheck = o.hideCheck || createHideCheck({ storage: o.storage });
  let room = null;                   // everything about the room once joined (null in the lobby)

  const view = h('div', { class: 'rl-view' });
  root.replaceChildren(h('div', { class: o.chrome ? 'rl' : 'rl rl-hosted' },
    o.chrome ? h('header', { class: 'rl-top' }, h('h1', {}, 'Rooms lab'), h('span', { class: 'rl-badge' }, 'lab')) : null,
    view,
    o.chrome ? h('footer', { class: 'rl-honest' }, h('ul', {}, HONEST.map((t) => h('li', {}, t)))) : null,
  ));

  // The way in: the lab's lobby, or the host page's own join screen (Raku).
  function start(note = '', again = null) {
    if (!o.joinScreen) { lobby(note); return; }
    o.joinScreen({ view, note, again, enter: (args) => { if (!room) enter(args); } });
  }

  // ---- The lobby ----
  // Two ways in (the approved mockup, claude/rooms-join-mockup.html): sign in (optional; the room shows your
  // verified handle) or type a name (shown as typed, marked unverified). "You'll appear in the room as …"
  // says which. Sign-in only when the page has it (o.signIn ready); otherwise just the name, as before.
  function lobby(note = '') {
    // A host link (#r=…&k=…): keep the key in this tab only, and take it out of the address bar so it
    // isn't copied along by accident.
    const { room: code, hostKey: linkKey, turnOnly: testSwitch } = readRoomHash(o.loc.hash);
    if (testSwitch) turnOnly = true;
    if (code && linkKey) {
      put(o.session, hostKeyKey(code), linkKey);
      try { o.history?.replaceState(null, '', ownLink(code)); } catch { /* fine */ }
    }
    const keptKey = code ? get(o.session, hostKeyKey(code)) : null;
    const si = o.signIn && o.signIn.ready() ? o.signIn : null;
    const account = si?.account || null;
    const problem = h('p', { class: 'rl-problem', role: 'alert' }, note);
    const nameBox = h('input', { class: 'rl-name', type: 'text', maxlength: 40, autocomplete: 'nickname', value: get(o.storage, NAME_KEY) || '', 'aria-describedby': 'rl-appear' });

    // "You'll appear in the room as …" (or, for a typed name starting with "@", why it can't be used).
    const appear = h('p', { class: 'rl-appear-as', id: 'rl-appear' });
    const typedProblem = (raw) => (String(raw || '').trim().startsWith('@') ? 'A typed name can’t start with “@”. Sign in to show a handle.' : null);
    const showAppear = () => {
      if (account) { appear.replaceChildren(h('span', { class: 'rl-appear-label' }, 'You’ll appear in the room as'), h('span', { class: 'rl-appear-who' }, ...whoLabel(account.handle, true))); return; }
      const bad = typedProblem(nameBox.value);
      const name = cleanName(nameBox.value);
      appear.classList.toggle('rl-appear-bad', !!bad);
      if (bad) appear.replaceChildren(h('span', { class: 'rl-problem' }, bad));
      else appear.replaceChildren(h('span', { class: 'rl-appear-label' }, 'You’ll appear in the room as'),
        name ? h('span', { class: 'rl-appear-who' }, ...whoLabel(name, false)) : h('span', { class: 'rl-unv' }, si ? 'Type a name or sign in.' : 'Type a name.'));
      for (const b of actions.querySelectorAll('button')) b.disabled = !!bad;
    };
    nameBox.addEventListener('input', showAppear);

    const go = (how) => {
      let name;
      if (account) name = account.handle;
      else {
        if (typedProblem(nameBox.value)) { nameBox.focus(); return; }
        name = cleanName(nameBox.value);
        if (!name) { problem.textContent = si ? 'Type a name first (up to 40 characters), or sign in.' : 'Type a name first (up to 40 characters).'; nameBox.focus(); return; }
        put(o.storage, NAME_KEY, name);
      }
      const signedIn = account ? { getPass: () => si.getPass(), did: account.did } : {};
      if (how === 'new') {
        const fresh = newRoomCode();
        try { o.history?.replaceState(null, '', ownLink(fresh)); } catch { /* fine */ }
        enter({ code: fresh, name, create: true, ...signedIn });
      } else enter({ code, name, hostKey: how === 'host' ? keptKey : null, ...signedIn });
    };
    nameBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(code ? (keptKey ? 'host' : 'join') : 'new'); });

    const actions = h('div', { class: 'rl-actions' },
      code && keptKey ? h('button', { class: 'rl-primary', type: 'button', onclick: () => go('host') }, 'Rejoin as host') : null,
      code ? h('button', { class: keptKey ? '' : 'rl-primary', type: 'button', onclick: () => go('join') }, keptKey ? 'Join as a guest' : 'Join room') : null,
      h('button', { class: code ? '' : 'rl-primary', type: 'button', onclick: () => go('new') }, code ? 'Start a new room instead' : 'New room'),
    );

    const intro = code
      ? h('p', {}, keptKey ? 'You made this room (or opened its host link) in this tab. ' : "You're invited to a room. ", 'Room ', h('code', {}, code), '.')
      : h('p', {}, 'Start a room, then send its link to the people you want to join. Voice and one shared screen, for 2 to 6 people.');

    // The typed-name panel (always there when signed out).
    const namePanel = h('div', { class: 'rl-way rl-way-name' },
      si ? h('h3', {}, 'Or type a name') : null,
      h('label', { class: 'rl-field' }, h('span', {}, 'Your name'), nameBox),
      appear);

    let panels;
    if (account) {
      // Signed in: one panel; the typed-name panel is gone (sign out to type a name instead).
      panels = [h('div', { class: 'rl-way rl-way-signed', 'data-signed-in': '' },
        h('h3', {}, 'Signed in'),
        h('p', { class: 'rl-help rl-signed-as' }, `as @${account.handle} · `,
          h('button', { type: 'button', class: 'rl-link rl-signout', onclick: async () => { await si.signOut(); lobby(); } }, 'Sign out')),
        appear)];
    } else if (si) {
      panels = [signInPanel(si, { onOpen: (open) => { namePanel.hidden = open; actions.hidden = open; problem.textContent = ''; }, onDone: () => lobby() }), namePanel];
    } else panels = [namePanel];

    view.replaceChildren(h('section', { class: 'rl-lobby' }, intro, ...panels, actions, problem));
    showAppear();
    if (!account && !nameBox.value) nameBox.focus();
  }

  // The sign-in panel: a button, then (pressed) the handle box with Continue / Cancel. The library needs the
  // handle to find the account's server before it opens the sign-in window.
  function signInPanel(si, { onOpen, onDone }) {
    const panel = h('div', { class: 'rl-way rl-way-signin' });
    const help = () => h('p', { class: 'rl-help' }, 'Your handle will appear in the room as verified. Optional.');
    const closed = () => {
      onOpen(false);
      panel.replaceChildren(
        h('button', { type: 'button', class: 'rl-signin', onclick: opened }, 'Sign in with your account'),
        help());
    };
    const checks = new Map();          // handle → Promise of clashFor(handle)
    const settled = new Map();         // handle → clashFor's answer, once known
    let warned = null;                 // the handle the clash warning was shown for
    let abort = null;
    const check = (hd) => {
      if (!checks.has(hd)) checks.set(hd, si.clashFor(hd).catch(() => ({ unknown: true })).then((r) => { settled.set(hd, r); return r; }));
      return checks.get(hd);
    };
    const clashText = (hd, r) => clashLine(hd, r);
    function opened() {
      onOpen(true);
      const box = h('input', { class: 'rl-handle', type: 'text', autocomplete: 'username', spellcheck: 'false', autocapitalize: 'none', placeholder: 'alice.bsky.social', 'aria-label': 'Your handle' });
      const clash = h('p', { class: 'rl-clash', role: 'status' });
      const status = h('p', { class: 'rl-problem', role: 'alert' });
      const cont = h('button', { type: 'button', class: 'rl-primary rl-continue' }, 'Continue');
      const cancel = h('button', { type: 'button', class: 'rl-link rl-cancel', onclick: () => { abort?.abort(); closed(); } }, 'Cancel');
      let timer = null;
      const fresh = () => { clash.textContent = ''; status.textContent = ''; warned = null; clearTimeout(timer); };
      box.addEventListener('input', () => {
        fresh();
        const hd = cleanHandle(box.value);
        // Looked up once typing pauses (or a suggestion is picked), so Continue knows at once.
        if (hd) timer = setTimeout(() => check(hd), 700);
      });
      async function go() {
        const hd = cleanHandle(box.value);
        if (!hd) { status.textContent = 'Type your handle, like alice.bsky.social.'; box.focus(); return; }
        status.textContent = '';
        const known = settled.get(hd);
        if (known && (known.page || known.unknown) && warned !== hd) { warned = hd; clash.textContent = clashText(hd, known); return; }
        // The window opens straight from the click (browsers allow it only then); if the clash check is still
        // running, it finishes while the window loads, and the window closes again if there's something to say.
        const win = si.openWindow();
        if (!win) { status.textContent = 'The sign-in window was blocked. Allow pop-ups for this page, then try again.'; return; }
        if (!known) {
          const r = await check(hd);
          if ((r.page || r.unknown) && warned !== hd) { try { win.close(); } catch { /* fine */ } warned = hd; clash.textContent = clashText(hd, r); return; }
        }
        cont.disabled = true; box.disabled = true;
        status.textContent = 'Finish signing in in the small window…';
        abort = new AbortController();
        try {
          await si.signIn(hd, abort.signal);
          onDone();
        } catch (err) {
          cont.disabled = false; box.disabled = false;
          if (abort.signal.aborted) return;
          status.textContent = /window|popup|closed/i.test(String(err?.message)) ? 'Sign-in didn’t finish. Try again.' : `Sign-in didn’t work: ${String(err?.message || err).slice(0, 140)}`;
        }
      }
      cont.addEventListener('click', go);
      box.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      // Handle suggestions (step 9): in this box only, never in the typed-name box.
      const holder = h('span', { class: 'rl-ta-holder' }, box);
      if (o.suggestFetch) {
        attachTypeahead(box, holder, { id: 'rl-signin-ta', fetchImpl: o.suggestFetch, onChoose: (hd) => {
          box.value = hd; fresh();
          const c = cleanHandle(hd);
          if (c) check(c);
        } });
      }
      panel.replaceChildren(
        h('label', { class: 'rl-field' }, h('span', {}, 'Your handle'), h('span', { class: 'rl-row' }, holder, cont)),
        clash, help(), status, cancel);
      box.focus();
    }
    closed();
    return panel;
  }

  // ---- The room ----
  function enter({ code, name, create = false, hostKey = null, getPass = null, did = null }) {
    const r = room = {
      code, name, me: null, signedIn: !!getPass, host: false,
      did: getPass ? did : null,   // the signed-in account (0.10.0: its new tiles are offered on this page only)
      joinedAt: Date.now(), newTiles: null, offerOpen: false, people: new Map(), presenter: null,
      micTrack: null, micStream: null, muted: true, screenTrack: null, screenStream: null,
      remote: new Map(),           // peer → { audio: <audio>, voice: stream, screen: stream }
      conn: new Map(),             // peer → connection state
      wishes: new Map(),           // my wishes: id → { wish, target, stage: 'host' | 'person' | 'go', timer }
      prompt: null,                // the prompt on my screen: { type: 'ask', from, id, timer } or { type: 'go', id, timer }
      house: null,                 // the host's page only: the house bridge
      approvals: new Map(),        // the host's page only: `${from} ${id}` → { from, w, reason, timer }
      hostWishes: new Map(),       // the host's page only: asker → their wish being decided (one at a time)
      roomTiles: [],               // the host's page only: the tiles open for everyone, [{ uri, cid, by, live? }]
      stageTile: null,             // the tile on the stage (every page; the host's page decides), or null
      wasHost: false,              // the host flag last time we joined (the live hub follows it)
      ice: { state: 'waiting', servers: null, at: 0 },   // TURN (step 7): 'waiting' | 'on' | 'off' | 'unavailable'
      iceTimers: [],
      route: new Map(),            // peer → 'direct' | 'relay' (from the connection's statistics)
      talking: new Set(),
      log: [],
      over: false,
    };
    const els = buildRoom(r);
    view.replaceChildren(els.section);

    r.levels = createLevels({ AudioContextImpl: o.AudioContextImpl, onChange: (s) => { r.talking = s; renderPeople(); } });
    r.levels.start();                // we're inside the Join / New room click
    r.strip = createTileStrip({
      mount: els.strip, records, hide: hideCheck, tileHost: o.tileHost, h, nameOf: (p) => nameOf(p),
      isHost: () => r.host, onCloseForEveryone: (uri) => closeForEveryone(uri), onNote: (t) => note('\u25a6', null, t),
      live: {
        info: (uri) => ({ spoke: !!r.live?.spoke(uri), live: !!r.live?.isLive(uri), asking: r.wishes.size > 0 || !r.link?.joined || !hostHere(), joining: !!r.live?.joining(uri) }),
        share: (uri) => wish('live', null, uri),
        ask: (uri) => wish('live', null, uri),
        stop: (uri) => liveForEveryone(uri, false),
      },
      onRemoved: (uri) => { r.live?.removed(uri); renderStage(); },
      stage: {
        put: (uri) => setStage(uri),
        off: () => setStage(null),
        offLabel: () => (r.presenter ? 'Back to screen' : 'Take off stage'),
        full: (el) => fullScreenCall(el),
      },
      onUpdate: (uri) => {
        if (uri !== r.stageTile) return;
        // The tile's name arrives with its record: finish the status line that went out without it.
        const name = r.strip.name(uri);
        if (name && r.stageSaid?.uri === uri && r.els.status.textContent === stageLines.put(r.stageSaid.who, null)) say(stageLines.put(r.stageSaid.who, name));
        renderStage();
      },
    });
    r.mesh = createMesh({
      iceServers: o.iceServers, RTCPeerConnectionImpl: o.RTCPeerConnectionImpl,
      waitForIce: true, relayOnly: turnOnly,
      signal: (peer, data) => r.link.to(peer, data),
      onTrack: (peer, track, stream) => remoteTrack(peer, track, stream),
      onPeerState: (peer, state) => {
        r.conn.set(peer, state);
        if (state === 'closed') { forgetRemote(peer); r.route.delete(peer); }
        if (state === 'connected') checkRoutes();
        renderPeople();
      },
      onError: (peer, e) => note('!', peer, `connection setup: ${e?.name || 'error'} ${String(e?.message || '').slice(0, 120)}`),
      onData: (peer, obj) => {
        const m = readPeerLive(obj);
        if (!m) { note('!', peer, 'something on the direct connection the page doesn\u2019t know; ignored'); return; }
        r.live.fromPeer(peer, m);
      },
      onChannel: (peer, st) => {
        if (st === 'open' && peer === hostPeer()?.peer) r.live.hostConnected();
        if (st === 'closed') r.live.peerGone(peer);
      },
    });
    r.live = createLiveTiles({
      strip: r.strip, room: code, session: o.session,
      isHost: () => r.host, me: () => r.me, hostPeer: () => hostPeer()?.peer || null, hostAway: () => !!hostPeer()?.away,
      toPeer: (peer, obj) => r.mesh.sendData(peer, obj),
      onLog: (dir, peer, text) => note(dir, peer, text),
      onChange: () => r.strip.refresh(),
    });
    r.link = connectRoom({
      url, room: code, name, create, hostKey, getPass, WebSocketImpl: o.WebSocketImpl, times: o.times,
      onState: (state, d = {}) => linkState(state, d),
      onSelf: (peer) => { r.me = peer; r.mesh.setSelf(peer); },
      onMessage: (m) => relayMessage(m),
    });
    r.me = r.link.peer;
    r.mesh.setSelf(r.me);
    // Connections wait a moment for the relay's TURN credentials, then start without them if need be.
    r.iceTimers.push(setTimeout(() => { if (room === r && !r.mesh.iceReady) useIce(null); }, o.times.iceWaitMs ?? 4000));
    r.iceTimers.push(setInterval(() => checkRoutes(), 3000));
    // The staged card follows the stage's box wherever the page's layout puts it.
    r.placer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => placeStaged()) : null;
    r.placer?.observe(els.section);
    r.placer?.observe(els.stage);
    r.onResize = () => renderStage();        // a phone turned: the stage's shape may change (step 9b)
    globalThis.addEventListener?.('resize', r.onResize);
    r.onFull = () => { renderStage(); r.strip.refresh(); };
    globalThis.document?.addEventListener('fullscreenchange', r.onFull);
    globalThis.document?.addEventListener('webkitfullscreenchange', r.onFull);
    renderNet();
    say('Connecting to the room…');
    render();
  }

  // ---- TURN and routes (step 7) ----
  function askIce(r) {
    const age = Date.now() - r.ice.at;
    if (r.ice.servers && age < (o.times.iceRefreshMs ?? 3 * 3600_000)) return;
    r.link.askIce();
  }
  function gotIce(r, m) {
    const servers = m.servers ? readIceServers(m.servers) : null;
    if (servers) {
      r.ice = { state: 'on', servers, at: Date.now() };
      clearTimeout(r.iceRefresh);
      r.iceRefresh = setTimeout(() => { if (room === r && r.link.joined) askIce(r); }, o.times.iceRefreshMs ?? 3 * 3600_000);
      useIce(servers);
      note('⇄', null, 'the TURN relay is ready (for networks that block direct connections)');
    } else if (m.none === 'off' || m.none === 'unavailable' || m.servers) {
      if (!r.ice.servers) { r.ice.state = m.none === 'off' ? 'off' : 'unavailable'; useIce(null); }
      note('!', null, 'no TURN relay: direct connections only');
    }
    renderNet();
  }
  function useIce(servers) {
    const r = room;
    if (!r) return;
    r.mesh.setIceServers(servers ? [...o.iceServers, ...servers] : o.iceServers);
  }
  function renderNet() {
    const r = room;
    if (!r) return;
    const none = r.ice.state === 'off' || r.ice.state === 'unavailable';
    const text = turnOnly ? (none ? NET_NOTES.turnOnlyNone : NET_NOTES.turnOnly) : none ? NET_NOTES.unavailable : '';
    r.els.net.textContent = text;
    r.els.net.hidden = !text;
  }
  let checking = false;
  async function checkRoutes() {
    const r = room;
    if (!r || checking) return;
    checking = true;
    try {
      let changed = false;
      for (const [peer, st] of r.conn) {
        if (st !== 'connected') continue;
        const way = await r.mesh.route(peer);
        if (room !== r) return;
        if (way && r.route.get(peer) !== way) { r.route.set(peer, way); changed = true; }
      }
      if (changed) renderPeople();
    } finally { checking = false; }
  }

  function buildRoom(r) {
    const els = {};
    els.status = h('p', { class: 'rl-status', role: 'status', 'aria-live': 'polite' });
    els.net = h('p', { class: 'rl-net', hidden: true });
    els.invite = h('input', { class: 'rl-invite', type: 'text', readonly: true, value: links.invite(r.code), 'aria-label': 'Invite link' });   // never with the test switch
    els.copy = h('button', { type: 'button', onclick: () => copy(els.invite.value, 'Invite link copied.') }, 'Copy invite link');
    els.hostTools = h('span', { class: 'rl-host-tools', hidden: true },
      h('button', { type: 'button', onclick: () => copy(links.host(r.code, r.link.hostKey), 'Host link copied. Keep it to yourself: whoever opens it becomes the host.') }, 'Copy host link'),
      h('button', { type: 'button', class: 'rl-danger', onclick: () => { if (r.host) r.link.end(); } }, 'End room'));
    els.leave = h('button', { type: 'button', onclick: () => leave('You left the room.') }, 'Leave');
    els.video = h('video', { class: 'rl-video', autoplay: true, playsinline: true, muted: true, hidden: true });
    els.video.muted = true;
    // The stage keeps one size (step 9): a bar (the page's own "Screen" / "Tile" badge, what's on, Full screen)
    // over a 16:9 area (the screen, or the messages when nothing's on). A staged tile's card is laid over both.
    els.stageBadge = h('span', { class: 'rl-stage-badge', hidden: true });
    els.caption = h('span', { class: 'rl-caption' });
    els.full = h('button', { type: 'button', class: 'rl-stage-full', hidden: true, onclick: () => toggleScreenFull() }, 'Full screen');
    els.emptyLine = h('p', { class: 'rl-stage-line' });
    els.emptyHint = h('p', { class: 'rl-stage-hint' });
    els.empty = h('div', { class: 'rl-stage-empty' }, els.emptyLine, els.emptyHint);
    els.area = h('div', { class: 'rl-stage-area' }, els.video, els.empty);
    els.stage = h('div', { class: 'rl-stage' }, h('div', { class: 'rl-stage-bar' }, els.stageBadge, els.caption, els.full), els.area);
    els.mic = h('button', { type: 'button', class: 'rl-mic', 'aria-pressed': 'false', onclick: () => toggleMic() }, 'Unmute');
    // While "The host said you can present" is open, Share my screen does what its button does (the picker).
    els.share = h('button', { type: 'button', class: 'rl-share', onclick: () => (r.screenTrack ? stopShare('You stopped sharing.') : r.prompt?.type === 'go' ? startShare(r.prompt) : wish('present')) }, 'Share my screen');
    els.houseLine = h('p', { class: 'rl-house-line', hidden: true });
    els.houseMount = h('div', { class: 'rl-house', hidden: true });
    els.approvals = h('div', { class: 'rl-approvals' });
    els.tileInput = h('input', { class: 'rl-tile-input', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'at://\u2026/ing.dasl.masl/\u2026 or a tile link', 'aria-label': 'A tile\u2019s address' });
    els.tileButton = h('button', { type: 'submit', class: 'rl-tile-preview-go' }, 'Preview');
    els.tileForm = h('form', { class: 'rl-tile-form', onsubmit: (ev) => { ev.preventDefault(); previewTile(); } }, els.tileInput, els.tileButton);
    els.strip = h('ul', { class: 'rl-strip' });
    // 0.10.0: "Twilight Sprite is now saved in your account." (signed in only; new-tiles.js).
    els.offer = h('div', { class: 'rl-offer', role: 'status', 'aria-live': 'polite', hidden: true });
    els.prompt = h('div', { class: 'rl-prompt', role: 'alertdialog', 'aria-live': 'assertive', hidden: true });
    els.people = h('ul', { class: 'rl-people' });
    els.log = h('ol', { class: 'rl-log' });
    els.audio = h('div', { class: 'rl-audio', hidden: true });
    els.section = h('section', { class: 'rl-room' },
      h('div', { class: 'rl-bar' }, h('span', {}, 'Room ', h('code', {}, r.code)), els.invite, els.copy, els.hostTools, els.leave),
      els.houseLine,
      els.status,
      els.net,
      els.approvals,
      els.stage,
      h('div', { class: 'rl-controls' }, els.mic, els.share),
      els.prompt,
      h('section', { class: 'rl-tiles' },
        h('h2', {}, 'Tiles opened for everyone'),
        els.offer,
        els.tileForm,
        h('p', { class: 'rl-help rl-tile-help' }, TILE_HELP),
        els.strip),
      h('h2', {}, 'Here'),
      els.people,
      h('details', { class: 'rl-messages' }, h('summary', {}, 'Room messages'), els.log),
      els.audio,
      els.houseMount,
    );
    r.els = els;
    return els;
  }

  const say = (text) => { if (room) room.els.status.textContent = text; };
  // A person as the page's messages say it: "@handle" (signed in) or the typed name.
  const shown = (p) => (p ? (p.verified ? `@${p.name}` : p.name) : 'Someone');
  const nameOf = (peer) => (peer === room?.me ? 'You' : shown(room?.people.get(peer)));
  function note(dir, peer, text) {
    const r = room;
    if (!r) return;
    r.log.push(`${dir} ${peer ? nameOf(peer) : 'everyone'}: ${text}`);
    if (r.log.length > 200) r.log.shift();
    r.els.log.append(h('li', {}, r.log.at(-1)));
    while (r.els.log.children.length > 200) r.els.log.firstChild.remove();
  }

  async function copy(text, done) {
    try { await o.clipboard.writeText(text); say(done); } catch { say('Copy the link from the box.'); }
  }

  // ---- The relay ----
  function linkState(state, d) {
    const r = room;
    if (!r || r.over) return;
    if (state === 'joined') {
      const before = get(o.session, meKey(r.code));
      put(o.session, meKey(r.code), d.peer);
      r.host = d.host; r.me = d.peer;
      if (d.host && d.hostKey) put(o.session, hostKeyKey(r.code), d.hostKey);
      if (r.screenTrack) r.link.all({ kind: 'presenting', on: true });      // back after a drop: still presenting
      if (d.host) startHouse(); else stopHouse();
      if (d.host) hostTilesBack(before);
      askIce(r);                                      // TURN credentials (again only when they're running out)
      if (d.host !== r.wasHost) { r.wasHost = d.host; r.live.roleChanged(); }
      else r.live.hostConnected();                   // back after a drop: our live copies rejoin
      r.strip.refresh();
      if (r.did && !r.newTiles) startNewTiles(r);
      say(d.host ? "You're the host. Send the invite link to the people you want here." : "You're in the room.");
      try { o.onJoined?.({ code: r.code, host: !!d.host }); } catch (err) { console.error('[rooms-lab] onJoined', err); }
    } else if (state === 'down') say('Reconnecting to the room… (voice and screens carry on meanwhile)');
    else if (state === 'connecting') say('Connecting to the room…');
    else if (state === 'no-room') say(`There's no room with this code right now. Trying again (${d.tries})…`);
    else if (state === 'not-host') { put(o.session, hostKeyKey(r.code), null); say("That host link doesn't match this room, so you're joining as a guest."); }
    else if (state === 'over') {
      const signInWhy = {
        handle: 'Your handle couldn\u2019t be confirmed (it has to lead back to your account). Sign in again later, or type a name.',
        lookup: 'Sign-in can\u2019t be checked right now. Try again in a moment, or type a name.',
        unavailable: 'Sign-in can\u2019t be checked right now. Try again in a moment, or type a name.',
        'too many': 'Too many sign-in attempts. Wait a minute, or type a name.',
        'signed out': 'Your sign-in has run out. Sign in again, or type a name.',
        // did:plc only (the relay refuses did:web before any lookup; claude/rooms-lab-step8.md).
        'account type': 'Sign-in here works with most accounts, but not this kind yet. Type a name to join.',
      }[d.detail] || 'Your sign-in wasn\u2019t accepted. Sign in again, or type a name.';
      if (d.why === 'sign-in' && d.detail === 'signed out') o.signIn?.forget?.();
      const why = {
        ended: d.by === 'host gone' ? "The room has ended: the host didn't come back in time." : 'The host ended the room.',
        removed: 'The host took you out of the room.',
        replaced: d.by === 'account' ? 'You joined this room from another tab or device.' : 'You opened this room as host in another tab or window, so this one stopped.',
        'sign-in': signInWhy,
        full: 'This room is full (6 people).',
        'no room': "There's no room with this code. It may have ended, or the link may be wrong.",
        'room taken': 'That room code is taken. Start a new room.',
        refused: "The relay didn't accept that name or code.",
      }[d.why] || 'You left the room.';
      if (d.why === 'ended') put(o.session, hostKeyKey(r.code), null);
      // Back to this room's start (the link kept): after a replaced tab ("Join here instead") or a sign-in
      // that wasn't accepted ("Try again": sign in again, or type a name).
      const again = d.why === 'replaced' && d.by === 'account' ? 'Join here instead' : d.why === 'sign-in' ? 'Try again' : null;
      return leave(why, { quiet: true, again, reason: { why: d.why, by: d.by || null, detail: d.detail || null } });
    }
    render();
  }

  function relayMessage(m) {
    const r = room;
    if (!r || r.over) return;
    if (m.t === 'peers') return peers(m.list);
    if (m.t === 'ice') return gotIce(r, m);
    if (m.t === 'from') return peerMessage(m.peer, readPeerData(m.data), m.data);
    if (m.t === 'error' && m.why === 'not here' && m.peer && m.peer === hostPeer()?.peer) {
      for (const [id, w] of r.wishes) if (w.stage === 'host') dropWish(id, 'The host isn\u2019t here right now.');
    }
  }

  function peers(list) {
    const r = room;
    const was = new Set(r.people.keys());
    r.people = new Map(list.map((p) => [p.peer, p]));
    const here = list.filter((p) => !p.away).map((p) => p.peer);
    r.mesh.sync(here);
    const before = r.presenter;
    r.presenter = afterPeople(r.presenter, here);
    if (before && !r.presenter) note('←', null, `${before === r.me ? 'you' : 'the presenter'} left the stage`);
    // Someone new: tell them who's presenting, and (the host) which tiles are open (they missed it).
    const newcomers = list.filter((p) => !was.has(p.peer) && p.peer !== r.me && !p.away);
    if (r.screenTrack && newcomers.length) r.link.all({ kind: 'presenting', on: true });
    if (r.host && r.roomTiles.length) for (const p of newcomers) r.link.to(p.peer, { kind: 'tiles', list: tilesList() });   // with the stage
    // Wishes, prompts and approvals about people who've gone.
    for (const [id, w] of r.wishes) if (w.target && !here.includes(w.target)) dropWish(id, `${nameOf(w.target)} left.`);
    if (r.prompt?.type === 'ask' && !here.includes(r.prompt.from)) closePrompt();
    for (const [key, a] of r.approvals) if (!here.includes(a.from) || (a.w.target && !here.includes(a.w.target))) closeApproval(key);
    for (const from of [...r.hostWishes.keys()]) if (!here.includes(from)) r.hostWishes.delete(from);
    for (const p of was) if (!here.includes(p)) r.live.peerGone(p);
    const host = list.find((p) => p.host);
    r.live.setPaused(!r.host && !!host?.away);
    if (host && host.away) say(`Waiting for ${shown(host)} to come back…`);
    else if (r.els.status.textContent.startsWith('Waiting for')) say('The host is back.');
    // The relay says which handle it checked: keep that spelling for the lobby next time.
    const mine = list.find((p) => p.peer === r.me);
    if (mine && mine.verified && r.signedIn) o.signIn?.sawHandle?.(mine.name);
    try { o.onPeople?.(list.map((p) => ({ peer: p.peer, name: shown(p), verified: !!p.verified, host: !!p.host, away: !!p.away, me: p.peer === r.me }))); } catch (err) { console.error('[rooms-lab] onPeople', err); }
    render();
  }

  function peerMessage(from, m, raw) {
    const r = room;
    if (!m) { note('←', from, `something the page doesn't know (${String(raw?.kind ?? typeof raw).slice(0, 30)}); ignored`); return; }
    if (m.kind === 'rtc') { r.mesh.handle(from, m); return; }
    note('←', from, describe(m));
    if (m.kind === 'presenting') {
      const next = afterAnnounce(r.presenter, from, m.on);
      if (r.screenTrack && next !== r.me) { r.presenter = next; stopShare(`${nameOf(next)} started presenting at the same moment, so your share stopped.`, { tell: false }); }
      else if (next !== r.presenter && next !== r.me) say(next ? stageLines.sharing(nameOf(next)) : `${nameOf(from)} stopped sharing their screen.`);
      const before = r.presenter;
      r.presenter = next;
      if (r.host) hostPresenterChanged(before, next);
      render();
    } else if (m.kind === 'wish') {
      if (!r.host) return;
      handleWish(from, m);
    } else if (['wish-result', 'go-ahead', 'ask-screen', 'tile', 'tiles', 'tile-close', 'tile-live', 'stage'].includes(m.kind)) {
      if (from !== hostPeer()?.peer) { note('!', from, `${m.kind} not from the host: ignored`); return; }
      if (m.kind === 'wish-result') wishResult(m.id, m.decision, m.reason);
      else if (m.kind === 'go-ahead') goAhead(m.id);
      else if (m.kind === 'ask-screen') askedForScreen(m.asker, m.id);
      else if (m.kind === 'tile') tileOpened(m);
      else if (m.kind === 'tiles') {
        m.list.forEach((t) => { r.strip.show(t); r.newTiles?.forget(t.uri); if (t.live) r.live.setLive(t.uri, true); });
        r.live.hostConnected();
        followStage(m.list.find((t) => t.stage)?.uri || null, { quiet: true });
      } else if (m.kind === 'tile-live') r.live.setLive(m.uri, m.on);
      else if (m.kind === 'stage') followStage(m.uri);
      else { r.live.setLive(m.uri, false); r.strip.remove(m.uri); if (r.stageTile === m.uri) followStage(null, { quiet: true }); }
    } else if (m.kind === 'ask-answer') {
      const w = r.wishes.get(m.id);
      if (!w || w.wish !== 'see-screen' || w.target !== from) return;
      const who = nameOf(from);
      dropWish(m.id, { yes: `${who} is choosing what to share\u2026`, no: `${who} said not now.`, busy: `${who} can't share right now (someone is presenting).`, already: `${who} is already sharing.` }[m.answer]);
    }
  }

  const describe = (m) => ({
    'ask-answer': () => `ask-answer ${m.answer}`,
    presenting: () => `presenting ${m.on ? 'on' : 'off'}`,
    wish: () => `wish ${m.wish}${m.target ? ` (${whose(m.target)} screen)` : ''}`,
    'wish-result': () => `wish-result ${m.decision}${m.reason ? `: ${m.reason}` : ''}`,
    'ask-screen': () => `ask-screen for ${nameOf(m.asker)}`,
    tile: () => `tile ${m.uri.split('/').pop()} (opened by ${nameOf(m.by)})`,
    tiles: () => `tiles (${m.list.length})`,
    'tile-close': () => `tile-close ${m.uri.split('/').pop()}`,
    'tile-live': () => `tile-live ${m.on ? 'on' : 'off'} ${m.uri.split('/').pop()}`,
    stage: () => `stage ${m.uri ? m.uri.split('/').pop() : 'none'}`,
  }[m.kind] || (() => m.kind))();

  const whose = (peer) => (peer === room?.me ? 'your' : `${nameOf(peer)}\u2019s`);
  const hostPeer = () => [...(room?.people.values() || [])].find((p) => p.host) || null;
  const hostHere = () => { const hp = hostPeer(); return !!hp && !hp.away; };

  // ---- Wishes: asking (anyone) ----
  function wish(kind, target = null, uri = null, cid = null) {
    const r = room;
    if (!r || !r.link.joined || r.wishes.size) return;
    const screens = kind === 'see-screen' || kind === 'present';
    if (screens && r.screenTrack) return;
    if (screens && r.presenter && r.presenter !== r.me) { say(`${nameOf(r.presenter)} is presenting. One screen at a time.`); return; }
    const hp = hostPeer();
    if (!hp || hp.away) { say('Waiting for the host to come back.'); return; }
    const id = newRoomCode();
    const waitMs = kind === 'open-tile' || kind === 'live' ? tileAskMs() + o.times.askTimeoutMs : o.times.askTimeoutMs * 2;
    r.wishes.set(id, { wish: kind, target, uri, stage: 'host', timer: setTimeout(() => dropWish(id, 'No answer.'), waitMs) });
    const w = { kind: 'wish', id, wish: kind, ...(target ? { target } : {}), ...(uri ? { uri } : {}), ...(cid ? { cid } : {}) };
    if (r.host) { if (kind === 'open-tile') say('Opening the tile for everyone\u2026'); if (kind === 'live') say('Sharing the tile live\u2026'); handleWish(r.me, w); }
    else {
      r.link.to(hp.peer, w);
      note('→', hp.peer, describe(w));
      say(kind === 'see-screen' ? `Asked the host if you can see ${nameOf(target)}\u2019s screen\u2026`
        : kind === 'open-tile' ? 'Asked the host to open the tile for everyone\u2026'
        : kind === 'live' ? 'Asked the host to share the tile live\u2026' : 'Asked the host if you can present\u2026');
      if (kind === 'open-tile') r.strip.noteOn(uri, 'Asked the host\u2026');
    }
    renderPeople();
  }

  function dropWish(id, why) {
    const r = room;
    const w = r?.wishes.get(id);
    if (!w) return;
    clearTimeout(w.timer);
    r.wishes.delete(id);
    if (why) say(why);
    if (why && w.wish === 'open-tile') r.strip.noteOn(w.uri, why);
    render();
  }

  function wishResult(id, decision, reason) {
    const r = room;
    const w = r.wishes.get(id);
    if (!w) return;
    if (decision === 'deny') return dropWish(id, reason || 'The host said no.');
    if (w.wish === 'open-tile') return dropWish(id, r.host ? 'Opened for everyone.' : 'The host opened the tile for everyone.');
    if (w.wish === 'live') return dropWish(id, r.host ? 'Shared live with the room.' : 'The host shared the tile live with the room.');
    if (w.wish === 'see-screen') {
      w.stage = 'person';
      say(r.host ? `Asked ${nameOf(w.target)}\u2026` : `The host allowed it. Waiting for ${nameOf(w.target)}\u2026`);
    } else w.stage = 'go';
    renderPeople();
  }

  // "You may present": the person still chooses, with a click (the picker only opens from one). Only the
  // host's own request, decided on the spot on their own page, goes straight on from the click that made it;
  // anyone else gets the prompt, however quickly the host allowed it (no picker popping up out of the blue).
  function goAhead(id, { ownClick = false } = {}) {
    const r = room;
    const w = r.wishes.get(id);
    if (!w || w.wish !== 'present') return;
    dropWish(id, null);
    if (r.presenter && r.presenter !== r.me) { say(`${nameOf(r.presenter)} is presenting. One screen at a time.`); return; }
    if (ownClick && o.activation()) { startShare(null); return; }       // the host's own click, still fresh
    say('The host said you can present.');
    openPrompt({ type: 'go', id });
  }

  // ---- Wishes: the host's page decides (with the house) ----
  function houseState() {
    const r = room;
    return {
      host: r.me, presenter: r.presenter || null,
      // verified: yes/no only (step 8, decision 7): never a handle's proof or a DID. Today's rule set ignores it.
      peers: [...r.people.values()].map((p) => ({ peer: p.peer, name: p.name, host: !!p.host, verified: !!p.verified, ...(p.away ? { away: true } : {}) })),
    };
  }

  function startHouse() {
    const r = room;
    if (r.house) return;
    r.house = createHouseBridge({
      makeFrame: o.loadHouse, mount: r.els.houseMount, times: o.houseTimes,
      onLog: (what, text) => note('\u2302', null, text),
      onStatus: () => renderHouse(),
    });
    r.house.start();
    renderHouse();
  }

  function stopHouse() {
    const r = room;
    if (!r?.house) return;
    r.house.stop();
    r.house = null;
    renderHouse();
  }

  async function handleWish(from, wIn) {
    let w = wIn;
    const r = room;
    const asker = r.people.get(from);
    if (!r.host || !asker || asker.away) return;
    if (r.hostWishes.has(from)) return result(from, w.id, 'deny', 'One request at a time.');
    r.hostWishes.set(from, w.id);
    if (w.wish === 'open-tile') {
      const no = (why) => { r.hostWishes.delete(from); result(from, w.id, 'deny', why); };
      const full = tilesFull(w.uri);
      if (full) return no(full);
      const rec = await records.read(w.uri);
      if (room !== r || r.over) return;
      if (!rec.ok) return no(rec.why);
      if (w.cid && rec.cid !== w.cid) return no('That tile changed since it was previewed. Preview it again.');
      let hidden = false;
      try { hidden = await hideCheck.isHidden(rec.did, rec.rkey); } catch { hidden = false; }
      if (room !== r || r.over) return;
      if (hidden) return no('That tile isn\u2019t shown here.');
      w = { ...w, uri: rec.uri, rec };
    }
    if (w.wish === 'live') {
      const t = r.roomTiles.find((x) => x.uri === w.uri);
      const no = (why) => { r.hostWishes.delete(from); result(from, w.id, 'deny', why); };
      if (!t) return no('That tile isn\u2019t open for everyone.');
      if (t.live) return no('That tile is already shared live.');
      w = { ...w, name: r.strip.name(w.uri) || 'the tile' };
    }
    const d = await r.house.decide(houseState(), { by: from, wish: w.wish, ...(w.target ? { target: w.target } : {}), ...(w.uri ? { uri: w.uri } : {}) });
    if (room !== r || r.over) return;
    note('\u2302', from, `${w.wish}${w.target ? ` (${whose(w.target)} screen)` : ''}${w.rec ? ` ("${w.rec.name}")` : ''}${w.name ? ` ("${w.name}")` : ''}: ${d.decision} \u2014 ${d.reason}${d.unknown ? ' (the house doesn\u2019t decide this; the page does)' : d.by === 'page' ? ' (no house)' : ''}`);
    if (d.decision === 'deny') { r.hostWishes.delete(from); return result(from, w.id, 'deny', d.reason); }
    if (d.decision === 'allow' || from === r.me) return carry(from, w);
    openApproval(from, w, d);
  }

  function openApproval(from, w, d) {
    const r = room;
    const key = `${from} ${w.id}`;
    const text = w.wish === 'see-screen'
      ? (w.target === r.me ? `${nameOf(from)} asks to see your screen.` : `${nameOf(from)} asks to see ${nameOf(w.target)}\u2019s screen.`)
      : w.wish === 'open-tile' ? `${nameOf(from)} asks to open \u201c${w.rec.name}\u201d for everyone.`
      : w.wish === 'live' ? `${nameOf(from)} asks to share \u201c${w.name}\u201d live with the room.`
      : `${nameOf(from)} asks to present their screen.`;
    const after = w.wish === 'see-screen' ? `${w.target === r.me ? 'you' : nameOf(w.target)} still choose${w.target === r.me ? '' : 's'} whether to share`
      : w.wish === 'open-tile' ? 'each person\u2019s page checks the tile and opens its own copy'
      : w.wish === 'live' ? 'every copy of it sends what people do in it to the others (through your page, directly between the computers; nothing is kept)'
      : `${nameOf(from)} still chooses what to share`;
    const el = h('div', { class: 'rl-approval', role: 'alertdialog', 'data-from': from },
      h('p', { class: 'rl-prompt-q' }, text),
      h('p', { class: 'rl-help' }, `${d.by === 'house' ? 'House' : d.unknown ? 'This page' : 'No house'}: ${d.reason} If you allow it, ${after}.`),
      h('div', { class: 'rl-actions' },
        h('button', { type: 'button', class: 'rl-primary', onclick: () => allow() }, 'Allow'),
        h('button', { type: 'button', onclick: () => deny() }, 'Deny'),
        w.wish === 'open-tile' ? h('button', { type: 'button', class: 'rl-approval-preview', onclick: () => previewRequest() }, 'Preview') : null));
    const allow = () => { closeApproval(key, { keepPreview: true }); carry(from, w); };
    const deny = () => { closeApproval(key); r.hostWishes.delete(from); result(from, w.id, 'deny', 'The host said no.'); };
    // The host runs the asked-for tile privately first, at the version asked for; Allow sends that version,
    // and the preview becomes the host's card in place.
    const previewRequest = () => {
      const a = r.approvals.get(key);
      if (!a) return;
      a.previewing = true;
      r.strip.preview(w.uri, { cid: w.rec.cid, buttons: [
        { text: 'Allow', cls: 'rl-primary rl-tile-allow', onclick: () => allow() },
        { text: 'Deny', cls: 'rl-tile-deny', onclick: () => deny() },
      ] });
      r.strip.noteOn(w.uri, `${nameOf(from)} asks to open this for everyone.`);
    };
    r.approvals.set(key, { from, w, el, timer: setTimeout(() => {
      if (!r.approvals.has(key)) return;
      closeApproval(key); r.hostWishes.delete(from); result(from, w.id, 'deny', 'The host didn\u2019t answer.');
    }, w.wish === 'open-tile' ? tileAskMs() : o.times.askTimeoutMs) });
    r.els.approvals.append(el);
    say(text);
  }

  function closeApproval(key, { keepPreview = false } = {}) {
    const r = room;
    const a = r?.approvals.get(key);
    if (!a) return;
    clearTimeout(a.timer);
    if (a.previewing && !keepPreview) r.strip.removePreview(a.w.uri);
    a.el.remove();
    r.approvals.delete(key);
  }

  // Allowed: the request goes on to the person it's about. Nothing is shared until they click.
  function carry(from, w) {
    const r = room;
    r.hostWishes.delete(from);
    const here = (p) => r.people.has(p) && !r.people.get(p).away;
    if (!here(from)) return;
    if (w.wish === 'open-tile') {
      const full = tilesFull(w.uri);
      if (full) return result(from, w.id, 'deny', full);
      result(from, w.id, 'allow', '');
      return openForEveryone({ uri: w.uri, cid: w.rec.cid, by: from });
    }
    if (w.wish === 'live') {
      if (!r.roomTiles.some((t) => t.uri === w.uri)) return result(from, w.id, 'deny', 'That tile isn\u2019t open for everyone any more.');
      result(from, w.id, 'allow', '');
      return liveForEveryone(w.uri, true);
    }
    if (w.wish === 'see-screen' && !here(w.target)) return result(from, w.id, 'deny', 'They\u2019re not in the room any more.');
    if (r.presenter) return result(from, w.id, 'deny', 'Someone is presenting. One screen at a time.');
    result(from, w.id, 'allow', '');
    if (w.wish === 'see-screen') {
      if (w.target === r.me) askedForScreen(from, w.id);
      else { r.link.to(w.target, { kind: 'ask-screen', id: w.id, asker: from }); note('\u2192', w.target, `ask-screen for ${nameOf(from)}`); }
    } else if (from === r.me) goAhead(w.id, { ownClick: true });
    else { r.link.to(from, { kind: 'go-ahead', id: w.id }); note('\u2192', from, 'go-ahead'); }
  }

  function result(to, id, decision, reason) {
    const r = room;
    if (to === r.me) return wishResult(id, decision, reason);
    r.link.to(to, { kind: 'wish-result', id, decision, reason });
    note('\u2192', to, `wish-result ${decision}${reason ? `: ${reason}` : ''}`);
  }

  // ---- Tiles opened for everyone ----
  const tileAskMs = () => o.times.tileAskTimeoutMs ?? o.times.askTimeoutMs * 3;
  const canAskTile = () => { const r = room; return !!r?.link?.joined && r.wishes.size === 0 && hostHere(); };

  // The address box only previews: the tile runs on this page alone, after the same checks as everyone's.
  // It takes the forms Raku takes (address.js): at:// with a handle or a DID, the viewers' links, webtil.es,
  // tile://. A handle is turned into its DID here, on the page that pasted it (checked both ways); the room
  // only ever sends the DID form.
  async function previewTile() {
    const r = room;
    const a = parseAddress(r.els.tileInput.value);
    if (!a.ok) { say(a.reason); return; }
    let did = a.actor;
    if (!a.actor.startsWith('did:')) {
      say(`Looking up @${a.actor}\u2026`);
      r.els.tileButton.disabled = true;
      const d = await records.didFor(a.actor);
      if (room !== r || r.over) return;
      r.els.tileButton.disabled = !r.link?.joined;
      if (!d.ok) { say(d.why); return; }
      did = d.did;
      say('');
    }
    const uri = `at://${did}/ing.dasl.masl/${a.rkey}`;
    if (!parseTileUri(uri)) { say(HINT); return; }
    if (r.strip.isShared(uri)) { say('That tile is already open for everyone.'); return; }
    r.els.tileInput.value = '';
    previewUri(uri);
  }

  // The private preview (step 4b), from a pasted address or from the new-tile offer (0.10.0): the same either way.
  function previewUri(uri) {
    const r = room;
    if (!r || r.over || !parseTileUri(uri)) return;
    if (r.strip.isShared(uri)) { say('That tile is already open for everyone.'); return; }
    r.newTiles?.forget(uri);
    r.strip.preview(uri, { buttons: [
      { text: r.host ? 'Open for everyone' : 'Ask to open for everyone', cls: 'rl-primary rl-tile-open', needsOpen: true,
        disabled: () => !canAskTile(), onclick: (e) => wish('open-tile', null, e.uri, e.cid) },
      { text: 'Cancel', cls: 'rl-tile-cancel', onclick: (e) => r.strip.removePreview(e.uri) },
    ] });
  }

  // ---- New tiles (0.10.0; claude/rooms-new-tile-offer-plan.md) ----
  // Signed in only: this page looks at its own account's newest tile records when the room's tab becomes visible
  // again, and every 30 s while visible (not while an offer waits). Nobody else hears of them.
  function startNewTiles(r) {
    const doc = globalThis.document;
    r.newTiles = createNewTileWatcher({
      did: r.did, since: r.joinedAt,
      list: (d) => records.recent(d, NEW_TILE_LIST),
      skip: (uri) => r.strip.has(uri),
      onOffer: (tiles) => renderOffer(r, tiles),
      isVisible: () => !doc || doc.visibilityState !== 'hidden',
      pollMs: o.times.newTilePollMs ?? NEW_TILE_POLL_MS,
    });
    r.onVisible = () => { if (room === r && !r.over && doc.visibilityState === 'visible') r.newTiles.visible(); };
    doc?.addEventListener('visibilitychange', r.onVisible);
  }

  function renderOffer(r, tiles) {
    if (room !== r || r.over) return;
    const box = r.els.offer;
    const w = offerWords(tiles);
    if (!w) { box.hidden = true; box.replaceChildren(); r.offerOpen = false; return; }
    const preview = (t) => { r.newTiles.take(t.uri); previewUri(t.uri); };
    const more = w.more
      ? [' and ', h('button', { type: 'button', class: 'rl-offer-more', 'aria-expanded': String(r.offerOpen),
          onclick: () => { r.offerOpen = !r.offerOpen; renderOffer(r, r.newTiles.offered); } }, `+${w.more} more`)]
      : [];
    const list = w.more && r.offerOpen
      ? h('ul', { class: 'rl-offer-list' }, ...tiles.slice(1).map((t) => h('li', {},
          h('span', { class: 'rl-offer-name' }, h('b', {}, t.name || 'A tile')),
          h('button', { type: 'button', class: 'rl-primary rl-offer-preview', onclick: () => preview(t) }, 'Preview it'))))
      : null;
    box.replaceChildren(
      h('span', { class: 'rl-offer-text' }, h('b', {}, w.name), ...more, w.tail),
      h('span', { class: 'rl-offer-actions' },
        h('button', { type: 'button', class: 'rl-primary rl-offer-preview', onclick: () => preview(tiles[0]) }, 'Preview it'),
        h('button', { type: 'button', class: 'rl-offer-no', onclick: () => r.newTiles.notNow() }, 'Not now')),
      ...(list ? [list] : []));
    box.hidden = false;
  }

  function tilesFull(uri) {
    const r = room;
    if (r.roomTiles.some((t) => t.uri === uri)) return 'That tile is already open for everyone.';
    if (r.roomTiles.length >= MAX_TILES) return `The strip is full (${MAX_TILES} tiles). Close one first.`;
    return null;
  }

  // The host's page: open it on every page (each checks it for itself).
  function openForEveryone(t) {
    const r = room;
    r.roomTiles.push(t);
    saveTiles();
    r.link.all({ kind: 'tile', ...t });
    note('\u2192', null, `tile ${t.uri.split('/').pop()} (opened by ${nameOf(t.by)})`);
    tileOpened(t);
    if (t.by === r.me) setStage(t.uri);          // the host's own tile goes on the stage; anyone else's to the list
  }

  // The host's page keeps its tiles (and which one is on the stage) for a reload of this tab.
  function saveTiles() {
    const r = room;
    put(o.session, tilesKey(r.code), JSON.stringify(tilesList()));
  }
  const tilesList = () => room.roomTiles.map((t) => ({ ...t, ...(t.uri === room.stageTile ? { stage: true } : {}) }));

  function closeForEveryone(uri) {
    const r = room;
    if (!r?.host) return;
    r.roomTiles = r.roomTiles.filter((t) => t.uri !== uri);
    if (r.stageTile === uri) { r.stageTile = null; r.strip.setStaged(null); }   // every page clears it on tile-close
    saveTiles();
    r.link.all({ kind: 'tile-close', uri });
    note('\u2192', null, `tile-close ${uri.split('/').pop()}`);
    r.live.setLive(uri, false);
    r.strip.remove(uri);
  }

  // The host's page: a tile shared live with the room, or not any more (its copies keep what they have).
  function liveForEveryone(uri, on) {
    const r = room;
    if (!r?.host) return;
    const t = r.roomTiles.find((x) => x.uri === uri);
    if (!t || !!t.live === on) return;
    if (on) t.live = true; else delete t.live;
    saveTiles();
    r.link.all({ kind: 'tile-live', uri, on });
    note('\u2192', null, `tile-live ${on ? 'on' : 'off'} ${uri.split('/').pop()}`);
    r.live.setLive(uri, on);
    say(on ? 'Shared live with the room.' : 'Stopped sharing live. Each copy keeps what it has.');
  }

  // A tile opened for everyone: into the strip (the host's page then decides whether it goes on the stage).
  function tileOpened(t) {
    room.strip.show(t);
    room.newTiles?.forget(t.uri);
  }

  // ---- The stage (step 9) ----
  // The host's page: put a tile on the stage (or none), and tell everyone.
  function setStage(uri) {
    const r = room;
    if (!r?.host) return;
    if (uri && !r.roomTiles.some((t) => t.uri === uri)) return;
    if (uri === r.stageTile) return;
    const was = r.stageTile;
    r.stageTile = uri;
    saveTiles();
    r.link.all({ kind: 'stage', uri });
    note('\u2192', null, `stage ${uri ? uri.split('/').pop() : 'none'}`);
    stageChanged(was, 'You');
  }
  // Every other page: follow the host's page.
  function followStage(uri, { quiet = false } = {}) {
    const r = room;
    if (uri === r.stageTile) return;
    const was = r.stageTile;
    r.stageTile = uri;
    stageChanged(was, shown(hostPeer()), { quiet });
  }
  function stageChanged(was, who, { quiet = false } = {}) {
    const r = room;
    r.strip.setStaged(r.stageTile);
    r.stageSaid = null;
    if (!quiet) {
      if (r.stageTile) { say(stageLines.put(who, r.strip.name(r.stageTile))); r.stageSaid = { uri: r.stageTile, who }; }
      else if (r.presenter) say(stageLines.back(r.presenter === r.me ? 'your' : `${nameOf(r.presenter)}\u2019s`));
      else say(stageLines.left(was ? r.strip.name(was) : null));
    }
    render();
  }
  // The host's page: someone new started sharing a screen, so the screen takes the stage.
  function hostPresenterChanged(before, after) {
    const r = room;
    const next = afterPresenterChange(r.stageTile, before, after);
    if (next !== r.stageTile) {
      r.stageTile = next;
      saveTiles();
      r.link.all({ kind: 'stage', uri: next });
      note('\u2192', null, 'stage none (a screen is shared)');
      r.strip.setStaged(next);
    }
  }

  // Lay the staged tile's card over the stage's box (the card stays where it is in the page: never moved).
  function placeStaged() {
    const r = room;
    if (!r) return;
    const el = r.stageTile ? r.strip.elementOf(r.stageTile) : null;
    if (!el) return;
    const box = r.els.stage.getBoundingClientRect();
    const base = r.els.section.getBoundingClientRect();
    const px = (n) => `${Math.round(n)}px`;
    el.style.position = 'absolute';
    el.style.top = px(box.top - base.top);
    el.style.left = px(box.left - base.left);
    el.style.width = px(box.width);
    el.style.height = px(box.height);
  }

  function toggleScreenFull() {
    const r = room;
    const doc = r.els.stage.ownerDocument;
    if (fullScreenNow(doc) === r.els.stage) { leaveFullScreen(doc); return; }
    const go = fullScreenCall(r.els.stage, r.els.video);
    if (go) Promise.resolve().then(go).catch(() => say('Full screen wasn\u2019t allowed.'));
  }

  // The host back after a reload (or a relay restart): the tiles they had open, for everyone again. A reload
  // gives this page a new peer id, so tiles it opened under its old one are its own again ("opened by You",
  // and the host's name on everyone else's page), not "opened by Someone".
  function hostTilesBack(before = null) {
    const r = room;
    if (!r.roomTiles.length) {
      try { const kept = JSON.parse(get(o.session, tilesKey(r.code)) || '[]'); if (Array.isArray(kept)) r.roomTiles = kept.filter((t) => t && parseTileUri(t.uri) && t.cid).slice(0, MAX_TILES); } catch { /* none */ }
    }
    if (!r.roomTiles.length) {
      // Nothing to bring back (another device, say): the stage is empty for everyone, as on this page.
      if (r.stageTile) r.stageTile = null;
      r.link.all({ kind: 'stage', uri: null });
      return;
    }
    if (before && before !== r.me) {
      let mine = false;
      for (const t of r.roomTiles) if (t.by === before) { t.by = r.me; mine = true; }
      if (mine) put(o.session, tilesKey(r.code), JSON.stringify(r.roomTiles));   // (stage flags kept as they were)
    }
    const staged = r.roomTiles.find((t) => t.stage)?.uri || r.stageTile;
    r.roomTiles = r.roomTiles.map(({ stage, ...t }) => t);
    r.roomTiles.forEach((t) => { r.strip.show(t); if (t.live) r.live.setLive(t.uri, true); });
    r.stageTile = staged && r.roomTiles.some((t) => t.uri === staged) ? staged : null;
    r.strip.setStaged(r.stageTile);
    r.link.all({ kind: 'tiles', list: tilesList() });
  }

  // ---- Someone asks to see my screen (the host allowed it, or it's the host asking) ----
  function askedForScreen(asker, id) {
    const r = room;
    const a = r.people.get(asker);
    if (!a || a.away || asker === r.me) return;
    if (r.screenTrack) return answer(asker, id, 'already');
    if (r.presenter || r.prompt) return answer(asker, id, 'busy');
    openPrompt({ type: 'ask', from: asker, id });
  }

  function answer(to, id, ans) {
    room.link.to(to, { kind: 'ask-answer', id, answer: ans });
    note('→', to, `ask-answer ${ans}`);
  }

  // The prompt: the person's own decision ("ask": someone asks to see my screen; "go": the host said I may
  // present). Either way the next click opens the browser's picker.
  function openPrompt(pr) {
    const r = room;
    const others = [...r.people.values()].filter((p) => p.peer !== r.me && !p.away).length;
    const shareWith = `${others} ${others === 1 ? 'person' : 'people'}`;
    r.prompt = { ...pr, timer: setTimeout(() => { if (r.prompt?.id === pr.id) { if (pr.type === 'ask') answer(pr.from, pr.id, 'no'); closePrompt(); } }, o.times.askTimeoutMs) };
    const hp = hostPeer();
    const q = pr.type === 'ask' ? `${nameOf(pr.from)} asks to see your screen. Share with ${shareWith}?` : `The host said you can present. Share with ${shareWith}?`;
    const allowed = pr.type === 'ask' && hp && pr.from !== hp.peer && !r.host ? ' The host allowed this request; you decide.' : '';
    const p = r.els.prompt;
    p.replaceChildren(
      h('p', { class: 'rl-prompt-q' }, q),
      h('p', { class: 'rl-help' }, `Everyone here will see it. Pick one window or tab, not the whole screen, and close anything private first. You can stop at any time.${allowed}`),
      h('div', { class: 'rl-actions' },
        h('button', { type: 'button', class: 'rl-primary', onclick: () => startShare(r.prompt) }, 'Choose what to share\u2026'),
        h('button', { type: 'button', onclick: () => { if (r.prompt) { if (r.prompt.type === 'ask') answer(r.prompt.from, r.prompt.id, 'no'); closePrompt(); } } }, 'Not now')),
    );
    p.hidden = false;
    renderControls();
  }

  function closePrompt() {
    const r = room;
    if (!r?.prompt) return;
    clearTimeout(r.prompt.timer);
    r.prompt = null;
    r.els.prompt.hidden = true;
    r.els.prompt.replaceChildren();
    if (!r.over) renderControls();
  }

  // ---- Sharing: only ever from this person's own click ----
  async function startShare(fromPrompt) {
    const r = room;
    if (!r || r.screenTrack) return;
    if (r.presenter && r.presenter !== r.me) { say(`${nameOf(r.presenter)} is presenting. One screen at a time.`); return; }
    const asked = fromPrompt && fromPrompt.type === 'ask' ? { ...fromPrompt } : null;
    closePrompt();
    if (asked) answer(asked.from, asked.id, 'yes');
    let stream;
    try {
      stream = await o.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 15, max: 30 } }, audio: false,
        selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
      });
    } catch (e) {
      say(e?.name === 'NotAllowedError' ? 'Not sharing (the picker was closed).' : `The browser couldn't share the screen (${e?.name || 'error'}).`);
      return;
    }
    if (room !== r || r.over) { stream.getTracks().forEach((t) => t.stop()); return; }
    if (r.presenter && r.presenter !== r.me) { stream.getTracks().forEach((t) => t.stop()); say(`${nameOf(r.presenter)} started presenting first.`); return; }
    const track = stream.getVideoTracks()[0];
    try { track.contentHint = 'detail'; } catch { /* old browser */ }
    track.addEventListener('ended', () => stopShare('You stopped sharing.'));      // the browser's own "Stop sharing"
    r.screenTrack = track; r.screenStream = stream;
    const before = r.presenter;
    r.presenter = r.me;
    if (r.host) hostPresenterChanged(before, r.me);
    r.mesh.setScreen(track, stream);
    r.link.all({ kind: 'presenting', on: true });
    note('→', null, 'presenting on');
    say(r.stageTile ? "You're sharing your screen. A tile is on the stage; the host can switch back to your screen." : "You're sharing your screen with everyone here.");
    render();
  }

  function stopShare(why, { tell = true } = {}) {
    const r = room;
    if (!r || !r.screenTrack) return;
    const t = r.screenTrack;
    r.screenTrack = null; r.screenStream = null;
    try { t.stop(); } catch { /* stopped */ }
    r.mesh.setScreen(null, null);
    if (r.presenter === r.me) r.presenter = null;
    if (tell && !r.over) { r.link.all({ kind: 'presenting', on: false }); note('→', null, 'presenting off'); }
    if (why) say(why);
    render();
  }

  // ---- The microphone: off on joining; the browser asks the first time you unmute ----
  async function toggleMic() {
    const r = room;
    r.levels.resume();
    if (!r.micTrack) {
      try {
        const s = await o.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        if (room !== r || r.over) { s.getTracks().forEach((t) => t.stop()); return; }
        r.micStream = s; r.micTrack = s.getAudioTracks()[0];
        r.mesh.setMic(r.micTrack, s);
        r.levels.watch(r.me, s);
        r.muted = false;
      } catch (e) {
        say(e?.name === 'NotAllowedError' ? "The browser didn't allow the microphone. You can still listen." : `No microphone (${e?.name || 'error'}).`);
        return;
      }
    } else r.muted = !r.muted;
    r.micTrack.enabled = !r.muted;
    render();
  }

  // ---- What arrives from the others ----
  function remoteTrack(peer, track, stream) {
    const r = room;
    if (!r) return;
    const x = r.remote.get(peer) || {};
    r.remote.set(peer, x);
    if (track.kind === 'audio') {
      x.voice = stream;
      if (!x.audio) { x.audio = h('audio', { autoplay: true, 'data-peer': peer }); r.els.audio.append(x.audio); }
      x.audio.srcObject = stream;
      x.audio.play?.().catch(() => {});
      r.levels.watch(peer, stream);
    } else if (track.kind === 'video') {
      x.screen = stream;
      track.addEventListener('unmute', () => renderStage());
      track.addEventListener('ended', () => renderStage());
    }
    renderStage();
  }

  function forgetRemote(peer) {
    const r = room;
    const x = r?.remote.get(peer);
    if (!x) return;
    r.remote.delete(peer);
    r.levels.unwatch(peer);
    if (x.audio) { x.audio.srcObject = null; x.audio.remove(); }
    renderStage();
  }

  // ---- Drawing ----
  function render() {
    renderControls(); renderStage(); renderPeople();
    if (room?.house) room.house.setState(houseState());
  }

  function renderHouse() {
    const r = room;
    if (!r) return;
    const line = r.els.houseLine;
    line.hidden = !r.host;
    const st = r.house?.status;
    // The owner's words (0.11.1, claude/raku-rooms-plan.md RR14); the rule set's own name stays in the log.
    line.textContent = st === 'ready' ? HOUSE_LINES.ready : st === 'loading' ? HOUSE_LINES.loading : HOUSE_LINES.none;
    line.dataset.house = st || 'off';
    if (st === 'ready' && r.house.frame) r.house.setState(houseState());
  }

  function renderControls() {
    const r = room;
    if (!r) return;
    const { mic, share, hostTools, leave: leaveBtn } = r.els;
    mic.textContent = !r.micTrack || r.muted ? 'Unmute' : 'Mute';
    mic.setAttribute('aria-pressed', String(!!r.micTrack && !r.muted));
    const other = r.presenter && r.presenter !== r.me;
    const asking = [...r.wishes.values()].some((w) => w.wish === 'present');
    share.textContent = r.screenTrack ? 'Stop sharing' : other ? `${nameOf(r.presenter)} is presenting` : asking ? 'Asked the host\u2026' : 'Share my screen';
    share.disabled = !r.screenTrack && r.prompt?.type !== 'go' && (!!other || !r.link?.joined || r.wishes.size > 0 || !hostHere());
    hostTools.hidden = !r.host;
    r.els.tileButton.disabled = !r.link?.joined;
    r.strip?.refresh();
    leaveBtn.hidden = r.host;
  }

  function renderStage() {
    const r = room;
    if (!r) return;
    const { video, caption, stageBadge, full, emptyLine, emptyHint, empty } = r.els;
    const mine = r.presenter === r.me && r.screenStream;
    const remote = r.presenter && !mine ? r.remote.get(r.presenter)?.screen : null;
    const remoteLive = !!remote && remote.getVideoTracks().some((t) => t.readyState === 'live');
    const card = !r.stageTile ? 'missing' : r.strip.elementOf(r.stageTile) ? 'card' : r.strip.wasHidden(r.stageTile) ? 'hidden' : 'missing';
    const what = whatsOnStage({ tile: r.stageTile, card, presenter: r.presenter, screenLive: !!mine || remoteLive });
    const stream = what === 'screen' ? (mine ? r.screenStream : remote) : null;
    if (video.srcObject !== stream) { video.srcObject = stream; if (stream) video.play?.().catch(() => {}); }
    video.hidden = !stream;
    const tileName = r.stageTile ? (r.strip.name(r.stageTile) || 'a tile') : '';
    const tileBy = r.stageTile ? r.strip.by(r.stageTile) : null;
    const badge = what === 'screen' || what === 'waiting' ? 'Screen' : what.startsWith('tile') ? 'Tile' : null;
    stageBadge.textContent = badge || '';
    stageBadge.hidden = !badge;
    stageBadge.className = `rl-stage-badge${badge === 'Tile' ? ' rl-stage-badge-tile' : badge === 'Screen' ? ' rl-stage-badge-screen' : ''}`;
    caption.textContent = {
      screen: mine ? 'Your screen (everyone here sees it)' : `${nameOf(r.presenter)}\u2019s screen`,
      waiting: `Waiting for ${nameOf(r.presenter)}\u2019s screen\u2026`,
      tile: `${tileName}${tileBy ? ` \u00b7 opened by ${nameOf(tileBy)}` : ''}`,
      'tile-hidden': `${tileName} (hidden on your page)`,
      'tile-coming': 'Opening the tile on the stage\u2026',
      empty: '',
    }[what];
    emptyLine.textContent = {
      waiting: `Waiting for ${nameOf(r.presenter)}\u2019s screen\u2026`,
      'tile-hidden': 'You hid the tile on the stage. It\u2019s still on the stage for everyone else.',
      'tile-coming': 'Opening the tile on the stage\u2026',
      empty: EMPTY_LINE,
    }[what] || '';
    emptyHint.textContent = what === 'empty' ? (r.host ? EMPTY_HINT_HOST : EMPTY_HINT_GUEST) : '';
    empty.hidden = what === 'screen' || what === 'tile';
    const doc = r.els.stage.ownerDocument;
    full.hidden = what !== 'screen' || !fullScreenCall(r.els.stage, video);
    full.textContent = fullScreenNow(doc) === r.els.stage ? 'Exit full screen' : 'Full screen';
    r.els.stage.dataset.on = what;
    r.els.stage.classList.toggle('rl-empty', what !== 'screen');
    placeStaged();                 // first at the stage's width (the card's header wraps as it will there)…
    shapeStage(what);              // …so its measured header is right for the tall phone stage…
    placeStaged();                 // …then over the stage's final size
  }

  // Step 9b: on a phone held upright, a tile on the stage gets a tall box: the tile's own declared height (as in
  // the list, where it's fully visible), at least the usual 16:9, at most about three-quarters of the screen.
  // A screen and the empty stage keep 16:9; laptops, tablets in landscape and phones turned sideways too.
  function shapeStage(what) {
    const r = room;
    const area = r.els.area;
    const upright = !!globalThis.matchMedia?.(PHONE_UPRIGHT)?.matches;
    const card = what === 'tile' ? r.strip.elementOf(r.stageTile) : null;
    r.els.stage.classList.toggle('rl-stage-tall', !!(upright && card));
    if (!upright || !card) { area.style.removeProperty('height'); area.style.removeProperty('aspect-ratio'); return; }
    const w = r.els.stage.clientWidth;
    const bar = r.els.stage.querySelector('.rl-stage-bar')?.offsetHeight || 40;
    const body = card.querySelector('.rl-tile-body');
    const chrome = Math.max(40, Math.round(card.getBoundingClientRect().height - (body?.getBoundingClientRect().height || 0)));
    const tileH = Math.max(200, Math.min(700, r.strip.sizing(r.stageTile)?.height || 480));
    const least = Math.round(w * 9 / 16) + bar;
    const most = Math.max(least, Math.round((globalThis.innerHeight || 800) * 0.75));
    const total = Math.min(most, Math.max(least, tileH + chrome));
    area.style.aspectRatio = 'auto';
    area.style.height = `${total - bar}px`;
  }

  function renderPeople() {
    const r = room;
    if (!r) return;
    const rows = [...r.people.values()].map((p) => {
      const mine = p.peer === r.me;
      const conn = mine || p.away ? null : r.conn.get(p.peer) || 'new';
      const connText = { new: 'connecting…', connecting: 'connecting…', connected: null, disconnected: 'connection unsteady…', failed: r.ice.state === 'on' ? "couldn't connect" : "couldn't connect directly", closed: null }[conn] ?? null;
      const way = conn === 'connected' ? r.route.get(p.peer) : null;
      const asked = [...r.wishes.values()].some((w) => w.target === p.peer);
      return h('li', { class: 'rl-person', 'data-peer': p.peer },
        h('span', { class: `rl-dot${r.talking.has(p.peer) ? ' rl-talking' : ''}`, title: r.talking.has(p.peer) ? 'talking' : '' }),
        h('span', { class: 'rl-who' }, ...whoLabel(p.name, !!p.verified)),
        mine ? h('span', { class: 'rl-tag' }, 'you') : null,
        p.host ? h('span', { class: 'rl-tag rl-tag-host' }, 'host') : null,
        p.away ? h('span', { class: 'rl-tag' }, 'away') : null,
        r.presenter === p.peer ? h('span', { class: 'rl-tag rl-tag-on' }, 'presenting') : null,
        r.talking.has(p.peer) ? h('span', { class: 'rl-tag' }, 'talking') : null,
        connText ? h('span', { class: 'rl-conn' }, connText) : null,
        way ? h('span', { class: `rl-tag rl-route${way === 'relay' ? ' rl-route-relay' : ''}`, title: way === 'relay' ? 'Your connection to this person goes through the TURN relay (still encrypted).' : 'Your connection to this person goes directly between the computers.' }, way === 'relay' ? 'via relay' : 'direct') : null,
        h('span', { class: 'rl-person-actions' },
          !mine && !p.away ? h('button', { type: 'button', class: 'rl-ask', disabled: asked || r.wishes.size > 0 || !!r.presenter || !r.link.joined || !hostHere(), onclick: () => wish('see-screen', p.peer) }, asked ? 'Asked\u2026' : 'Ask to see screen') : null,
          r.host && !mine ? h('button', { type: 'button', class: 'rl-remove rl-danger', onclick: () => r.link.remove(p.peer) }, 'Remove') : null),
      );
    });
    r.els.people.replaceChildren(...rows);
    r.els.people.setAttribute('data-count', String(r.people.size));
    renderControls();
  }

  // ---- Leaving ----
  function leave(why, { quiet = false, again = null, reason = null } = {}) {
    const r = room;
    if (!r) return;
    r.over = true;
    r.placer?.disconnect();
    r.newTiles?.stop();
    globalThis.document?.removeEventListener('visibilitychange', r.onVisible);
    globalThis.removeEventListener?.('resize', r.onResize);
    globalThis.document?.removeEventListener('fullscreenchange', r.onFull);
    globalThis.document?.removeEventListener('webkitfullscreenchange', r.onFull);
    if (globalThis.document && fullScreenNow(globalThis.document)) leaveFullScreen(globalThis.document);
    for (const t of r.iceTimers) { clearTimeout(t); clearInterval(t); }
    clearTimeout(r.iceRefresh);
    stopShare(null, { tell: !quiet });
    closePrompt();
    for (const w of r.wishes.values()) clearTimeout(w.timer);
    for (const a of r.approvals.values()) clearTimeout(a.timer);
    if (r.house) { r.house.stop(); r.house = null; }
    r.strip.clear();
    r.live.stop();
    if (r.micStream) r.micStream.getTracks().forEach((t) => t.stop());
    r.mesh.close();
    r.levels.close();
    r.link.stop();
    for (const x of r.remote.values()) if (x.audio) x.audio.srcObject = null;
    room = null;
    view.replaceChildren(h('section', { class: 'rl-over' },
      h('p', { class: 'rl-status', role: 'status' }, why),
      h('div', { class: 'rl-actions' },
        again ? h('button', { type: 'button', class: 'rl-primary rl-again', onclick: () => start('', again) }, again) : null,
        h('button', { type: 'button', class: again ? '' : 'rl-primary', onclick: () => {
          // The room's link is still in the address bar: take it out, so "Back to the start" starts fresh.
          if (ownAddress) { try { o.history?.replaceState(null, '', o.loc.pathname + o.loc.search); } catch { /* fine */ } }
          start();
        } }, 'Back to the start'))));
    try { o.onOver?.({ code: r.code, why, again, reason }); } catch (err) { console.error('[rooms-lab] onOver', err); }
  }

  start();
  return {
    // For the checks (and the console): what the page knows right now.
    get room() { return room; },
    // What the house is told about the room right now (the host's page): for the checks.
    get houseState() { return room ? houseState() : null; },
    leave: () => leave('You left the room.'),
  };
}
