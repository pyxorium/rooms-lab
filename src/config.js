// config.js: the Rooms lab's addresses and timings in one place (rooms-lab-plan.md, sections 4 and 7).

// The relay (thunderbird-rooms-relay on Fly.io; C:\thunderbird-cafe\rooms-lab\relay). It lets in pages
// from https://thunderbird.cafe and the site's dev server, http://127.0.0.1:4321.
export const RELAY_URL = 'wss://relay.rooms.thunderbird.cafe/';
// The relay `npm run dev` starts on this computer (dev/serve.mjs), for the lab's own dev page.
export const LOCAL_RELAY_URL = 'ws://127.0.0.1:8787/';
// The site's dev server talks to the real relay (it's an allowed origin there).
export const SITE_DEV_PORT = '4321';

// Free public STUN servers: each computer asks one for its own public address, so two computers on
// different home networks can reach each other directly. The STUN server sees the computer's address,
// nothing of the call. No TURN yet (rooms-lab-plan.md, section 3): networks that block direct
// connections can't join the call.
export const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

export const TIMES = Object.freeze({
  noRoomRetryMs: 3000,      // a guest whose room isn't there (yet, or after a relay restart) tries again this often…
  noRoomTries: 20,          // …this many times (a minute), then gives up
  askTimeoutMs: 60_000,     // an unanswered "asks to see your screen" closes after a minute
  tileAskTimeoutMs: 180_000, // an unanswered request to open a tile for everyone: three minutes (the host may try it first)
});

export const isLocal = (loc) => loc.hostname === '127.0.0.1' || loc.hostname === 'localhost';

/** The relay this page uses: ?relay= on this computer only (for testing), else the lab's own local relay on
 *  its dev page, else the real one (the live page, and the site's dev server). */
export function relayUrl(loc = globalThis.location) {
  if (!isLocal(loc)) return RELAY_URL;
  const q = new URL(loc.href).searchParams.get('relay');
  if (q && /^wss?:\/\/[^\s]+$/.test(q)) return q;
  return loc.port === SITE_DEV_PORT ? RELAY_URL : LOCAL_RELAY_URL;
}
