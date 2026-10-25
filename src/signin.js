// signin.js: optional sign-in for the Rooms lab page (build step 8; claude/rooms-signin-plan.md).
//
// Signing in is a label, not a gate: the room shows a signed-in person's handle with a check mark, and
// everyone else keeps a typed name marked unverified. The page asks only for the "Rooms" permission set
// (config.js SCOPE): it lets the page ask the person's own server for a one-minute pass to this room's relay
// (com.atproto.server.getServiceAuth, aud = the relay, lxm = cafe.thunderbird.rooms.join). The relay checks
// the pass and the handle (both ways) and tells the room; the pages never see anyone's pass or DID.
//
// Uses @atproto/oauth-client-browser (0.5.8, as the Foundry, Seven-Up, Daisy and Raku), in a small window
// (the library's popup sign-in), modelled on the site's src/daisy/auth.js. The library keeps the sign-in in
// this browser (IndexedDB) until the person signs out, so rejoining (or getting the host role back) needs no
// new window. createSignIn takes the library's exports, so the browser checks can hand in a stand-in.
//
// The clash (decision 2): every sign-in on one site shares the library's store, filed by account only, and
// a new sign-in cancels that account's other sign-in on the site first. So signing in here replaces that
// account's Daisy or Seven-Up sign-in in this browser (and the reverse). The other page still looks signed in
// (it borrows this sign-in, same account), but can't save until it signs in again (checked with the real
// library, Oct 25). clashFor() looks in that store, before the sign-in window opens, so the page warns only
// when it applies; when the store can't be read it says it may. Sign out cancels only a Rooms sign-in.
import { CLIENT_ID, SCOPE, RELAY_AUDIENCE, JOIN_LXM, SIGNIN_HANDLE_RESOLVER, hasJoinScope, isLocal } from './config.js';

const WINDOW_NAME = 'rooms-lab-signin';
const WINDOW_FEATURES = 'width=600,height=700,menubar=no,toolbar=no';
export const ACCOUNT_KEY = 'rooms-lab-account';            // localStorage: { did, handle } of the account signed in here
export const LIBRARY_DB = '@atproto-oauth-client';          // the library's store (IndexedDB), shared by the whole site

export class SignInNeeded extends Error {}

/** A typed handle, tidied: no "@", no spaces, lower case. Null when it can't be one. */
export function cleanHandle(x) {
  const s = String(x || '').trim().replace(/^@+/, '').toLowerCase();
  if (s.length < 3 || s.length > 253 || !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(s)) return null;
  return s;
}

// On this computer: a loopback sign-in (no description file needed; the sign-in server builds one from this
// address). The page must be opened at 127.0.0.1, not localhost (the library moves it there).
export function clientIdFor(loc = globalThis.location) {
  if (!isLocal(loc)) return CLIENT_ID;
  const port = loc.port ? `:${loc.port}` : '';
  return `http://localhost?redirect_uri=${encodeURIComponent(`http://127.0.0.1${port}${loc.pathname}`)}&scope=${encodeURIComponent(SCOPE)}`;
}

// Which other page on this site an account is signed in to here, from the scope its sign-in was granted.
export function pageOfScope(scope) {
  const s = String(scope || '');
  if (hasJoinScope(s)) return null;                         // already a Rooms sign-in: nothing to lose
  if (s.includes('cafe.thunderbird.daisy')) return 'Daisy';
  if (s.includes('cafe.thunderbird.sevenup')) return 'Seven-Up';
  return 'another page on this site';
}

/** The scope of each account's sign-in in the library's store: Map(did → scope), or null when it can't be read.
 *  Reads only, and never creates the store (opening a missing database would make an empty one the library
 *  then couldn't set up). */
export async function storedScopes(idb = globalThis.indexedDB) {
  try {
    if (!idb || typeof idb.databases !== 'function') return null;
    const dbs = await idb.databases();
    if (!dbs.some((d) => d && d.name === LIBRARY_DB)) return new Map();
    const db = await new Promise((resolve, reject) => {
      const req = idb.open(LIBRARY_DB);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onupgradeneeded = () => { req.transaction.abort(); reject(new Error('no store')); };
    });
    try {
      if (!db.objectStoreNames.contains('session')) return null;
      const store = db.transaction(['session'], 'readonly').objectStore('session');
      const [keys, values] = await Promise.all([store.getAllKeys(), store.getAll()].map((req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); })));
      const out = new Map();
      keys.forEach((k, i) => {
        const scope = values[i]?.value?.tokenSet?.scope;
        if (typeof k === 'string' && typeof scope === 'string') out.set(k, scope);
      });
      return out;
    } finally { db.close(); }
  } catch { return null; }
}

export function createSignIn(lib, {
  loc = globalThis.location,
  storage = (() => { try { return globalThis.localStorage; } catch { return null; } })(),
  idb = globalThis.indexedDB,
  fetchImpl = (...a) => globalThis.fetch(...a),
  handleResolver = SIGNIN_HANDLE_RESOLVER,
} = {}) {
  let client = null;
  let session = null;                                   // the account signed in here (one at a time)
  let account = null;                                   // { did, handle }
  const listeners = new Set();
  const changed = () => listeners.forEach((fn) => { try { fn(account); } catch { /* fine */ } });

  const readKept = () => { try { const a = JSON.parse(storage?.getItem(ACCOUNT_KEY) || 'null'); return a && typeof a.did === 'string' && typeof a.handle === 'string' ? a : null; } catch { return null; } };
  const keep = (a) => { try { if (a) storage?.setItem(ACCOUNT_KEY, JSON.stringify(a)); else storage?.removeItem(ACCOUNT_KEY); } catch { /* private window */ } };

  async function scopeOf(s) {
    try { return (await s.getTokenInfo())?.scope || ''; } catch { return ''; }
  }

  return {
    // Once per page load, before the page mounts. In the sign-in window itself this finishes the sign-in and
    // returns { finishedInWindow: true } (the library then closes the window).
    async start() {
      if (!lib || !lib.BrowserOAuthClient) return { unavailable: true };
      try {
        client = await lib.BrowserOAuthClient.load({ clientId: clientIdFor(loc), handleResolver });
        await client.init();
        client.addEventListener?.('deleted', (e) => {
          if (account && e?.detail?.sub === account.did) { session = null; account = null; keep(null); changed(); }
        });
      } catch (err) {
        if ((lib.LoginContinuedInParentWindowError && err instanceof lib.LoginContinuedInParentWindowError) || err?.code === 'LOGIN_CONTINUED_IN_PARENT_WINDOW') return { finishedInWindow: true };
        if (/Redirecting to loopback/.test(String(err?.message))) return { moving: true };
        console.error('[rooms-lab] sign-in could not start', err);
        client = null;
        return { error: err };
      }
      // Still signed in from last time? (Quietly: no window.)
      const kept = readKept();
      if (kept) {
        try {
          const s = await client.restore(kept.did);
          if (hasJoinScope(await scopeOf(s))) { session = s; account = kept; } else keep(null);
        } catch { keep(null); }
      }
      return {};
    },
    ready: () => !!client,
    get account() { return account; },
    onChange: (fn) => listeners.add(fn),

    // Call straight from a click, before anything that waits: browsers only allow a new window then.
    openWindow() {
      try { return window.open('about:blank', WINDOW_NAME, WINDOW_FEATURES); } catch { return null; }
    },

    async signIn(handle, signal) {
      const s = await client.signInPopup(handle, { popupName: WINDOW_NAME, popupFeatures: WINDOW_FEATURES, signal, scope: SCOPE });
      if (!hasJoinScope(await scopeOf(s))) {
        try { await client.revoke(s.did); } catch { /* fine */ }
        throw new Error('The sign-in didn’t include the Rooms permission.');
      }
      session = s;
      account = { did: s.did, handle: cleanHandle(handle) || handle };
      keep(account);
      changed();
      return account;
    },

    // The relay tells the room the handle it checked; keep that spelling for the lobby.
    sawHandle(handle) {
      if (account && typeof handle === 'string' && handle && handle !== account.handle) { account = { ...account, handle }; keep(account); }
    },

    // A pass for the relay: a short token from the account's own server, addressed to this relay and to
    // joining only. Good for a minute; each one is used once (so each join or rejoin asks for a new one).
    async getPass() {
      if (!session) throw new SignInNeeded('signed out');
      const q = new URLSearchParams({ aud: RELAY_AUDIENCE, lxm: JOIN_LXM, exp: String(Math.floor(Date.now() / 1000) + 60) });
      let res;
      try {
        res = await session.fetchHandler(`/xrpc/com.atproto.server.getServiceAuth?${q}`, { method: 'GET' });
      } catch (err) {
        if (/token|session|refresh|revoked|auth/i.test(String(err && (err.name + ' ' + err.message)))) throw new SignInNeeded(String(err.message));
        throw err;
      }
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) throw new SignInNeeded(body.message || 'not allowed');
      if (!res.ok || typeof body.token !== 'string') throw new Error(body.message || `The account's server answered ${res.status}`);
      return body.token;
    },

    // Sign out. The store is shared by the whole site and keeps one sign-in per account, so the one there now
    // may belong to Daisy or Seven-Up (signed in after Rooms). Cancel it only if it's a Rooms sign-in (it holds
    // the Rooms permission); otherwise just forget the account here and leave the other page's sign-in alone.
    async signOut() {
      const did = account?.did;
      session = null; account = null; keep(null); changed();
      if (!did) return;
      let ours = false;
      try { ours = hasJoinScope(await scopeOf(await client.restore(did))); } catch { /* nothing there: nothing to cancel */ }
      if (ours) { try { await client.revoke(did); } catch { /* already gone */ } }
    },
    forget() { session = null; account = null; keep(null); changed(); },

    // Before the sign-in window: would signing in as this handle sign it out of another page here?
    // → { did, page } ("Daisy", "Seven-Up", "another page on this site"), { page: null } (no), or
    //   { unknown: true } (the store or the handle couldn't be read: say it may).
    async clashFor(handle) {
      const h = cleanHandle(handle);
      if (!h) return { page: null };
      let did = null;
      try {
        const res = await fetchImpl(`${handleResolver}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(h)}`);
        if (res.ok) did = (await res.json())?.did || null;
        else if (res.status === 400) return { page: null };    // no such handle: the sign-in will say so
      } catch { /* unknown below */ }
      if (!did) return { unknown: true };
      const scopes = await storedScopes(idb);
      if (!scopes) return { unknown: true };
      return { did, page: scopes.has(did) ? pageOfScope(scopes.get(did)) : null };
    },
  };
}
