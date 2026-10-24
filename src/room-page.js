// room-page.js: the Rooms lab page (rooms-lab-plan.md, section 7), build step 2: voice and one presenter's
// screen between 2 to 6 people, with no house tile yet. Framework-free, in Raku's plain style, so Raku can
// import it later (R3).
//
// mountRoomPage(root, options) draws the page into `root`:
// - the lobby: your name (typed, not checked), then "New room", "Join room" (from an invite link) or
//   "Rejoin as host" (this tab made the room, or opened the private host link);
// - the room: the stage (the presenter's screen), Unmute / Share my screen, the people here (the host,
//   who's presenting, who's talking, each direct connection), "Ask to see screen", the host's Remove and
//   End room, and the room's messages.
//
// Consent: a screen is only ever captured from a click by the person sharing: "Share my screen", or
// "Choose what to share…" in the prompt another person's request opens. The browser's own picker comes
// next, and its "Stop sharing" bar stays up while sharing. No page, and (from step 3) no house tile, can
// start someone's share. Nothing is recorded.
//
// Step 3 puts the house tile between "Ask to see screen" and the prompt (and lets the host approve);
// step 4 adds the strip of tiles opened for everyone.
import { connectRoom } from './room-link.js';
import { createMesh } from './mesh.js';
import { createLevels } from './levels.js';
import { readPeerData } from './messages.js';
import { afterAnnounce, afterPeople } from './presenting.js';
import { cleanName, newRoomCode, readRoomHash, inviteLink, hostLink } from './formats.js';
import { relayUrl, ICE_SERVERS, TIMES } from './config.js';

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

export const HONEST = [
  'This is a lab: a try-out, not a finished app.',
  'Names are typed by each person and not checked: anyone can type any name.',
  'Nothing is recorded or stored.',
  'The relay only introduces the people in a room and passes their messages; it stores nothing.',
  "Voice and screens go directly between the computers, encrypted by the browsers. To find each other, each computer asks a public STUN server (Google's or Cloudflare's) for its own address.",
  "Sharing only works on networks that allow direct connections (there's no TURN server yet).",
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
};

const get = (s, k) => { try { return s?.getItem(k) ?? null; } catch { return null; } };
const put = (s, k, v) => { try { if (v == null) s?.removeItem(k); else s?.setItem(k, v); } catch { /* private window */ } };

export function mountRoomPage(root, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const url = o.relayUrl || relayUrl(o.loc);
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
      asks: new Map(),             // asks I've sent: peer → { id, timer }
      prompt: null,                // the ask on my screen: { from, id, timer }
      talking: new Set(),
      log: [],
      over: false,
    };
    const els = buildRoom(r);
    view.replaceChildren(els.section);

    r.levels = createLevels({ AudioContextImpl: o.AudioContextImpl, onChange: (s) => { r.talking = s; renderPeople(); } });
    r.levels.start();                // we're inside the Join / New room click
    r.mesh = createMesh({
      iceServers: o.iceServers, RTCPeerConnectionImpl: o.RTCPeerConnectionImpl,
      signal: (peer, data) => r.link.to(peer, data),
      onTrack: (peer, track, stream) => remoteTrack(peer, track, stream),
      onPeerState: (peer, state) => { r.conn.set(peer, state); if (state === 'closed') forgetRemote(peer); renderPeople(); },
      onError: (peer, e) => note('!', peer, `connection setup: ${e?.name || 'error'} ${String(e?.message || '').slice(0, 120)}`),
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
    els.share = h('button', { type: 'button', class: 'rl-share', onclick: () => (r.screenTrack ? stopShare('You stopped sharing.') : startShare(null)) }, 'Share my screen');
    els.prompt = h('div', { class: 'rl-prompt', role: 'alertdialog', 'aria-live': 'assertive', hidden: true });
    els.people = h('ul', { class: 'rl-people' });
    els.log = h('ol', { class: 'rl-log' });
    els.audio = h('div', { class: 'rl-audio', hidden: true });
    els.section = h('section', { class: 'rl-room' },
      h('div', { class: 'rl-bar' }, h('span', {}, 'Room ', h('code', {}, r.code)), els.invite, els.copy, els.hostTools, els.leave),
      els.status,
      els.stage,
      h('div', { class: 'rl-controls' }, els.mic, els.share),
      els.prompt,
      h('h2', {}, 'Here'),
      els.people,
      h('details', { class: 'rl-messages' }, h('summary', {}, 'Room messages'), els.log),
      els.audio,
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
    // Someone new: tell them who's presenting (they missed it).
    if (r.screenTrack && list.some((p) => !was.has(p.peer) && p.peer !== r.me)) r.link.all({ kind: 'presenting', on: true });
    // Asks to or from people who've gone.
    for (const [peer, a] of r.asks) if (!r.people.has(peer)) { clearTimeout(a.timer); r.asks.delete(peer); }
    if (r.prompt && !here.includes(r.prompt.from)) closePrompt();
    const host = list.find((p) => p.host);
    if (host && host.away) say(`Waiting for ${host.name} to come back…`);
    else if (r.els.status.textContent.startsWith('Waiting for')) say('The host is back.');
    render();
  }

  function peerMessage(from, m, raw) {
    const r = room;
    if (!m) { note('←', from, `something the page doesn't know (${String(raw?.kind ?? typeof raw).slice(0, 30)}); ignored`); return; }
    if (m.kind === 'rtc') { r.mesh.handle(from, m); return; }
    note('←', from, m.kind === 'ask-answer' ? `${m.kind} ${m.answer}` : m.kind === 'presenting' ? `presenting ${m.on ? 'on' : 'off'}` : m.kind);
    if (m.kind === 'presenting') {
      const next = afterAnnounce(r.presenter, from, m.on);
      if (r.screenTrack && next !== r.me) { r.presenter = next; stopShare(`${nameOf(next)} started presenting at the same moment, so your share stopped.`, { tell: false }); }
      else if (next !== r.presenter && next !== r.me) say(next ? `${nameOf(next)} is presenting.` : `${nameOf(from)} stopped presenting.`);
      r.presenter = next;
      render();
    } else if (m.kind === 'ask-screen') {
      if (r.screenTrack) return answer(from, m.id, 'already');
      if (r.presenter) return answer(from, m.id, 'busy');
      if (r.prompt) return answer(from, m.id, 'busy');
      openPrompt(from, m.id);
    } else if (m.kind === 'ask-answer') {
      const a = r.asks.get(from);
      if (!a || a.id !== m.id) return;
      clearTimeout(a.timer); r.asks.delete(from);
      const who = nameOf(from);
      say({ yes: `${who} is choosing what to share…`, no: `${who} said not now.`, busy: `${who} can't share right now (someone is presenting).`, already: `${who} is already sharing.` }[m.answer]);
      renderPeople();
    }
  }

  function answer(to, id, ans) {
    room.link.to(to, { kind: 'ask-answer', id, answer: ans });
    note('→', to, `ask-answer ${ans}`);
  }

  // ---- Asking to see a screen ----
  function ask(peer) {
    const r = room;
    if (r.asks.has(peer) || r.presenter) return;
    const id = newRoomCode();
    r.asks.set(peer, { id, timer: setTimeout(() => { r.asks.delete(peer); say(`${nameOf(peer)} didn't answer.`); renderPeople(); }, o.times.askTimeoutMs) });
    r.link.to(peer, { kind: 'ask-screen', id });
    note('→', peer, 'ask-screen');
    say(`Asked ${nameOf(peer)} to share their screen…`);
    renderPeople();
  }

  function openPrompt(from, id) {
    const r = room;
    const others = [...r.people.values()].filter((p) => p.peer !== r.me && !p.away).length;
    r.prompt = { from, id, timer: setTimeout(() => { if (r.prompt?.id === id) { answer(from, id, 'no'); closePrompt(); } }, o.times.askTimeoutMs) };
    const p = r.els.prompt;
    p.replaceChildren(
      h('p', { class: 'rl-prompt-q' }, `${nameOf(from)} asks to see your screen. Share with ${others} ${others === 1 ? 'person' : 'people'}?`),
      h('p', { class: 'rl-help' }, 'Everyone here will see it. Pick one window or tab, not the whole screen, and close anything private first. You can stop at any time.'),
      h('div', { class: 'rl-actions' },
        h('button', { type: 'button', class: 'rl-primary', onclick: () => startShare(r.prompt) }, 'Choose what to share…'),
        h('button', { type: 'button', onclick: () => { if (r.prompt) { answer(r.prompt.from, r.prompt.id, 'no'); closePrompt(); } } }, 'Not now')),
    );
    p.hidden = false;
  }

  function closePrompt() {
    const r = room;
    if (!r?.prompt) return;
    clearTimeout(r.prompt.timer);
    r.prompt = null;
    r.els.prompt.hidden = true;
    r.els.prompt.replaceChildren();
  }

  // ---- Sharing: only ever from this person's own click ----
  async function startShare(fromPrompt) {
    const r = room;
    if (!r || r.screenTrack) return;
    if (r.presenter && r.presenter !== r.me) { say(`${nameOf(r.presenter)} is presenting. One screen at a time.`); return; }
    const asked = fromPrompt ? { ...fromPrompt } : null;
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
  function render() { renderControls(); renderStage(); renderPeople(); }

  function renderControls() {
    const r = room;
    if (!r) return;
    const { mic, share, hostTools, leave: leaveBtn } = r.els;
    mic.textContent = !r.micTrack || r.muted ? 'Unmute' : 'Mute';
    mic.setAttribute('aria-pressed', String(!!r.micTrack && !r.muted));
    const other = r.presenter && r.presenter !== r.me;
    share.textContent = r.screenTrack ? 'Stop sharing' : other ? `${nameOf(r.presenter)} is presenting` : 'Share my screen';
    share.disabled = !!other || !r.link?.joined && !r.screenTrack;
    hostTools.hidden = !r.host;
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
      const asked = r.asks.has(p.peer);
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
          !mine && !p.away ? h('button', { type: 'button', class: 'rl-ask', disabled: asked || !!r.presenter || !r.link.joined, onclick: () => ask(p.peer) }, asked ? 'Asked…' : 'Ask to see screen') : null,
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
    for (const a of r.asks.values()) clearTimeout(a.timer);
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
