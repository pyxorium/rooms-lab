// atproto-signin.js: the sign-in check (signin.js) wired to Bluesky's own packages (build step 8), as Daisy's
// relay does for its lounge (C:\thunderbird-cafe\daisy-relay\atproto-pass.js):
//   - verifyJwt from @atproto/xrpc-server;
//   - account keys and DID documents from @atproto/identity (did:plc through plc.directory, did:web through
//     the account's own domain), cached in memory for an hour, refreshed when a signature doesn't match;
//   - the handle checked both ways: the handle the DID document names must lead back (DNS TXT _atproto, or
//     https://<handle>/.well-known/atproto-did) to the same DID.
// server.js loads this file the first time someone joins signed in; without the packages, sign-in says it's
// unavailable and rooms carry on with typed names.
import { verifyJwt } from '@atproto/xrpc-server';
import { IdResolver, MemoryCache } from '@atproto/identity';
import { createPassChecker, createSignInCheck } from './signin.js';

export function atprotoSignIn(opts = {}) {
  const idResolver = new IdResolver({ didCache: new MemoryCache(), timeout: 5000 });
  const checkPass = createPassChecker({
    verifyJwt,
    getSigningKey: (did, forceRefresh) => idResolver.did.resolveAtprotoKey(did, forceRefresh),
    ...opts,
  });
  return createSignInCheck({
    checkPass,
    // The first at:// name in the DID document's alsoKnownAs (as Bluesky's own getHandle).
    handleOf: async (did) => {
      const doc = await idResolver.did.resolve(did);
      if (!doc) throw new Error('no DID document');
      const aka = (Array.isArray(doc.alsoKnownAs) ? doc.alsoKnownAs : []).find((a) => typeof a === 'string' && a.startsWith('at://'));
      return aka ? aka.slice('at://'.length) : null;
    },
    didOfHandle: async (handle) => (await idResolver.handle.resolve(handle)) || null,
  });
}
