// pong-state.js: what Live Pong knows, and how each message changes it. No browser parts, so it's tested in
// Node (test/pong-state.test.mjs). There is no referee copy (rooms-pong-plan.md, P4): every copy applies the
// same messages in the room's one order (the host's page numbers them), so every copy ends up with the same
// list, game, score and result. Anything that depends on time is a message from someone with a stake in it
// (the server's copy serves; the player who stayed claims the game), never each copy's own clock.
//
// Messages (the `data` a copy sends; `from` is the sender's copy id, `n` the room's number for it):
//   { t: "list", on: true, name }   "I'd like to play" (with a short typed name); on: false leaves the list
//   { t: "gone", id }               someone left the room a while ago: off the list
//   { t: "serve", g, pt, angle, again? }   the server starts point pt (again: the same point once more, after
//                                    the room paused or a player came back)
//   { t: "hit", r, h, seg }         the receiver's copy: "I returned it" (h: the rally's hit count after this
//                                    hit; seg: where the ball goes from the paddle, worked out by that copy)
//   { t: "miss", r, h }             the receiver's copy: "I missed it": the point to the other player
//   { t: "pause", g } / { t: "resume", g }   either player: the next serve waits / goes ahead (P15)
//   { t: "claim", g, backs }        the player who stayed, after the other was gone ~15 s: wins by default (P6)
//   { t: "back", g, backs }         a player who was gone is back: the point in play is played again (backs:
//                                    how many comebacks the sender knew of, so the same one never counts twice)
//   { t: "pad", g, p, k }  { t: "ping", k }   a paddle's position; a round-trip probe: not part of the state
//   { t: "state", upto, s }         for newcomers: the state as it stands (read by readSnapshot, not apply)
// Each is checked: a message from the wrong person, for another game or rally, or out of turn changes nothing.
import { readSegment, serveSegment, headingTo, planeOf } from './pong-physics.js';

export const WIN = 7;                 // first to 7 (P9)
export const MAX_LIST = 16, MAX_NAME = 20;
export const isId = (x) => typeof x === 'string' && /^[a-z0-9]{8,32}$/.test(x);
const other = (side) => (side === 'a' ? 'b' : 'a');

export function emptyState() { return { list: [], names: {}, nextN: 1, game: null, last: null }; }

export const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME) : '');
/** A player's name: typed, or "Player N" (P8). */
export const nameOf = (state, id) => state.names[id] || 'Player';
/** Which side a copy plays in the game: "a", "b", or null (watching). */
export const sideOf = (game, id) => (!game ? null : id === game.a ? 'a' : id === game.b ? 'b' : null);
export const idOfSide = (game, side) => (side === 'a' ? game.a : game.b);

function forget(state) {
  // keep the names of people on the list, in the game, and in the last game; forget the rest
  const keep = new Set([...state.list, ...(state.game ? [state.game.a, state.game.b] : []), ...(state.last ? [state.last.a, state.last.b] : [])]);
  for (const id of Object.keys(state.names)) if (!keep.has(id)) delete state.names[id];
}

function maybeStart(state, n) {
  if (state.game || state.list.length < 2) return false;
  const [a, b] = state.list;
  state.list = state.list.slice(2);
  state.game = { g: n, a, b, score: { a: 0, b: 0 }, server: 'a', pt: 1, pauseBy: null, backs: 0, rally: null };
  return true;
}

function end(state, winner, how, n) {
  const g = state.game;
  state.last = { g: g.g, a: g.a, b: g.b, score: { ...g.score }, winner, how };
  state.game = null;
  maybeStart(state, n);
  forget(state);
}

/** Apply one message. Returns what happened: "listed", "unlisted", "served", "hit", "point", "won",
 *  "paused", "resumed", "claimed", "back", "ignored". (A game that starts shows as a new state.game.g.) */
export function apply(state, data, from, n) {
  if (!data || typeof data !== 'object' || typeof from !== 'string') return 'ignored';
  const game = state.game;
  const side = sideOf(game, from);
  switch (data.t) {
    case 'list': {
      if (data.on === true) {
        if (state.list.includes(from) || side) return 'ignored';
        if (state.list.length >= MAX_LIST) return 'ignored';
        const typed = cleanName(data.name);
        state.names[from] = typed || state.names[from] || `Player ${state.nextN++}`;
        state.list.push(from);
        maybeStart(state, n);
        return 'listed';
      }
      if (data.on === false) {
        if (!state.list.includes(from)) return 'ignored';
        state.list = state.list.filter((x) => x !== from);
        forget(state);
        return 'unlisted';
      }
      return 'ignored';
    }
    case 'gone': {
      if (!state.list.includes(data.id)) return 'ignored';
      state.list = state.list.filter((x) => x !== data.id);
      forget(state);
      return 'unlisted';
    }
    case 'serve': {
      if (!game || data.g !== game.g || data.pt !== game.pt || idOfSide(game, game.server) !== from || game.pauseBy) return 'ignored';
      if (game.rally && !(data.again === true && game.rally.pt === game.pt)) return 'ignored';
      if (typeof data.angle !== 'number' || !Number.isFinite(data.angle)) return 'ignored';
      const seg = serveSegment(game.server, data.angle);
      game.rally = { r: n, pt: game.pt, hits: 0, seg, to: headingTo(seg) };
      return 'served';
    }
    case 'hit': {
      const r = game?.rally;
      if (!r || data.r !== r.r || data.h !== r.hits + 1 || side !== r.to) return 'ignored';
      const seg = readSegment(data.seg);
      if (!seg || headingTo(seg) !== other(side) || Math.abs(seg.s - planeOf(side)) > 1) return 'ignored';
      r.hits = data.h;
      r.seg = seg;
      r.to = other(side);
      return 'hit';
    }
    case 'miss': {
      const r = game?.rally;
      if (!r || data.r !== r.r || data.h !== r.hits || side !== r.to) return 'ignored';
      const scorer = other(side);
      game.score[scorer] += 1;
      game.rally = null;
      if (game.score[scorer] >= WIN) { end(state, scorer, 'score', n); return 'won'; }
      game.server = side;            // the player who lost the point serves (P9)
      game.pt += 1;
      return 'point';
    }
    case 'pause': {
      if (!side || data.g !== game.g || game.pauseBy) return 'ignored';
      game.pauseBy = from;
      return 'paused';
    }
    case 'resume': {
      if (!side || data.g !== game.g || !game.pauseBy) return 'ignored';
      game.pauseBy = null;
      return 'resumed';
    }
    case 'claim': {
      if (!side || data.g !== game.g || data.backs !== game.backs) return 'ignored';
      end(state, side, 'claim', n);
      return 'claimed';
    }
    case 'back': {
      if (!side || data.g !== game.g || data.backs !== game.backs) return 'ignored';
      game.backs += 1;
      game.rally = null;              // the point in play is played again
      return 'back';
    }
    default: return 'ignored';
  }
}

/** What a copy sends newcomers: { t: "state", upto, s }. upto: the last message number this copy applied. */
export function snapshot(state, upto) { return { t: 'state', upto, s: JSON.parse(JSON.stringify(state)) }; }

const isScore = (x) => x && Number.isInteger(x.a) && Number.isInteger(x.b) && x.a >= 0 && x.b >= 0 && x.a <= WIN && x.b <= WIN;
/** A newcomer reads someone's snapshot, checked; null if it isn't one. */
export function readSnapshot(m) {
  if (!m || m.t !== 'state' || !Number.isSafeInteger(m.upto) || m.upto < 0 || !m.s || typeof m.s !== 'object') return null;
  const s = m.s;
  if (!Array.isArray(s.list) || s.list.length > MAX_LIST || !s.list.every(isId) || new Set(s.list).size !== s.list.length) return null;
  if (!s.names || typeof s.names !== 'object' || Array.isArray(s.names)) return null;
  const names = {};
  for (const [id, nm] of Object.entries(s.names).slice(0, MAX_LIST + 4)) { const c = cleanName(nm); if (isId(id) && c) names[id] = c; }
  if (!Number.isSafeInteger(s.nextN) || s.nextN < 1) return null;
  let game = null;
  if (s.game) {
    const g = s.game;
    if (!Number.isSafeInteger(g.g) || !isId(g.a) || !isId(g.b) || g.a === g.b || !isScore(g.score) || !['a', 'b'].includes(g.server)
      || !Number.isSafeInteger(g.pt) || g.pt < 1 || !Number.isSafeInteger(g.backs) || g.backs < 0) return null;
    if (g.pauseBy !== null && g.pauseBy !== g.a && g.pauseBy !== g.b) return null;
    let rally = null;
    if (g.rally) {
      const r = g.rally;
      const seg = readSegment(r.seg);
      if (!Number.isSafeInteger(r.r) || !Number.isSafeInteger(r.hits) || r.hits < 0 || r.pt !== g.pt || !seg || !['a', 'b'].includes(r.to) || headingTo(seg) !== r.to) return null;
      rally = { r: r.r, pt: r.pt, hits: r.hits, seg, to: r.to };
    }
    game = { g: g.g, a: g.a, b: g.b, score: { a: g.score.a, b: g.score.b }, server: g.server, pt: g.pt, pauseBy: g.pauseBy, backs: g.backs, rally };
  }
  let last = null;
  if (s.last) {
    const l = s.last;
    if (!Number.isSafeInteger(l.g) || !isId(l.a) || !isId(l.b) || !isScore(l.score) || !['a', 'b'].includes(l.winner) || !['score', 'claim'].includes(l.how)) return null;
    last = { g: l.g, a: l.a, b: l.b, score: { a: l.score.a, b: l.score.b }, winner: l.winner, how: l.how };
  }
  return { upto: m.upto, state: { list: [...s.list], names, nextN: s.nextN, game, last } };
}

/** Who's up next (the first two on the list), for "Next: …". */
export const nextUp = (state) => state.list.slice(0, 2);
