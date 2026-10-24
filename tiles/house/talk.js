// talk.js: how the Rooms lab house talks to the page that holds it (modelled on daisy-tiles/shared/talk.js).
//
// It uses the tiles protocol for data (tp-data): first the host's own module at
// /.well-known/web-tiles/data.js (when the tile is loaded through a real tile loader), otherwise plain
// postMessage with the same envelope ({ action: "tiles-protocol-up-data-payload", payload }), which is
// what the lab's dev page speaks (it holds the house in a sealed frame).
//
// Every payload is { game: "rooms", v: 1, kind, ... }. The page adds `from: "page"` to what it sends; the
// house only listens to that.

export const UP = 'tiles-protocol-up-data-payload';
export const DOWN = 'tiles-protocol-down-data-payload';
export const GAME = 'rooms';
export const VERSION = 1;

export async function connect(onMessage) {
  const accept = (payload) => {
    if (!payload || typeof payload !== 'object' || payload.game !== GAME || payload.v !== VERSION) return;
    if (typeof payload.kind !== 'string' || payload.from !== 'page') return;
    try { onMessage(payload); } catch (err) { console.error('rooms house: message handler failed', err); }
  };
  let send = null, via = 'none';
  try {
    const dp = await import('/.well-known/web-tiles/data.js');
    if (typeof dp.sendData === 'function' && typeof dp.addDataHandler === 'function') {
      dp.addDataHandler((p) => accept(p && p.payload !== undefined && p.action ? p.payload : p));
      if (typeof dp.listen === 'function') dp.listen();
      send = (p) => dp.sendData(p);
      via = 'data.js';
    }
  } catch { /* not loaded by a tile loader: use postMessage */ }
  if (!send) {
    addEventListener('message', (e) => {
      if (e.source !== parent) return;
      const d = e.data;
      if (d && d.action === DOWN) accept(d.payload);
    });
    send = (p) => parent.postMessage({ action: UP, payload: p }, '*');
    via = parent === window ? 'none' : 'postMessage';
  }
  document.documentElement.dataset.talk = via;      // which way it talks (for checks and curious eyes)
  return {
    via,
    send(kind, fields = {}) { send({ ...fields, game: GAME, v: VERSION, kind }); },
  };
}
