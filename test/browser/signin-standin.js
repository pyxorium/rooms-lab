// signin-standin.js: a stand-in for @atproto/oauth-client-browser in the browser checks (check_signin.mjs puts it
// in each page before it starts, as window.__roomsLabSignInLib). The real library can't run in the sandbox (no
// npm there, and no real sign-in servers). It behaves like the real one where the page depends on it:
//   - sessions live in the library's own IndexedDB store ('@atproto-oauth-client', object store 'session'),
//     keyed by account DID only, each as { value: { tokenSet: { sub, scope, … } }, expiresAt }, so the page's
//     clash check reads what the real library would leave there (signin.js storedScopes);
//   - a new sign-in for an account first removes that account's other sign-in on the site (the real library
//     revokes it), whichever page made it;
//   - the scope granted is the expanded one a real server returns for the "Rooms" set;
//   - fetchHandler sends requests to the account's server (here https://pds.standin.test, answered by the
//     check in Node, which signs real passes with Bluesky's code).
// window.__standinAccounts = { handle: did } (set by the check) says which handles exist.
(() => {
  const DB = '@atproto-oauth-client';
  const STORES = ['state', 'session', 'didCache', 'dpopNonceCache', 'handleCache', 'authorizationServerMetadataCache', 'protectedResourceMetadataCache'];
  const GRANTED = 'atproto rpc:cafe.thunderbird.rooms.join?aud=did:web:relay.rooms.thunderbird.cafe%23rooms_relay';
  const log = (window.__standinLog = window.__standinLog || []);
  const openDb = () => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { for (const n of STORES) req.result.createObjectStore(n, { autoIncrement: true }).createIndex('expiresAt', 'expiresAt', { unique: false }); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  async function run(mode, fn) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const t = db.transaction(['session'], mode);
        const req = fn(t.objectStore('session'));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
      });
    } finally { db.close(); }
  }
  const sessionFor = (did, scope) => ({
    did, sub: did,
    async getTokenInfo() { return { sub: did, scope }; },
    async fetchHandler(path, init = {}) {
      const u = new URL(`https://pds.standin.test${path}`);
      u.searchParams.set('standin_did', did);
      log.push(['fetch', path.split('?')[0]]);
      return fetch(u, { method: init.method || 'GET' });
    },
  });

  class BrowserOAuthClient {
    static async load({ clientId, handleResolver }) { log.push(['load', clientId, handleResolver]); return new BrowserOAuthClient(); }
    async init() { return {}; }
    addEventListener() {}
    async signInPopup(handle, { popupName, scope } = {}) {
      log.push(['signInPopup', handle, scope]);
      try { window.open('', popupName)?.close(); } catch { /* fine */ }
      await new Promise((r) => setTimeout(r, 50));
      const did = (window.__standinAccounts || {})[handle];
      if (!did) throw new Error(`Failed to resolve identity: ${handle}`);
      await run('readwrite', (s) => s.delete(did));                 // the account's other sign-in on this site goes
      await run('readwrite', (s) => s.put({ value: { tokenSet: { sub: did, scope: GRANTED, iss: 'https://pds.standin.test' } }, expiresAt: null }, did));
      return sessionFor(did, GRANTED);
    }
    async restore(did) {
      const item = await run('readonly', (s) => s.get(did));
      if (!item) throw new Error('no session');
      log.push(['restore', did]);
      return sessionFor(did, item.value.tokenSet.scope);
    }
    async revoke(did) { log.push(['revoke', did]); await run('readwrite', (s) => s.delete(did)); }
  }
  class LoginContinuedInParentWindowError extends Error {}
  window.__roomsLabSignInLib = { BrowserOAuthClient, LoginContinuedInParentWindowError };
  // For the check: put another page's sign-in (Daisy's, say) in the store, as the real library would.
  window.__standinPutSession = (did, scope) => run('readwrite', (s) => s.put({ value: { tokenSet: { sub: did, scope } }, expiresAt: null }, did));
  window.__standinScopeOf = async (did) => (await run('readonly', (s) => s.get(did)))?.value?.tokenSet?.scope || null;
})();
