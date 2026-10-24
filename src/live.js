// live.js: tiles shared live with the room (rooms-live-tiles-plan.md, decisions L1 to L7e).
//
// A tile opened for everyone runs as a separate copy on each person's page. Shared live, the copies send
// each other what people do in them: a vote, a move, a click. The rules (as promised to Robin, Oct 24):
//   1. Only copies of the same pinned tile (the same address and record CID) talk; never a different tile.
//   2. Inside the room only: messages go directly between the computers (the WebRTC data channel the mesh
//      already has, encrypted like voice), never through the relay, and nothing is stored anywhere.
//   3. No identities: each copy gets a random id, one per person, per tile, per room (never a name, handle,
//      DID, or the room's own peer id).
//   4. Opt-in and visible: off by default; the host turns it on per tile (a wish the house decides), every
//      card says "Shared live with the room", and the host can turn it off.
//   5. Limits: JSON only, 16 KB a message, 10 a second per copy (bursts of 30), and a budget for the whole
//      room at the host's page (60 a second, 128 KB a second).
//   6. The house carries it: every message goes to the host's page (the hub), which numbers it in one
//      order for everyone and sends it to every copy, the sender's included. Each receiving page checks it
//      again (from the host's page, a live tile, size and rate) before handing it to its copy.
//
// What a tile sees (the envelope; the same postMessage channel as the tiles protocols, under its own name):
//   tile → page  { action: "tiles-protocol-up-live-payload",   payload: { v: 1, kind, ... } }
//                kind "hello"           "I speak live" (the page answers with presence)
//                kind "send", data      a message for every copy (JSON, at most 16 KB)
//   page → tile  { action: "tiles-protocol-down-live-payload", payload: { v: 1, kind, ... } }
//                kind "presence", you, here[, joined]  your id; the ids here now (just yours when not live);
//                                                     joined: the ids that just came in (or back). A copy that
//                                                     has been live sends them its state; a copy that never has
//                                                     waits for the room's (the tile decides: live-talk.js)
//                kind "message", n, from, data         a message, in the room's one order (yours come back too)
//                kind "paused" / "resumed"             the host's page is gone for a moment / back
//                kind "limit", reason                  your message wasn't sent: "size", "json", "rate",
//                                                     "room", "paused" or "connection"
// Not live, the page plays the room of one: your own messages come straight back, numbered by this page.
//
// Between the pages (over the data channel, JSON): a guest's page → the host's page
//   { kind: "live-join", uri, id }   { kind: "live-leave", uri }   { kind: "live-send", uri, data }
// the host's page → each member page
//   { kind: "live-msg", uri, n, from, data }   { kind: "live-here", uri, here, joined? }   { kind: "live-limit", uri, reason }
// Turning live sharing on and off is a room message from the host's page (`tile-live`, through the relay,
// like opening a tile): it carries only the tile's address, never what anyone does in it.

export const LIVE_UP = 'tiles-protocol-up-live-payload';
export const LIVE_DOWN = 'tiles-protocol-down-live-payload';
export const LIVE_V = 1;
export const LIMITS = Object.freeze({
  maxBytes: 16 * 1024,
  copy: Object.freeze({ perSecond: 10, burst: 30 }),
  room: Object.freeze({ perSecond: 60, burst: 120, bytesPerSecond: 128 * 1024 }),
  receive: Object.freeze({ perSecond: 90, burst: 180 }),     // a receiving page's own check: a little looser than the room's budget
  fromTile: Object.freeze({ perSecond: 40, burst: 80 }),    // anything at all from one tile frame (hellos included)
});
export const REASONS = ['size', 'json', 'rate', 'room', 'paused', 'connection'];
export const MAX_HERE = 6;

const TILE_URI = /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]{1,2000}\/ing\.dasl\.masl\/[A-Za-z0-9._~:-]{1,512}$/;
export const isCopyId = (x) => typeof x === 'string' && /^[a-z0-9]{12,32}$/.test(x);
const isUri = (x) => typeof x === 'string' && x.length <= 2600 && TILE_URI.test(x);

/** A fresh copy id: 16 random letters and digits. */
export function newCopyId(cryptoImpl = globalThis.crypto) {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  return Array.from(bytes, (b) => abc[b % 36]).join('');
}

/** Data a tile wants sent: plain JSON, at most maxBytes as text. { text, data } or { reason }. */
export function jsonData(data, maxBytes = LIMITS.maxBytes) {
  let text;
  try { text = JSON.stringify(data); } catch { return { reason: 'json' }; }
  if (typeof text !== 'string') return { reason: 'json' };
  if (new TextEncoder().encode(text).length > maxBytes) return { reason: 'size' };
  return { text, data: JSON.parse(text) };
}

/** What a tile frame sent: { kind: "hello" } | { kind: "send", data, text } | { drop }. */
export function readFromTile(raw, maxBytes = LIMITS.maxBytes) {
  if (!raw || typeof raw !== 'object' || raw.v !== LIVE_V || typeof raw.kind !== 'string') return { drop: 'not a live message' };
  if (raw.kind === 'hello') return { kind: 'hello' };
  if (raw.kind === 'send') {
    const j = jsonData(raw.data, maxBytes);
    return j.reason ? { kind: 'send', reason: j.reason } : { kind: 'send', data: j.data, text: j.text };
  }
  return { drop: `a tile may not send "${raw.kind.slice(0, 30)}"` };
}

/** A live message between pages, checked; null if it isn't one. */
export function readPeerLive(d, maxBytes = LIMITS.maxBytes) {
  if (!d || typeof d !== 'object' || Array.isArray(d) || !isUri(d.uri)) return null;
  switch (d.kind) {
    case 'live-join': return isCopyId(d.id) ? { kind: d.kind, uri: d.uri, id: d.id } : null;
    case 'live-leave': return { kind: d.kind, uri: d.uri };
    case 'live-send': { const j = jsonData(d.data, maxBytes); return j.reason ? null : { kind: d.kind, uri: d.uri, data: j.data, text: j.text }; }
    case 'live-msg': {
      if (!Number.isSafeInteger(d.n) || d.n < 1 || !isCopyId(d.from)) return null;
      const j = jsonData(d.data, maxBytes);
      return j.reason ? null : { kind: d.kind, uri: d.uri, n: d.n, from: d.from, data: j.data };
    }
    case 'live-here':
      if (!Array.isArray(d.here) || d.here.length > MAX_HERE || !d.here.every(isCopyId)) return null;
      if (d.joined !== undefined && !(Array.isArray(d.joined) && d.joined.length <= MAX_HERE && d.joined.every((x) => d.here.includes(x)))) return null;
      return { kind: d.kind, uri: d.uri, here: [...d.here], ...(d.joined?.length ? { joined: [...d.joined] } : {}) };
    case 'live-limit': return REASONS.includes(d.reason) ? { kind: d.kind, uri: d.uri, reason: d.reason } : null;
    default: return null;
  }
}

/** A token bucket: `take(cost)` is true while there's room. */
export function bucket({ perSecond, burst }, now = () => Date.now()) {
  let tokens = burst, at = now();
  return {
    take(cost = 1) {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - at) / 1000) * perSecond);
      at = t;
      if (tokens < cost) return false;
      tokens -= cost;
      return true;
    },
  };
}

/** The hub, on the host's page: who's in each live tile, the one order, the limits. No DOM. */
export function createHub({ limits = LIMITS, now = () => Date.now() } = {}) {
  const tiles = new Map();        // uri → { members: Map(page → id), n, copyBuckets: Map(page → bucket) }
  const roomMsgs = bucket(limits.room, now);
  const roomBytes = bucket({ perSecond: limits.room.bytesPerSecond, burst: limits.room.bytesPerSecond }, now);
  const tile = (uri) => tiles.get(uri);
  return {
    open(uri) { if (!tiles.has(uri)) tiles.set(uri, { members: new Map(), n: 0, copyBuckets: new Map() }); },
    close(uri) { tiles.delete(uri); },
    isOpen: (uri) => tiles.has(uri),
    /** A copy joins (or rejoins with the same id). Returns true when the list of ids grew. */
    join(uri, page, id) {
      const t = tile(uri);
      if (!t || !isCopyId(id)) return false;
      const had = t.members.get(page);
      if ([...t.members.entries()].some(([p, x]) => x === id && p !== page)) return false;   // someone else's id
      if (!had && t.members.size >= MAX_HERE) return false;
      t.members.set(page, id);
      return had !== id;
    },
    leave(uri, page) { const t = tile(uri); if (!t) return false; t.copyBuckets.delete(page); return t.members.delete(page); },
    leaveAll(page) { const out = []; for (const [uri, t] of tiles) if (t.members.delete(page)) { t.copyBuckets.delete(page); out.push(uri); } return out; },
    members(uri) { return [...(tile(uri)?.members.entries() || [])].map(([page, id]) => ({ page, id })); },
    ids(uri) { return [...(tile(uri)?.members.values() || [])]; },
    idOf(uri, page) { return tile(uri)?.members.get(page) ?? null; },
    /** A copy's message: { msg: { n, from, data } } numbered, or { reason } (not sent, nothing numbered). */
    send(uri, page, text, data) {
      const t = tile(uri);
      const from = t?.members.get(page);
      if (!t || !from) return { reason: 'connection' };
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > limits.maxBytes) return { reason: 'size' };
      if (!t.copyBuckets.has(page)) t.copyBuckets.set(page, bucket(limits.copy, now));
      if (!t.copyBuckets.get(page).take()) return { reason: 'rate' };
      if (!roomMsgs.take()) return { reason: 'room' };
      if (!roomBytes.take(bytes)) return { reason: 'room' };
      t.n += 1;
      return { msg: { n: t.n, from, data } };
    },
  };
}

// ---- The page's side (needs a window and the strip) ----
//
// createLiveTiles wires one page's copies to the room:
//   strip       the tile strip: frameOf(uri), uriOfSource(win), isShared(uri)
//   isHost(), me(), hostPeer() → the host's peer id (or null), hostAway() → true while the host is gone
//   toPeer(peer, obj) → true if it went out on the data channel to that page
//   session     sessionStorage (copy ids survive a reload); room: the room code
//   onChange(uri)   a copy said hello, joined, left: the strip's buttons follow
export function createLiveTiles({
  win = globalThis, strip, room, session = null, isHost, me, hostPeer, hostAway = () => false, toPeer,
  limits = LIMITS, now = () => Date.now(), onLog = () => {}, onChange = () => {}, cryptoImpl = globalThis.crypto,
}) {
  const key = `rooms-lab-live:${room}`;
  let ids = {};
  try { ids = JSON.parse(session?.getItem(key) || '{}') || {}; } catch { ids = {}; }
  const live = new Set();             // tiles the host's page says are live
  const spoke = new Set();            // tiles whose copy on this page said hello
  const joined = new Set();           // live tiles this page's copy is a member of (as the host's page last said)
  const here = new Map();             // uri → ids here (the host's page's last list)
  const localN = new Map();           // uri → this page's own count, for the room of one
  const fromTile = new Map();         // uri → bucket for anything from that frame
  const receive = new Map();          // uri → bucket for live-msg from the host's page
  const hub = createHub({ limits, now });
  let paused = false;

  const idOf = (uri) => {
    if (!isCopyId(ids[uri])) {
      ids[uri] = newCopyId(cryptoImpl);
      try { session?.setItem(key, JSON.stringify(ids)); } catch { /* private window: a reload gives a new id */ }
    }
    return ids[uri];
  };
  const down = (uri, kind, fields = {}) => {
    const f = strip.frameOf(uri);
    const w = f && f.contentWindow;
    if (!w) return false;
    w.postMessage({ action: LIVE_DOWN, payload: { ...fields, v: LIVE_V, kind } }, '*');
    return true;
  };
  const isLive = (uri) => live.has(uri) && strip.isShared(uri);
  const presence = (uri, { came = [] } = {}) => {
    if (!spoke.has(uri)) return;
    const you = idOf(uri);
    const inRoom = isLive(uri) && joined.has(uri) && here.get(uri)?.includes(you);
    const list = inRoom ? here.get(uri) : [you];
    down(uri, 'presence', { you, here: list, ...(inRoom && came.length ? { joined: came } : {}) });
  };

  // The host's page: tell every member who's here, and who just came in (or back).
  function hubHere(uri, came = []) {
    const list = hub.ids(uri);
    const fresh = came.filter((id) => list.includes(id));
    for (const m of hub.members(uri)) deliverPeer(m.page, { kind: 'live-here', uri, here: list, ...(fresh.length ? { joined: fresh } : {}) });
  }
  function deliverPeer(page, msg) {
    if (page === me()) return fromHost(msg);
    if (!toPeer(page, msg)) onLog('!', page, `live: no direct connection for ${msg.kind}`);
  }
  function hubSend(page, uri, text, data) {
    const r = hub.send(uri, page, text, data);
    if (r.reason) { deliverPeer(page, { kind: 'live-limit', uri, reason: r.reason }); return; }
    for (const m of hub.members(uri)) deliverPeer(m.page, { kind: 'live-msg', uri, ...r.msg });
  }

  // A guest's page (or the host's own): what the host's page said about a live tile.
  function fromHost(m) {
    if (!live.has(m.uri) || !strip.isShared(m.uri)) return;
    if (m.kind === 'live-here') {
      const you = idOf(m.uri);
      here.set(m.uri, m.here);
      if (m.here.includes(you)) joined.add(m.uri); else joined.delete(m.uri);
      presence(m.uri, { came: m.joined || [] });
      onChange(m.uri);
    } else if (m.kind === 'live-msg') {
      if (!joined.has(m.uri)) return;
      if (!receive.has(m.uri)) receive.set(m.uri, bucket(limits.receive, now));
      if (!receive.get(m.uri).take()) { onLog('!', null, 'live: too many messages from the host’s page; dropped'); return; }
      down(m.uri, 'message', { n: m.n, from: m.from, data: m.data });
    } else if (m.kind === 'live-limit') down(m.uri, 'limit', { reason: m.reason });
  }

  function join(uri) {
    if (!isLive(uri) || !spoke.has(uri) || paused) return;
    const id = idOf(uri);
    if (isHost()) { if (hub.join(uri, me(), id)) hubHere(uri, [id]); }
    else { const hp = hostPeer(); if (hp) toPeer(hp, { kind: 'live-join', uri, id }); }
  }
  function leave(uri) {
    joined.delete(uri);
    here.delete(uri);
    if (isHost()) { if (hub.leave(uri, me())) hubHere(uri); }
    else { const hp = hostPeer(); if (hp && live.has(uri)) toPeer(hp, { kind: 'live-leave', uri }); }
  }

  // Messages from tile frames on this page.
  function onWindowMessage(e) {
    const d = e.data;
    if (!d || d.action !== LIVE_UP) return;
    const uri = strip.uriOfSource(e.source);
    if (!uri) return;
    if (!fromTile.has(uri)) fromTile.set(uri, bucket(limits.fromTile, now));
    if (!fromTile.get(uri).take()) return;
    const m = readFromTile(d.payload, limits.maxBytes);
    if (m.drop) { onLog('!', null, `live: ${m.drop}`); return; }
    if (m.kind === 'hello') {
      const first = !spoke.has(uri);
      spoke.add(uri);
      presence(uri);
      if (paused && isLive(uri)) down(uri, 'paused');
      if (first) { join(uri); onChange(uri); }
      return;
    }
    if (m.reason) { down(uri, 'limit', { reason: m.reason }); return; }
    if (!spoke.has(uri)) return;
    if (!isLive(uri)) {                                   // the room of one: straight back
      const n = (localN.get(uri) || 0) + 1;
      localN.set(uri, n);
      down(uri, 'message', { n, from: idOf(uri), data: m.data });
      return;
    }
    if (paused) { down(uri, 'limit', { reason: 'paused' }); return; }
    if (isHost()) return hubSend(me(), uri, m.text, m.data);
    const hp = hostPeer();
    if (!hp || !joined.has(uri) || !toPeer(hp, { kind: 'live-send', uri, data: m.data })) down(uri, 'limit', { reason: 'connection' });
  }
  win.addEventListener('message', onWindowMessage);

  return {
    /** The host's page says a tile is (or isn't) shared live. */
    setLive(uri, on) {
      if (on) {
        if (live.has(uri)) return;
        live.add(uri);
        if (isHost()) hub.open(uri);
        join(uri);
      } else {
        if (!live.delete(uri)) return;
        joined.delete(uri); here.delete(uri);
        if (isHost()) hub.close(uri);
        presence(uri);                                     // just you again; your copy keeps what it has
      }
      onChange(uri);
    },
    isLive: (uri) => live.has(uri),
    spoke: (uri) => spoke.has(uri),
    joined: (uri) => joined.has(uri),
    hereOf: (uri) => [...(here.get(uri) || [])],
    /** From another page over the data channel (already checked by readPeerLive). */
    fromPeer(peer, m) {
      if (['live-msg', 'live-here', 'live-limit'].includes(m.kind)) {
        if (peer !== hostPeer()) { onLog('!', peer, `live: ${m.kind} not from the host: ignored`); return; }
        return fromHost(m);
      }
      if (!isHost() || !hub.isOpen(m.uri)) return;
      if (m.kind === 'live-join') { if (hub.join(m.uri, peer, m.id)) hubHere(m.uri, [m.id]); }
      else if (m.kind === 'live-leave') { if (hub.leave(m.uri, peer)) hubHere(m.uri); }
      else if (m.kind === 'live-send') hubSend(peer, m.uri, m.text, m.data);
    },
    /** The host's page: someone left the room (or their direct connection closed). */
    peerGone(peer) { if (!isHost()) return; for (const uri of hub.leaveAll(peer)) hubHere(uri); },
    /** A guest's page: the direct connection to the host's page is (again) open: rejoin. */
    hostConnected() { if (isHost()) return; for (const uri of live) join(uri); },
    /** The host is gone for a moment (the grace period) or back. */
    setPaused(on) {
      if (on === paused) return;
      paused = on;
      for (const uri of live) if (spoke.has(uri) && strip.isShared(uri)) down(uri, on ? 'paused' : 'resumed');
      if (!on) for (const uri of live) join(uri);
    },
    get paused() { return paused; },
    /** This page's copy is gone (hidden, closed, or the strip emptied). */
    removed(uri) {
      if (joined.has(uri) || (isHost() && hub.idOf(uri, me()))) leave(uri);
      spoke.delete(uri); fromTile.delete(uri); receive.delete(uri); localN.delete(uri);
      onChange(uri);
    },
    /** This page became host (or stopped being host): the hub starts empty; copies rejoin. */
    roleChanged() {
      for (const uri of live) { if (isHost()) hub.open(uri); joined.delete(uri); here.delete(uri); join(uri); }
    },
    stop() { win.removeEventListener('message', onWindowMessage); live.clear(); },
    // For the checks.
    get hub() { return hub; },
    idOf,
  };
}
