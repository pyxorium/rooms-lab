// config.js: the Rooms lab's addresses and timings in one place (rooms-lab-plan.md, sections 4 and 7).

// The relay (thunderbird-rooms-relay on Fly.io; C:\thunderbird-cafe\rooms-lab\relay). It lets in Raku
// (https://raku.lexicographer.space, and 127.0.0.1:5180 / :5181 on this computer); the lab page on thunderbird.cafe
// retired Oct 29 2026. Raku passes its own relay address (relayUrl option).
export const RELAY_URL = 'wss://relay.rooms.thunderbird.cafe/';
// The relay `npm run dev` starts on this computer (dev/serve.mjs), for the lab's own dev page.
export const LOCAL_RELAY_URL = 'ws://127.0.0.1:8787/';

// Free public STUN servers: each computer asks one for its own public address, so two computers on
// different home networks can reach each other directly. The STUN server sees the computer's address,
// nothing of the call. On networks that block direct connections, TURN takes over (step 7): the relay hands
// each page Cloudflare TURN credentials for 4 hours (relay/turn.js), added to these.
export const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];

export const TIMES = Object.freeze({
  noRoomRetryMs: 3000,      // a guest whose room isn't there (yet, or after a relay restart) tries again this often…
  noRoomTries: 20,          // …this many times (a minute), then gives up
  askTimeoutMs: 60_000,     // an unanswered "asks to see your screen" closes after a minute
  tileAskTimeoutMs: 180_000, // an unanswered request to open a tile for everyone: three minutes (the host may try it first)
  iceWaitMs: 4000,          // connections wait this long for the relay's TURN credentials, then start without them
  iceRefreshMs: 3 * 60 * 60_000, // credentials last 4 hours (relay/turn.js): ask for fresh ones after 3
});

export const isLocal = (loc) => loc.hostname === '127.0.0.1' || loc.hostname === 'localhost';

/** The relay a page uses when its host page names none: ?relay= on this computer only (for testing), else the
 *  dev page's own local relay, else the real one. */
export function relayUrl(loc = globalThis.location) {
  if (!isLocal(loc)) return RELAY_URL;
  const q = new URL(loc.href).searchParams.get('relay');
  if (q && /^wss?:\/\/[^\s]+$/.test(q)) return q;
  return LOCAL_RELAY_URL;
}

// ---- Optional sign-in (build step 8; claude/rooms-signin-plan.md) ----
// A label, not a gate: signing in lets the room show your verified handle; everyone else types a name.
// The page asks only for the "Rooms" permission set (lexicons/cafe.thunderbird.rooms.authJoin.json, published
// from thunderbird.cafe): a pass for this relay's join, nothing else in the account.
export const RELAY_AUDIENCE = 'did:web:relay.rooms.thunderbird.cafe#rooms_relay';
export const JOIN_LXM = 'cafe.thunderbird.rooms.join';
export const SCOPE = `atproto include:cafe.thunderbird.rooms.authJoin?aud=${RELAY_AUDIENCE.replace('#', '%23')}`;
// The live page's sign-in description (site/oauth.json, copied to the site's public/webtiles/rooms-lab/).
export const PAGE_PATH = '/webtiles/rooms-lab/';
export const CLIENT_ID = `https://thunderbird.cafe${PAGE_PATH}oauth.json`;
// Where a typed handle is looked up (as the Foundry, Seven-Up and Daisy).
export const SIGNIN_HANDLE_RESOLVER = 'https://bsky.social';
/** Did the sign-in server grant the pass for this relay? (The set expands to this rpc permission.) */
export const hasJoinScope = (scope) => String(scope || '').split(/\s+/).some((s) => s.startsWith(`rpc:${JOIN_LXM}?`) || s === `rpc:${JOIN_LXM}`)
  || String(scope || '').includes('include:cafe.thunderbird.rooms.authJoin');
