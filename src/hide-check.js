// hide-check.js: would Raku refuse this tile? (rooms-lab-plan.md, section 10: "Hide list? yes, check shared
// tiles the way Raku does".) Each person's page checks for itself before opening a tile someone opened for
// everyone, so a room never shows a tile Raku would refuse, and nobody learns what anyone opens.
//
// The same two checks as Raku's src/moderation.js (COPY of its logic, Oct 23 2026, without the parts rooms
// don't need: profiles, avatars, card pictures):
// 1. The hide list, coded: https://lexicographer.space/hidden-tiles.json holds only SHA-256 hashes
//      { "version": 1, "salt": "<text>", "accounts": ["<hex>", …], "tiles": ["<hex>", …] }
//      account hash = sha256(salt + "\n" + did)
//      tile hash    = sha256(salt + "\n" + did + "\n" + rkey)
//    downloaded when first needed and about every hour; if a download fails, the last copy (kept in this
//    browser) stays in use. (test/hide-check.test.mjs checks the same agreed hashes as Raku and the viewer.)
// 2. Bluesky's moderation: an account taken down, or labelled !takedown / !hide by moderation.bsky.app (not
//    negated, not expired). Answers kept 10 minutes. If Bluesky can't be reached, the tile is shown (as Raku).
// It never says which list hid a tile, or why.

export const HIDE_LIST_URL = 'https://lexicographer.space/hidden-tiles.json';
export const BLUESKY_API = 'https://public.api.bsky.app';
export const BLUESKY_MODERATION = 'did:plc:ar7c4by46qjdydhdevvrndac';   // moderation.bsky.app
export const TIMES = Object.freeze({ listRecheckMs: 60 * 60 * 1000, keepMs: 10 * 60 * 1000, lookupMs: 8000 });
const STORE_KEY = 'rooms-lab-hide-list';

const enc = new TextEncoder();
export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const accountKey = (salt, did) => `${salt}\n${did}`;
export const tileKey = (salt, did, rkey) => `${salt}\n${did}\n${rkey}`;

const HEX64 = /^[0-9a-f]{64}$/;
/** A downloaded coded list, checked → { salt, accounts: Set, tiles: Set } or null. */
export function parseCodedList(json) {
  if (!json || json.version !== 1 || typeof json.salt !== 'string' || !json.salt) return null;
  if (!Array.isArray(json.accounts) || !Array.isArray(json.tiles)) return null;
  if (![...json.accounts, ...json.tiles].every((x) => typeof x === 'string' && HEX64.test(x))) return null;
  return { salt: json.salt, accounts: new Set(json.accounts), tiles: new Set(json.tiles) };
}

/** Is this one of Bluesky's "hide this account" labels, still in force? */
export function hidingLabel(label, now = Date.now()) {
  if (!label || label.src !== BLUESKY_MODERATION || label.neg) return false;
  if (label.val !== '!takedown' && label.val !== '!hide') return false;
  if (label.exp && Date.parse(label.exp) <= now) return false;
  return true;
}

export function createHideCheck({ fetchImpl = (...a) => globalThis.fetch(...a), listUrl = HIDE_LIST_URL, now = () => Date.now(), storage = null, times = TIMES } = {}) {
  let list = null, listAt = 0, loading = null;
  const bsky = new Map();      // did → { at, hidden }

  async function getJson(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), times.lookupMs);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { ok: res.ok, status: res.status, json };
    } finally { clearTimeout(timer); }
  }

  function refresh() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const r = await getJson(listUrl);
        const parsed = r.ok ? parseCodedList(r.json) : null;
        if (parsed) { list = parsed; listAt = now(); try { storage?.setItem(STORE_KEY, JSON.stringify(r.json)); } catch { /* fine */ } return true; }
      } catch { /* keep the last copy */ }
      if (!list) { try { const s = storage?.getItem(STORE_KEY); if (s) list = parseCodedList(JSON.parse(s)); } catch { /* none */ } }
      listAt = now();          // try again in an hour either way
      return false;
    })().finally(() => { loading = null; });
    return loading;
  }

  async function onHideList(did, rkey) {
    if (!list || now() - listAt > times.listRecheckMs) await refresh();
    if (!list) return false;
    if (list.accounts.has(await sha256Hex(accountKey(list.salt, did)))) return true;
    return rkey ? list.tiles.has(await sha256Hex(tileKey(list.salt, did, rkey))) : false;
  }

  async function hiddenByBluesky(did) {
    const k = bsky.get(did);
    if (k && now() - k.at < times.keepMs) return k.hidden;
    let hidden = false;
    try {
      const r = await getJson(`${BLUESKY_API}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`);
      if (r.status === 400 && /AccountTakedown/.test(r.json?.error || '')) hidden = true;
      else if (r.ok) hidden = (r.json?.labels || []).some((l) => hidingLabel(l, now()));
      else if (r.status >= 500) return false;                  // not kept: ask again next time
    } catch {
      return false;                                             // can't reach Bluesky: shown, not kept
    }
    bsky.set(did, { at: now(), hidden });
    return hidden;
  }

  return {
    refresh,
    /** Is this tile (or its whole account) hidden? Never says which list or why. */
    async isHidden(did, rkey) {
      const [a, b] = await Promise.all([onHideList(did, rkey), hiddenByBluesky(did)]);
      return a || b;
    },
    get loaded() { return !!list; },
  };
}
