// rooms.js: the Rooms lab relay's rules, with no network parts, so they're tested in Node and can be
// shared by a stand-in relay for the browser checks (build step 2) and the real one on Fly.io (server.js).
//
// The relay passes messages and stores nothing: no room record, no names kept after a room ends, nothing
// on disk, no recording. While it runs it only knows who is in which room (a random id and a typed name
// per page), so it can pass each message to one person or to everyone, and tell everyone who's here.
// Video and voice never pass through it: they go directly between the computers (WebRTC); the relay only
// carries the setup messages that introduce them.
//
// Page → relay (JSON; the field `t` is the message type):
//   { t: "join", room, peer, name, create?: true, hostKey?, pass? }   (pass: signed in, step 8; server.js checks it)
//   { t: "to", peer, data }     one person (WebRTC offers, answers and network candidates; wish prompts)
//   { t: "all", data }          everyone else in the room (house decisions, tile shares)
//   { t: "remove", peer }       host only: that person is taken out of the room
//   { t: "end" }                host only: the room ends for everyone
// Relay → page:
//   { t: "joined", room, peer, host, verified?, hostKey? }   (hostKey only to the host)
//   { t: "peers", list: [{ peer, name, host, verified?, away? }] }   to everyone, whenever someone comes or goes
//                                 (verified: true → `name` is a handle the relay checked through sign-in)
//   { t: "from", peer, data, all? }               a message from `peer` (`all: true` if it went to everyone)
//   { t: "full" }  { t: "replaced", why?: "account" }  { t: "removed" }  { t: "ended", why: "host" | "host gone" }
//   { t: "error", why }
//
// Rooms (rooms-lab-plan.md, section 5 and section 10):
// - `room` is a code the page makes (random, at least 10 characters); `peer` a random id per page load;
//   `name` is typed by the person and NOT verified (no sign-in in the lab); the page says so.
// - Whoever creates the room (`create: true`) is the host and gets a host key (random, made here unless
//   the page brings one). The key stays in the host's browser (and its private "host link").
// - The host's connection drops → everyone stays; the host shows in the list with `away: true` for the
//   grace period (about a minute). A join with the host key within it restores the host (a reload gives a
//   new peer id; that's fine). Otherwise the room ends: "ended", why "host gone".
// - A relay restart (a deploy) empties every room. The host's page joins again with `create: true` and
//   its host key, which makes the room again with the same key; guests' joins meanwhile get "no room" and
//   their pages try again.
// - A join with the host key while the host is still connected (another tab, or a connection the relay
//   hasn't noticed is dead) moves the host there; the older connection hears "replaced".
// - A guest whose peer id is already in the room is refused ("peer taken") rather than replacing anyone:
//   ids are visible to everyone in the room, so taking over by id would be too easy. The page picks a new
//   id and joins again.
// - At most 6 people per room (an away host keeps their place). Rooms vanish when they end; nothing is kept.
//
// Optional sign-in (build step 8; claude/rooms-signin-plan.md): a label, not a gate.
// - server.js checks a join's pass (signin.js) and hands receive() the result, { did, handle }. The person is
//   then shown by their handle, with `verified: true`; whatever name the page sent is ignored. Typed names
//   stay as they are, except that a typed name can't start with "@" (so nobody can look signed in).
// - The DID stays here, in memory, while the person is in the room, for two rules only, and is never sent
//   to anyone:
//   - the host by account: a room made by someone signed in remembers that account; a later join signed in
//     as the same account is the host, with or without the host key (another device, say). The host key
//     still works as before;
//   - one live connection per account: a join signed in as an account already in the room replaces the
//     older connection, which hears { t: "replaced", why: "account" } (the host's role moves along).

import { randomBytes, timingSafeEqual } from 'node:crypto';

export const LIMITS = Object.freeze({
  maxBytes: 64 * 1024,           // one message (in characters)
  maxPeople: 6,                  // per room, an away host included
  burst: 200, perSecond: 50,     // per connection: a new call sends a burst of network candidates to each person
  hostGraceMs: 60_000,           // how long a room waits for its host to come back
});

export const isRoomCode = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{10,64}$/.test(x);
export const isPeerId = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(x);
export const isHostKey = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(x);
// A typed display name: 1 to 40 characters once trimmed, no control characters. Not verified.
export const cleanName = (x) => {
  if (typeof x !== 'string') return null;
  const s = x.trim();
  if (!s || [...s].length > 40 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(s)) return null;
  return s;
};
const newHostKey = () => randomBytes(32).toString('base64url');
const sameKey = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const CLOSE = Object.freeze({ ended: 4000, removed: 4001, replaced: 4002 });

export function createRooms({ now = () => Date.now(), limits = LIMITS, makeHostKey = newHostKey } = {}) {
  const rooms = new Map();   // code → { hostKey, host: peer id, hostAwaySince: ms | null, people: Map(peer → { name, conn }) }
  const conns = new Map();   // conn → { room, peer, tokens, at }

  const send = (conn, msg) => ({ conn, msg });
  const closeConn = (conn, code, why) => ({ conn, close: { code, why } });

  const listOf = (r) => [...r.people].map(([peer, p]) => ({
    peer, name: p.name, host: peer === r.host, ...(p.verified ? { verified: true } : {}), ...(peer === r.host && !p.conn ? { away: true } : {}),
  }));
  const live = (r) => [...r.people.values()].filter((p) => p.conn);
  const announce = (r, out) => {
    const list = listOf(r);
    for (const p of live(r)) out.push(send(p.conn, { t: 'peers', list }));
  };
  const detach = (conn) => { const c = conns.get(conn); if (c) Object.assign(c, { room: null, peer: null }); };

  function endRoom(code, why, out) {
    const r = rooms.get(code);
    if (!r) return;
    rooms.delete(code);
    for (const p of live(r)) {
      out.push(send(p.conn, { t: 'ended', why }));
      out.push(closeConn(p.conn, CLOSE.ended, 'room ended'));
      detach(p.conn);
    }
  }

  function seat(conn, code, r, peer, name, isHost, out, who) {
    r.people.set(peer, { name, conn, verified: !!who, did: who ? who.did : null });
    if (isHost) { r.host = peer; r.hostAwaySince = null; if (who) r.hostDid = who.did; }
    Object.assign(conns.get(conn), { room: code, peer });
    out.push(send(conn, { t: 'joined', room: code, peer, host: isHost, ...(who ? { verified: true } : {}), ...(isHost ? { hostKey: r.hostKey } : {}) }));
    announce(r, out);
  }

  // The older connection of someone who just came back (the host key, or the same account): told, closed.
  function replace(old, out, why) {
    if (!old || !old.conn) return;
    out.push(send(old.conn, { t: 'replaced', ...(why ? { why } : {}) }));
    out.push(closeConn(old.conn, CLOSE.replaced, 'replaced'));
    detach(old.conn);
  }

  // who: { did, handle } when server.js checked the join's pass (signed in), else null (a typed name).
  function join(conn, m, out, who = null) {
    if (conns.get(conn).room) return out.push(send(conn, { t: 'error', why: 'already joined' }));
    if (!isRoomCode(m.room)) return out.push(send(conn, { t: 'error', why: 'room' }));
    if (!isPeerId(m.peer)) return out.push(send(conn, { t: 'error', why: 'peer' }));
    const name = who ? who.handle : cleanName(m.name);
    if (!name || (!who && name.startsWith('@'))) return out.push(send(conn, { t: 'error', why: 'name' }));
    if ('hostKey' in m && !isHostKey(m.hostKey)) return out.push(send(conn, { t: 'error', why: 'host key' }));
    const r = rooms.get(m.room);

    if (!r) {
      if (m.create !== true) return out.push(send(conn, { t: 'error', why: 'no room' }));
      const room = { hostKey: m.hostKey || makeHostKey(), host: null, hostDid: null, hostAwaySince: null, people: new Map() };
      rooms.set(m.room, room);
      return seat(conn, m.room, room, m.peer, name, true, out, who);
    }

    // The same account already in the room (another tab or device): that older connection gives way.
    const sameAccount = who ? [...r.people].find(([, p]) => p.did === who.did) : null;
    const keyOk = !!m.hostKey && sameKey(m.hostKey, r.hostKey);
    const accountIsHost = !!(who && r.hostDid && who.did === r.hostDid);
    if (m.hostKey && !keyOk && !accountIsHost) return out.push(send(conn, { t: 'error', why: 'host key' }));

    if (keyOk || accountIsHost) {
      if (m.peer !== r.host && r.people.has(m.peer) && !(sameAccount && sameAccount[0] === m.peer)) return out.push(send(conn, { t: 'error', why: 'peer taken' }));
      const old = r.people.get(r.host);
      if (old && old.conn !== conn) replace(old, out, who && old.did === who.did ? 'account' : null);
      r.people.delete(r.host);
      if (sameAccount && sameAccount[0] !== r.host) { replace(sameAccount[1], out, 'account'); r.people.delete(sameAccount[0]); }
      return seat(conn, m.room, r, m.peer, name, true, out, who);
    }

    if (m.create === true) return out.push(send(conn, { t: 'error', why: 'room taken' }));
    if (r.people.has(m.peer) && !(sameAccount && sameAccount[0] === m.peer)) return out.push(send(conn, { t: 'error', why: 'peer taken' }));
    if (sameAccount) { replace(sameAccount[1], out, 'account'); r.people.delete(sameAccount[0]); }
    if (r.people.size >= limits.maxPeople) { if (sameAccount) announce(r, out); return out.push(send(conn, { t: 'full' })); }
    seat(conn, m.room, r, m.peer, name, false, out, who);
  }

  function allowed(c) {
    const t = now();
    c.tokens = Math.min(limits.burst, c.tokens + ((t - c.at) / 1000) * limits.perSecond);
    c.at = t;
    if (c.tokens < 1) return false;
    c.tokens -= 1;
    return true;
  }

  return {
    // A new connection (any object that stands for it).
    open(conn) { conns.set(conn, { room: null, peer: null, tokens: limits.burst, at: now() }); },

    // A text message from a connection. Returns what to do: [{ conn, msg }] or [{ conn, close: { code, why } }].
    // who: for a join, { did, handle } when server.js checked its pass; otherwise null.
    receive(conn, text, who = null) {
      const out = [];
      const c = conns.get(conn);
      if (!c) return out;
      if (typeof text !== 'string' || text.length > limits.maxBytes) return [send(conn, { t: 'error', why: 'too big' })];
      if (!allowed(c)) return [send(conn, { t: 'error', why: 'too many' })];
      let m;
      try { m = JSON.parse(text); } catch { return [send(conn, { t: 'error', why: 'not JSON' })]; }
      if (!m || typeof m !== 'object' || Array.isArray(m)) return [send(conn, { t: 'error', why: 'not a message' })];
      if (m.t === 'join') { join(conn, m, out, who && typeof who.did === 'string' && typeof who.handle === 'string' ? who : null); return out; }
      if (!['to', 'all', 'remove', 'end'].includes(m.t)) return [send(conn, { t: 'error', why: 'unknown type' })];
      if (!c.room) return [send(conn, { t: 'error', why: 'join a room first' })];
      const r = rooms.get(c.room);
      const isHost = c.peer === r.host;

      if (m.t === 'to') {
        if (!('data' in m)) return [send(conn, { t: 'error', why: 'data' })];
        if (m.peer === c.peer) return [send(conn, { t: 'error', why: 'to yourself' })];
        const p = isPeerId(m.peer) && r.people.get(m.peer);
        if (!p || !p.conn) return [send(conn, { t: 'error', why: 'not here', ...(isPeerId(m.peer) ? { peer: m.peer } : {}) })];
        return [send(p.conn, { t: 'from', peer: c.peer, data: m.data })];
      }
      if (m.t === 'all') {
        if (!('data' in m)) return [send(conn, { t: 'error', why: 'data' })];
        for (const [peer, p] of r.people) if (peer !== c.peer && p.conn) out.push(send(p.conn, { t: 'from', peer: c.peer, data: m.data, all: true }));
        return out;
      }
      if (!isHost) return [send(conn, { t: 'error', why: 'host only' })];
      if (m.t === 'remove') {
        if (m.peer === c.peer) return [send(conn, { t: 'error', why: 'not yourself' })];
        const p = isPeerId(m.peer) && r.people.get(m.peer);
        if (!p) return [send(conn, { t: 'error', why: 'not here' })];
        r.people.delete(m.peer);
        if (p.conn) {
          out.push(send(p.conn, { t: 'removed' }));
          out.push(closeConn(p.conn, CLOSE.removed, 'removed'));
          detach(p.conn);
        }
        announce(r, out);
        return out;
      }
      // m.t === 'end'
      endRoom(c.room, 'host', out);
      return out;
    },

    // A connection closed (or was dropped). A guest leaves the room; the host goes "away" for the grace period.
    close(conn) {
      const out = [];
      const c = conns.get(conn);
      conns.delete(conn);
      if (!c || !c.room) return out;
      const r = rooms.get(c.room);
      const p = r && r.people.get(c.peer);
      if (!p || p.conn !== conn) return out;
      if (c.peer === r.host) { p.conn = null; r.hostAwaySince = now(); }
      else r.people.delete(c.peer);
      announce(r, out);
      return out;
    },

    // Call now and then (every few seconds): rooms whose host didn't come back in time end.
    sweep() {
      const out = [];
      for (const [code, r] of rooms) if (r.hostAwaySince !== null && now() - r.hostAwaySince >= limits.hostGraceMs) endRoom(code, 'host gone', out);
      return out;
    },

    stats: () => ({ rooms: rooms.size, connections: conns.size }),
  };
}
