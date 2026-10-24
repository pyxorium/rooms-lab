// room-page.js: the Rooms lab page (rooms-lab-plan.md, section 7): voice and one presenter's screen between
// 2 to 6 people (build step 2), with the house tile deciding who may ask (step 3). Framework-free, in Raku's
// plain style, so Raku can import it later (R3).
//
// mountRoomPage(root, options) draws the page into `root`:
// - the lobby: your name (typed, not checked), then "New room", "Join room" (from an invite link) or
//   "Rejoin as host" (this tab made the room, or opened the private host link);
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
import { connectRoom } from './room-link.js';
import { createMesh } from './mesh.js';
import { createLevels } from './levels.js';
import { readPeerData } from './messages.js';
import { afterAnnounce, afterPeople } from './presenting.js';
import { cleanName, newRoomCode, readRoomHash, inviteLink, hostLink } from './formats.js';
import { createHouseBridge } from './house-bridge.js';
import { createTileRecords, parseTileUri } from './tile-records.js';
import { createHideCheck } from './hide-check.js';
import { createTileStrip, MAX_TILES } from './tile-strip.js';
import { relayUrl, ICE_SERVERS, TIMES } from './config.js';
import { createLiveTiles, readPeerLive } from './live.js';

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

const NAME_KEY = 'rooms-lab-name';                 // localStorage: your typed name, for next time
const hostKeyKey = (room) => `rooms-lab-host:${room}`;   // sessionStorage: this tab's host key for a room
const tilesKey = (room) => `rooms-lab-tiles:${room}`;    // sessionStorage: the host's tiles open for everyone (a reload keeps them)

export const HONEST = [
  'This is a lab: a try-out, not a finished app.',
  'Names are typed by each person and not checked: anyone can type any name.',
  'Nothing is recorded or stored.',
  'The relay only introduces the people in a room and passes their messages; it stores nothing.',
  "Voice and screens go directly between the computers, encrypted by the browsers. To find each other, each computer asks a public STUN server (Google's or Cloudflare's) for its own address.",
  "Sharing only works on networks that allow direct connections (there's no TURN server yet).",
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
};

const get = (s, k) => { try { return s?.getItem(k) ?? null; } catch { return null; } };
const put = (s, k, v) => { try { if (v == null) s?.removeItem(k); else s?.setItem(k, v); } catch { /* private window */ } };

export function mountRoomPage(root, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const url = o.relayUrl || relayUrl(o.loc);
  const records = o.records || createTileRecords();
  const hideCheck = o.hideCheck || createHideCheck({ storage: o.storage });
  let room = null;                   // everything about the room once joined (null in the lobby)

  const view = h('div', { class: 'rl-view' });
  root.replaceChildren(h('div', { class: 'rl' },
    h('header', { class: 'rl-top' }, h('h1', {}, 'Rooms lab'), h('span', { class: 'rl-badge' }, 'lab')),
    view,
    h('footer', { class: 'rl-honest' }, h('ul', {}, HONEST.map((t) => h('li', {}, t)))),
  ));

  // ---- The lobby ----
  function lobby(note = '') {
    // A host link (#r=…&k=…): keep the key in this tab only, and take it out of the address bar so it
    // isn't copied along by accident.
    const { room: code, hostKey: linkKey } = readRoomHash(o.loc.hash);
    if (code && linkKey) {
      put(o.session, hostKeyKey(code), linkKey);
      try { o.history?.replaceState(null, '', inviteLink(o.loc, code)); } catch { /* fine */ }
    }
    const keptKey = code ? get(o.session, hostKeyKey(code)) : null;
    const nameBox = h('input', { class: 'rl-name', type: 'text', maxlength: 40, autocomplete: 'nickname', value: get(o.storage, NAME_KEY) || '', 'aria-describedby': 'rl-name-help' });
    const problem = h('p', { class: 'rl-problem', role: 'alert' }, note);
    const go = (how) => {
      const name = cleanName(nameBox.value);
      if (!name) { problem.textContent = 'Type a name first (up to 40 characters).'; nameBox.focus(); return; }
      put(o.storage, NAME_KEY, name);
      if (how === 'new') {
        const fresh = newRoomCode();
        try { o.history?.replaceState(null, '', inviteLink(o.loc, fresh)); } catch { /* fine */ }
        enter({ code: fresh, name, create: true });
      } else enter({ code, name, hostKey: how === 'host' ? keptKey : null });
    };
    nameBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(code ? (keptKey ? 'host' : 'join') : 'new'); });
    view.replaceChildren(h('section', { class: 'rl-lobby' },
      code
        ? h('p', {}, keptKey ? 'You made this room (or opened its host link) in this tab. ' : "You're invited to a room. ", 'Room ', h('code', {}, code), '.')
        : h('p', {}, 'Start a room, then send its link to the people you want to join. Voice and one shared screen, for 2 to 6 people.'),
      h('label', { class: 'rl-field' }, h('span', {}, 'Your name'), nameBox),
      h('p', { class: 'rl-help', id: 'rl-name-help' }, 'Others see this name as you type it. It isn’t checked.'),
      h('div', { class: 'rl-actions' },
        code && keptKey ? h('button', { class: 'rl-primary', type: 'button', onclick: () => go('host') }, 'Rejoin as host') : null,
        code ? h('button', { class: keptKey ? '' : 'rl-primary', type: 'button', onclick: () => go('join') }, keptKey ? 'Join as a guest' : 'Join room') : null,
        h('button', { class: code ? '' : 'rl-primary', type: 'button', onclick: () => go('new') }, code ? 'Start a new room instead' : 'New room'),
      ),
      problem,
    ));
    if (!nameBox.value) nameBox.focus();
  }

  // ---- The room ----
  function enter({ code, name, create = false, hostKey = null }) {
    const r = room = {
      code, name, me: null, host: false, people: new Map(), presenter: null,
      micTrack: null, micStream: null, muted: true, screenTrack: null, screenStream: null,
      remote: new Map(),           // peer → { audio: <audio>, voice: stream, screen: stream }
      conn: new Map(),             // peer → connection state
      wishes: new Map(),           // my wishes: id → { wish, target, stage: 'host' | 'person' | 'go', timer }
      prompt: null,                // the prompt on my screen: { type: 'ask', from, id, timer } or { type: 'go', id, timer }
      house: null,                 // the host's page only: the house bridge
      approvals: new Map(),        // the host's page only: `${from} ${id}` → { from, w, reason, timer }
      hostWishes: new Map(),       // the host's page only: asker → their wish being decided (one at a time)
      roomTiles: [],               // the host's page only: the tiles open for everyone, [{ uri, cid, by, live? }]
      wasHost: false,              // the host flag last time we joined (the live hub follows it)
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
        info: (uri) => ({ spoke: !!r.live?.spoke(uri), live: !!r.live?.isLive(uri), asking: r.wishes.size > 0 || !r.link?.joined || !hostHere() }),
        share: (uri) => wish('live', null, uri),
        ask: (uri) => wish('live', null, uri),
        stop: (uri) => liveForEveryone(uri, false),
      },
      onRemoved: (uri) => r.live?.removed(uri),
    });
    r.mesh = createMesh({
      iceServers: o.iceServers, RTCPeerConnectionImpl: o.RTCPeerConnectionImpl,
      signal: (peer, data) => r.link.to(peer, data),
      onTrack: (peer, track, stream) => remoteTrack(peer, track, stream),
      onPeerState: (peer, state) => { r.conn.set(peer, state); if (state === 'closed') forgetRemote(peer); renderPeople(); },
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
      url, room: code, name, create, hostKey, WebSocketImpl: o.WebSocketImpl, times: o.times,
      onState: (state, d = {}) => linkState(state, d),
      onSelf: (peer) => { r.me = peer; r.mesh.setSelf(peer); },
      onMessage: (m) => relayMessage(m),
    });
    r.me = r.link.peer;
    r.mesh.setSelf(r.me);
    say('Connecting to the room…');
    render();
  }

  function buildRoom(r) {
    const els = {};
    els.status = h('p', { class: 'rl-status', role: 'status', 'aria-live': 'polite' });
    els.invite = h('input', { class: 'rl-invite', type: 'text', readonly: true, value: inviteLink(o.loc, r.code), 'aria-label': 'Invite link' });
    els.copy = h('button', { type: 'button', onclick: () => copy(els.invite.value, 'Invite link copied.') }, 'Copy invite link');
    els.hostTools = h('span', { class: 'rl-host-tools', hidden: true },
      h('button', { type: 'button', onclick: () => copy(hostLink(o.loc, r.code, r.link.hostKey), 'Host link copied. Keep it to yourself: whoever opens it becomes the host.') }, 'Copy host link'),
      h('button', { type: 'button', class: 'rl-danger', onclick: () => { if (r.host) r.link.end(); } }, 'End room'));
    els.leave = h('button', { type: 'button', onclick: () => leave('You left the room.') }, 'Leave');
    els.video = h('video', { class: 'rl-video', autoplay: true, playsinline: true, muted: true, hidden: true });
    els.video.muted = true;
    els.caption = h('p', { class: 'rl-caption' });
    els.stage = h('div', { class: 'rl-stage' }, els.video, els.caption);
    els.mic = h('button', { type: 'button', class: 'rl-mic', 'aria-pressed': 'false', onclick: () => toggleMic() }, 'Unmute');
    // While "The host said you can present" is open, Share my screen does what its button does (the picker).
    els.share = h('button', { type: 'button', class: 'rl-share', onclick: () => (r.screenTrack ? stopShare('You stopped sharing.') : r.prompt?.type === 'go' ? startShare(r.prompt) : wish('present')) }, 'Share my screen');
    els.houseLine = h('p', { class: 'rl-house-line', hidden: true });
    els.houseMount = h('div', { class: 'rl-house', hidden: true });
    els.approvals = h('div', { class: 'rl-approvals' });
    els.tileInput = h('input', { class: 'rl-tile-input', type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder: 'at://\u2026/ing.dasl.masl/\u2026', 'aria-label': 'A tile\u2019s address' });
    els.tileButton = h('button', { type: 'submit', class: 'rl-tile-preview-go' }, 'Preview');
    els.tileForm = h('form', { class: 'rl-tile-form', onsubmit: (ev) => { ev.preventDefault(); previewTile(); } }, els.tileInput, els.tileButton);
    els.strip = h('ul', { class: 'rl-strip' });
    els.prompt = h('div', { class: 'rl-prompt', role: 'alertdialog', 'aria-live': 'assertive', hidden: true });
    els.people = h('ul', { class: 'rl-people' });
    els.log = h('ol', { class: 'rl-log' });
    els.audio = h('div', { class: 'rl-audio', hidden: true });
    els.section = h('section', { class: 'rl-room' },
      h('div', { class: 'rl-bar' }, h('span', {}, 'Room ', h('code', {}, r.code)), els.invite, els.copy, els.hostTools, els.leave),
      els.houseLine,
      els.status,
      els.approvals,
      els.stage,
      h('div', { class: 'rl-controls' }, els.mic, els.share),
      els.prompt,
      h('section', { class: 'rl-tiles' },
        h('h2', {}, 'Tiles opened for everyone'),
        els.tileForm,
        h('p', { class: 'rl-help' }, 'Paste a tile\u2019s address and preview it (only you see the preview). Then open it for everyone: each person gets their own copy, and each page checks it first.'),
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
  const nameOf = (peer) => (peer === room?.me ? 'You' : room?.people.get(peer)?.name || 'Someone');
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
      r.host = d.host; r.me = d.peer;
      if (d.host && d.hostKey) put(o.session, hostKeyKey(r.code), d.hostKey);
      if (r.screenTrack) r.link.all({ kind: 'presenting', on: true });      // back after a drop: still presenting
      if (d.host) startHouse(); else stopHouse();
      if (d.host) hostTilesBack();
      if (d.host !== r.wasHost) { r.wasHost = d.host; r.live.roleChanged(); }
      else r.live.hostConnected();                   // back after a drop: our live copies rejoin
      r.strip.refresh();
      say(d.host ? "You're the host. Send the invite link to the people you want here." : "You're in the room.");
    } else if (state === 'down') say('Reconnecting to the room… (voice and screens carry on meanwhile)');
    else if (state === 'connecting') say('Connecting to the room…');
    else if (state === 'no-room') say(`There's no room with this code right now. Trying again (${d.tries})…`);
    else if (state === 'not-host') { put(o.session, hostKeyKey(r.code), null); say("That host link doesn't match this room, so you're joining as a guest."); }
    else if (state === 'over') {
      const why = {
        ended: d.by === 'host gone' ? "The room has ended: the host didn't come back in time." : 'The host ended the room.',
        removed: 'The host took you out of the room.',
        replaced: 'You opened this room as host in another tab or window, so this one stopped.',
        full: 'This room is full (6 people).',
        'no room': "There's no room with this code. It may have ended, or the link may be wrong.",
        'room taken': 'That room code is taken. Start a new room.',
        refused: "The relay didn't accept that name or code.",
      }[d.why] || 'You left the room.';
      if (d.why === 'ended') put(o.session, hostKeyKey(r.code), null);
      return leave(why, { quiet: true });
    }
    render();
  }

  function relayMessage(m) {
    const r = room;
    if (!r || r.over) return;
    if (m.t === 'peers') return peers(m.list);
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
    if (r.host && r.roomTiles.length) for (const p of newcomers) r.link.to(p.peer, { kind: 'tiles', list: r.roomTiles });
    // Wishes, prompts and approvals about people who've gone.
    for (const [id, w] of r.wishes) if (w.target && !here.includes(w.target)) dropWish(id, `${nameOf(w.target)} left.`);
    if (r.prompt?.type === 'ask' && !here.includes(r.prompt.from)) closePrompt();
    for (const [key, a] of r.approvals) if (!here.includes(a.from) || (a.w.target && !here.includes(a.w.target))) closeApproval(key);
    for (const from of [...r.hostWishes.keys()]) if (!here.includes(from)) r.hostWishes.delete(from);
    for (const p of was) if (!here.includes(p)) r.live.peerGone(p);
    const host = list.find((p) => p.host);
    r.live.setPaused(!r.host && !!host?.away);
    if (host && host.away) say(`Waiting for ${host.name} to come back…`);
    else if (r.els.status.textContent.startsWith('Waiting for')) say('The host is back.');
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
      else if (next !== r.presenter && next !== r.me) say(next ? `${nameOf(next)} is presenting.` : `${nameOf(from)} stopped presenting.`);
      r.presenter = next;
      render();
    } else if (m.kind === 'wish') {
      if (!r.host) return;
      handleWish(from, m);
    } else if (['wish-result', 'go-ahead', 'ask-screen', 'tile', 'tiles', 'tile-close', 'tile-live'].includes(m.kind)) {
      if (from !== hostPeer()?.peer) { note('!', from, `${m.kind} not from the host: ignored`); return; }
      if (m.kind === 'wish-result') wishResult(m.id, m.decision, m.reason);
      else if (m.kind === 'go-ahead') goAhead(m.id);
      else if (m.kind === 'ask-screen') askedForScreen(m.asker, m.id);
      else if (m.kind === 'tile') tileOpened(m);
      else if (m.kind === 'tiles') { m.list.forEach((t) => { r.strip.show(t); if (t.live) r.live.setLive(t.uri, true); }); r.live.hostConnected(); }
      else if (m.kind === 'tile-live') r.live.setLive(m.uri, m.on);
      else { r.live.setLive(m.uri, false); r.strip.remove(m.uri); }
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
      peers: [...r.people.values()].map((p) => ({ peer: p.peer, name: p.name, host: !!p.host, ...(p.away ? { away: true } : {}) })),
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
  function previewTile() {
    const r = room;
    const at = parseTileUri(r.els.tileInput.value);
    if (!at) { say('Paste a tile\u2019s address: at://\u2026/ing.dasl.masl/\u2026'); return; }
    const uri = `at://${at.did}/ing.dasl.masl/${at.rkey}`;
    if (r.strip.isShared(uri)) { say('That tile is already open for everyone.'); return; }
    r.els.tileInput.value = '';
    r.strip.preview(uri, { buttons: [
      { text: r.host ? 'Open for everyone' : 'Ask to open for everyone', cls: 'rl-primary rl-tile-open', needsOpen: true,
        disabled: () => !canAskTile(), onclick: (e) => wish('open-tile', null, e.uri, e.cid) },
      { text: 'Cancel', cls: 'rl-tile-cancel', onclick: (e) => r.strip.removePreview(e.uri) },
    ] });
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
    put(o.session, tilesKey(r.code), JSON.stringify(r.roomTiles));
    r.link.all({ kind: 'tile', ...t });
    note('\u2192', null, `tile ${t.uri.split('/').pop()} (opened by ${nameOf(t.by)})`);
    tileOpened(t);
  }

  function closeForEveryone(uri) {
    const r = room;
    if (!r?.host) return;
    r.roomTiles = r.roomTiles.filter((t) => t.uri !== uri);
    put(o.session, tilesKey(r.code), JSON.stringify(r.roomTiles));
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
    put(o.session, tilesKey(r.code), JSON.stringify(r.roomTiles));
    r.link.all({ kind: 'tile-live', uri, on });
    note('\u2192', null, `tile-live ${on ? 'on' : 'off'} ${uri.split('/').pop()}`);
    r.live.setLive(uri, on);
    say(on ? 'Shared live with the room.' : 'Stopped sharing live. Each copy keeps what it has.');
  }

  // A tile opened for everyone: into the strip; if whoever opened it was presenting, the tile takes the stage.
  function tileOpened(t) {
    const r = room;
    r.strip.show(t);
    if (t.by === r.me && r.screenTrack) stopShare('Your share stopped: the tile takes over the stage.');
  }

  // The host back after a reload (or a relay restart): the tiles they had open, for everyone again.
  function hostTilesBack() {
    const r = room;
    if (!r.roomTiles.length) {
      try { const kept = JSON.parse(get(o.session, tilesKey(r.code)) || '[]'); if (Array.isArray(kept)) r.roomTiles = kept.filter((t) => t && parseTileUri(t.uri) && t.cid).slice(0, MAX_TILES); } catch { /* none */ }
    }
    if (!r.roomTiles.length) return;
    r.roomTiles.forEach((t) => { r.strip.show(t); if (t.live) r.live.setLive(t.uri, true); });
    r.link.all({ kind: 'tiles', list: r.roomTiles });
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
    r.presenter = r.me;
    r.mesh.setScreen(track, stream);
    r.link.all({ kind: 'presenting', on: true });
    note('→', null, 'presenting on');
    say("You're sharing your screen with everyone here.");
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
    line.textContent = st === 'ready' ? `House: the room\u2019s rules (${r.house.rules}) decide each request; you approve where they say so.`
      : st === 'loading' ? 'House: loading the room\u2019s rules\u2026'
      : 'No house tile: you approve each request yourself.';
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
    const { video, caption } = r.els;
    let stream = null, text = 'Nobody is sharing a screen.';
    if (r.presenter === r.me && r.screenStream) { stream = r.screenStream; text = "You're sharing your screen (everyone here sees it)."; }
    else if (r.presenter) {
      const s = r.remote.get(r.presenter)?.screen;
      const live = s && s.getVideoTracks().some((t) => t.readyState === 'live');
      if (live) { stream = s; text = `${nameOf(r.presenter)}’s screen`; }
      else text = `Waiting for ${nameOf(r.presenter)}’s screen…`;
    }
    if (video.srcObject !== stream) { video.srcObject = stream; if (stream) video.play?.().catch(() => {}); }
    video.hidden = !stream;
    caption.textContent = text;
    r.els.stage.classList.toggle('rl-empty', !stream);
  }

  function renderPeople() {
    const r = room;
    if (!r) return;
    const rows = [...r.people.values()].map((p) => {
      const mine = p.peer === r.me;
      const conn = mine || p.away ? null : r.conn.get(p.peer) || 'new';
      const connText = { new: 'connecting…', connecting: 'connecting…', connected: null, disconnected: 'connection unsteady…', failed: "couldn't connect directly", closed: null }[conn] ?? null;
      const asked = [...r.wishes.values()].some((w) => w.target === p.peer);
      return h('li', { class: 'rl-person', 'data-peer': p.peer },
        h('span', { class: `rl-dot${r.talking.has(p.peer) ? ' rl-talking' : ''}`, title: r.talking.has(p.peer) ? 'talking' : '' }),
        h('span', { class: 'rl-who' }, p.name),
        mine ? h('span', { class: 'rl-tag' }, 'you') : null,
        p.host ? h('span', { class: 'rl-tag rl-tag-host' }, 'host') : null,
        p.away ? h('span', { class: 'rl-tag' }, 'away') : null,
        r.presenter === p.peer ? h('span', { class: 'rl-tag rl-tag-on' }, 'presenting') : null,
        r.talking.has(p.peer) ? h('span', { class: 'rl-tag' }, 'talking') : null,
        connText ? h('span', { class: 'rl-conn' }, connText) : null,
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
  function leave(why, { quiet = false } = {}) {
    const r = room;
    if (!r) return;
    r.over = true;
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
      h('div', { class: 'rl-actions' }, h('button', { type: 'button', class: 'rl-primary', onclick: () => {
        // The room's link is still in the address bar: take it out, so "Back to the start" starts fresh.
        try { o.history?.replaceState(null, '', o.loc.pathname + o.loc.search); } catch { /* fine */ }
        lobby();
      } }, 'Back to the start'))));
  }

  lobby();
  return {
    // For the checks (and the console): what the page knows right now.
    get room() { return room; },
    leave: () => leave('You left the room.'),
  };
}
