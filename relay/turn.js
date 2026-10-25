// turn.js: TURN credentials from Cloudflare, for people whose networks block direct connections
// (rooms-lab-plan.md, section 12; claude/rooms-lab-step7.md).
//
// Most of the time voice and screens go directly between the computers. Some networks (many offices, some
// cafés and mobile networks) block that; then the browsers fall back to a TURN server, which passes the
// media on still encrypted (the browsers encrypt it end to end; Cloudflare sees addresses and timing, not
// what's said or shown).
//
// The TURN key never leaves the relay (Fly secrets TURN_KEY_ID and TURN_KEY_API_TOKEN). For each person who
// has joined a room, the relay asks Cloudflare for credentials that expire after 4 hours and passes them to
// that person's page; the page asks again before they run out. Without the secrets, or if Cloudflare can't be
// reached, `get()` answers null and rooms work as before (direct connections only); the page says so.
//
// Cloudflare: POST https://rtc.live.cloudflare.com/v1/turn/keys/<key id>/credentials/generate-ice-servers
// with `Authorization: Bearer <api token>` and `{ "ttl": <seconds> }` → 201 { iceServers: [{ urls }, { urls,
// username, credential }] }. Its addresses on port 53 are left out: browsers block that port, and a page
// would wait for it to time out.

export const TURN = Object.freeze({
  ttlSeconds: 4 * 60 * 60,      // owner, Oct 24: 4 hours; the page asks again after 3
  timeoutMs: 5000,
  maxServers: 4, maxUrls: 12, maxText: 512,
});

const API = 'https://rtc.live.cloudflare.com/v1/turn/keys';
const KEY_ID = /^[A-Za-z0-9_-]{8,128}$/;
const URL_OK = /^(stun|turns?):[A-Za-z0-9.-]+(:\d{1,5})?(\?transport=(udp|tcp))?$/;
const port53 = (u) => /:53(\?|$)/.test(u);
const text = (x) => typeof x === 'string' && x.length > 0 && x.length <= TURN.maxText;

/** Cloudflare's answer, checked and trimmed: [{ urls: [...], username?, credential? }] or null. */
export function readIceServers(body) {
  const list = body && Array.isArray(body.iceServers) ? body.iceServers : null;
  if (!list) return null;
  const out = [];
  for (const s of list.slice(0, TURN.maxServers)) {
    if (!s || typeof s !== 'object') continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls])
      .filter((u) => typeof u === 'string' && URL_OK.test(u) && !port53(u)).slice(0, TURN.maxUrls);
    if (!urls.length) continue;
    const isTurn = urls.some((u) => u.startsWith('turn'));
    if (isTurn && !(text(s.username) && text(s.credential))) continue;
    out.push(isTurn ? { urls, username: s.username, credential: s.credential } : { urls });
  }
  return out.some((s) => s.username) ? out : null;     // no TURN entry: nothing worth sending
}

export function createTurn({ keyId, apiToken, fetchImpl = globalThis.fetch, ttlSeconds = TURN.ttlSeconds, timeoutMs = TURN.timeoutMs, api = API } = {}) {
  const on = !!(keyId && KEY_ID.test(keyId) && apiToken && fetchImpl);
  return {
    on,
    /** → { iceServers, ttl } or null (switched off, or Cloudflare didn't answer properly). */
    async get() {
      if (!on) return null;
      try {
        const res = await fetchImpl(`${api}/${keyId}/credentials/generate-ice-servers`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ttl: ttlSeconds }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status !== 200 && res.status !== 201) return null;
        const iceServers = readIceServers(await res.json());
        return iceServers ? { iceServers, ttl: ttlSeconds } : null;
      } catch { return null; }
    },
  };
}
