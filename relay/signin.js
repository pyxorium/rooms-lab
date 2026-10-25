// signin.js: the relay's own identity, and the check behind a verified handle (build step 8, optional
// sign-in; claude/rooms-signin-plan.md). No network parts here, so it's tested in Node with stand-ins;
// atproto-signin.js wires in Bluesky's packages for the real relay.
//
// Signing in is a label, not a gate: anyone with the link can still join under a typed name (marked
// unverified). Someone who signs in joins with a pass, and the room shows their handle with a check mark.
//
// A pass is an atproto service-auth token: the page asks the person's own server (PDS), through
// com.atproto.server.getServiceAuth, for a short signed token addressed to this relay and to one method:
//   aud = did:web:relay.rooms.thunderbird.cafe#rooms_relay      lxm = cafe.thunderbird.rooms.join
// The page can only ask for it if the person agreed to the "Rooms" permission set when signing in
//   include:cafe.thunderbird.rooms.authJoin?aud=did:web:relay.rooms.thunderbird.cafe%23rooms_relay
// (it expands to rpc:cafe.thunderbird.rooms.join?aud=…%23rooms_relay; nothing else). The PDS signs the pass
// with the account's own key, so the relay can check, from the account's public DID document, that the
// account named in the pass really asked for it.
//
// The check (as Daisy's lounge, C:\thunderbird-cafe\daisy-relay\lounge-auth.js):
//   1. the pass itself: Bluesky's verifyJwt (format, expiry, audience, method, signature, a fresh key lookup
//      if the cached one fails); only did:plc accounts (never a service or a bare did:key, and not did:web: see
//      below); a pass may not ask to last more than 5 minutes; each pass works once;
//   2. the handle, both ways: the account's DID document names the handle, and the handle leads back to the
//      same DID. Only then is the handle shown to the room. (The relay alone vouches: the pages never see
//      the pass or the DID; decision 3.)
// Only did:plc (owner, Oct 25): Bluesky's identity package checks every DID document with zod, and zod 3 can
// run out of memory on an oversized document (GHSA-mrhx-c7xc-m3w5; no fix for zod 3). The document is looked up
// before the signature is checked, so any pass merely naming a did:web account would make the relay fetch a
// document from a domain its author controls. did:plc documents come from plc.directory. A did:web pass is
// refused before any lookup ("AccountType"); that person joins with a typed name.
//
// The relay keeps the DID in memory only while the person is in the room (for "the host by account" and
// "one live connection per account"), never logs it, never sends it to anyone.
export const RELAY_HOST = 'relay.rooms.thunderbird.cafe';
export const RELAY_DID = `did:web:${RELAY_HOST}`;
export const SERVICE_ID = 'rooms_relay';
export const AUDIENCE = `${RELAY_DID}#${SERVICE_ID}`;
export const JOIN_LXM = 'cafe.thunderbird.rooms.join';
export const MAX_PASS_SECONDS = 5 * 60;
export const MAX_PASS_LENGTH = 4096;

// The relay's DID document, served at https://relay.rooms.thunderbird.cafe/.well-known/did.json.
export function didDocument(host = RELAY_HOST) {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: `did:web:${host}`,
    service: [{ id: `#${SERVICE_ID}`, type: 'RoomsRelay', serviceEndpoint: `https://${host}` }],
  };
}

export class SignInError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const isAccountDid = (s) => typeof s === 'string' && /^did:plc:[a-z2-7]{24}$/.test(s);
const isWebDid = (s) => typeof s === 'string' && s.startsWith('did:web:');
// A handle as atproto writes them: a domain name, 2 to 253 characters, labels of letters, digits and hyphens.
export const isHandle = (s) => typeof s === 'string' && s.length <= 253
  && /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(s);

// verifyJwt: (token, audience, lxm, getSigningKey) → payload, as @atproto/xrpc-server's.
// getSigningKey: (did, forceRefresh) → the account's did:key, as @atproto/identity's resolveAtprotoKey.
export function createPassChecker({ verifyJwt, getSigningKey, audience = AUDIENCE, lxm = JOIN_LXM, now = () => Date.now() }) {
  const used = new Map();       // `${iss} ${jti}` → expiry (ms): each pass works once
  return async function checkPass(token) {
    if (typeof token !== 'string' || !token || token.length > MAX_PASS_LENGTH) throw new SignInError('BadPass', 'not a pass');
    // Only accounts: never let a pass name a service (did#…) or a bare did:key (it would vouch for itself).
    let issGuess = null;
    try { issGuess = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8')).iss; } catch { /* verifyJwt says why */ }
    if (isWebDid(issGuess)) throw new SignInError('AccountType', 'only did:plc accounts can sign in here');
    if (issGuess !== null && issGuess !== undefined && !isAccountDid(issGuess)) throw new SignInError('NotAnAccount', 'the pass must come from an account (did:plc)');
    // Belt and braces: never look up a document for anything but a did:plc account.
    const lookUp = (did, forceRefresh) => {
      if (!isAccountDid(did)) throw new SignInError(isWebDid(did) ? 'AccountType' : 'NotAnAccount', 'only did:plc accounts can sign in here');
      return getSigningKey(did, forceRefresh);
    };
    let payload;
    try {
      payload = await verifyJwt(token, audience, lxm, lookUp);
    } catch (err) {
      if (err instanceof SignInError) throw err;
      throw new SignInError((err && err.error) || 'BadPass', String((err && err.message) || err));
    }
    if (!isAccountDid(payload.iss)) throw new SignInError(isWebDid(payload.iss) ? 'AccountType' : 'NotAnAccount', 'only did:plc accounts can sign in here');
    const t = now();
    if (payload.exp * 1000 - t > MAX_PASS_SECONDS * 1000) throw new SignInError('PassTooLong', `a pass may last at most ${MAX_PASS_SECONDS / 60} minutes`);
    if (typeof payload.jti !== 'string' || !payload.jti) throw new SignInError('NoPassId', 'the pass has no id (jti)');
    for (const [k, exp] of used) if (exp < t) used.delete(k);
    const key = `${payload.iss} ${payload.jti}`;
    if (used.has(key)) throw new SignInError('PassUsed', 'this pass was used already');
    used.set(key, payload.exp * 1000);
    return { did: payload.iss };
  };
}

// checkPass: as above. handleOf(did) → the handle the account's DID document names (or null).
// didOfHandle(handle) → the DID the handle leads to (DNS or https; null when it leads nowhere).
// Returns { did, handle } (the handle in lower case), or throws a SignInError:
//   BadPass, PassUsed, NotAnAccount, PassTooLong, NoPassId, BadJwtSignature, … (the pass);
//   NoHandle (the DID document names none), HandleMismatch (the handle doesn't lead back), LookupFailed.
export function createSignInCheck({ checkPass, handleOf, didOfHandle }) {
  return async function check(pass) {
    const { did } = await checkPass(pass);
    let handle;
    try { handle = await handleOf(did); } catch (err) { throw new SignInError('LookupFailed', `the account's DID document couldn't be read: ${String(err?.message || err).slice(0, 120)}`); }
    if (!isHandle(handle)) throw new SignInError('NoHandle', 'the account has no handle');
    handle = handle.toLowerCase();
    let back;
    try { back = await didOfHandle(handle); } catch (err) { throw new SignInError('LookupFailed', `the handle couldn't be looked up: ${String(err?.message || err).slice(0, 120)}`); }
    if (back !== did) throw new SignInError('HandleMismatch', 'the handle doesn\'t lead back to the account');
    return { did, handle };
  };
}

// What the page is told when a sign-in isn't accepted ({ t: "error", why: "sign-in", detail }): one of a few
// words, never the account or the server's message.
export function signInDetail(err) {
  const code = err && err.code;
  if (code === 'NoHandle' || code === 'HandleMismatch') return 'handle';
  if (code === 'LookupFailed') return 'lookup';
  if (code === 'Unavailable') return 'unavailable';
  if (code === 'AccountType') return 'account type';
  if (code === 'TooMany') return 'too many';
  if (code === 'PassUsed' || code === 'JwtExpired' || code === 'BadJwt' || code === 'BadPass' || code === 'NoPassId' || code === 'PassTooLong') return 'pass';
  return 'refused';
}
