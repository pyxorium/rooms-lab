// formats.js: what the relay accepts (a copy of the checks in relay/rooms.js, which can't be imported
// here: it uses Node's crypto). test/formats.test.mjs checks that the two agree.
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

const LETTERS = 'abcdefghijkmnopqrstuvwxyz23456789';      // no l, 0, 1: easy to read out loud
const random = (n, letters = LETTERS) => {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => letters[b % letters.length]).join('');
};
/** A new room's code: 12 letters and digits (about 60 bits), hard to guess. */
export const newRoomCode = () => random(12);
/** This page load's id in the room (others see it; it isn't a secret). */
export const newPeerId = () => random(16, 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789');

/** `#r=<code>` (an invite) or `#r=<code>&k=<host key>` (the private host link). */
export function readRoomHash(hash = '') {
  const q = new URLSearchParams(String(hash).replace(/^#/, ''));
  const room = q.get('r'), key = q.get('k');
  return { room: isRoomCode(room) ? room : null, hostKey: isHostKey(key) ? key : null };
}

/** The link to send people: this page's address with the room in the hash. On this computer the ?relay=
 *  testing switch goes along, so every window uses the same relay. */
export function inviteLink(loc, room) {
  const u = new URL(loc.href);
  const keep = new URLSearchParams();
  // On this computer only: the test relay and (the site's page) the test loading server, kept for whoever joins.
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
    for (const k of ['relay', 'loader']) { const v = u.searchParams.get(k); if (v) keep.set(k, v); }
  }
  const q = keep.toString();
  return `${u.origin}${u.pathname}${q ? `?${q}` : ''}#r=${room}`;
}
/** The host's private link: whoever opens it is the host. */
export const hostLink = (loc, room, key) => `${inviteLink(loc, room)}&k=${key}`;
