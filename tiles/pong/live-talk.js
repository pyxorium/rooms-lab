// live-talk.js: how a tile talks with the other copies of itself in a room (the Rooms lab's live tiles).
// Copy this file into your own tile to make it live; it has no other parts.
//
// The room's page answers with who's here and passes your messages to every copy of the same tile, in one
// order for everyone, yours included. Outside a room (a tile gallery, a viewer, opened on its own) nobody
// answers: after a moment this file plays the room of one, so your tile works the same way, alone.
//
//   const live = joinLive({ onPresence, onMessage, onPaused, onResumed, onLimit });
//   live.send(data)       plain JSON, at most 16 KB, at most 10 a second (bursts of 30)
//   onPresence({ you, here, joined }) your id; the ids here (just yours when not shared live); joined: the ids
//                                     that just came in (or back). Catching newcomers up is the tile's own job:
//                                     a copy that has been live sends its state; a copy that never has (it just
//                                     arrived) waits a moment for the room's, then offers its own if none came
//   onMessage({ n, from, data })      every message, in the room's one order (yours come back too)
//   onPaused() / onResumed()          the room's host is gone for a moment / back
//   onLimit(reason)                   a message didn't go out: "size", "json", "rate", "room", "paused", "connection"
//
// The envelope (postMessage with the page that holds the tile; under the tiles protocols' names):
//   up    { action: "tiles-protocol-up-live-payload",   payload: { v: 1, kind: "hello" | "send", data? } }
//   down  { action: "tiles-protocol-down-live-payload", payload: { v: 1, kind: "presence" | "message" |
//                                                                  "paused" | "resumed" | "limit", ... } }

export const UP = 'tiles-protocol-up-live-payload';
export const DOWN = 'tiles-protocol-down-live-payload';
export const V = 1;
const ALONE_AFTER_MS = 1500;

function randomId() {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => abc[x % 36]).join('');
}

export function joinLive({ onPresence = () => {}, onMessage = () => {}, onPaused = () => {}, onResumed = () => {}, onLimit = () => {} } = {}) {
  const inFrame = window.parent !== window;
  let mode = 'waiting';                 // 'room' (a page answered), 'alone' (nobody did), or 'waiting'
  let you = null, here = [], aloneN = 0;
  const post = (payload) => { if (inFrame) window.parent.postMessage({ action: UP, payload: { ...payload, v: V } }, '*'); };

  function alone() {
    if (mode !== 'waiting') return;
    mode = 'alone';
    you = randomId();
    here = [you];
    document.documentElement.dataset.live = 'alone';
    onPresence({ you, here: [you], joined: [] });
  }

  addEventListener('message', (e) => {
    if (!inFrame || e.source !== window.parent) return;
    const d = e.data;
    if (!d || d.action !== DOWN || !d.payload || d.payload.v !== V) return;
    const p = d.payload;
    if (p.kind === 'presence') {
      if (typeof p.you !== 'string' || !Array.isArray(p.here)) return;
      mode = 'room';
      you = p.you; here = p.here.filter((x) => typeof x === 'string');
      document.documentElement.dataset.live = here.length > 1 ? 'live' : 'room';
      onPresence({ you, here: [...here], joined: Array.isArray(p.joined) ? p.joined.filter((x) => typeof x === 'string') : [] });
    } else if (p.kind === 'message' && mode === 'room') {
      onMessage({ n: p.n, from: p.from, data: p.data });
    } else if (p.kind === 'paused') onPaused();
    else if (p.kind === 'resumed') onResumed();
    else if (p.kind === 'limit') onLimit(String(p.reason || ''));
  });

  if (inFrame) {
    post({ kind: 'hello' });
    setTimeout(() => { if (mode === 'waiting') post({ kind: 'hello' }); }, 500);   // in case the page wasn't ready
  }
  setTimeout(alone, inFrame ? ALONE_AFTER_MS : 0);

  return {
    send(data) {
      if (mode === 'room') return post({ kind: 'send', data });
      // alone (or still waiting): straight back, as a room of one would do
      let text;
      try { text = JSON.stringify(data); } catch { onLimit('json'); return; }
      if (text === undefined) { onLimit('json'); return; }
      if (new TextEncoder().encode(text).length > 16 * 1024) { onLimit('size'); return; }
      if (mode === 'waiting') alone();
      aloneN += 1;
      const n = aloneN;
      queueMicrotask(() => onMessage({ n, from: you, data: JSON.parse(text) }));
    },
    get you() { return you; },
    get here() { return [...here]; },
    get mode() { return mode; },
  };
}
