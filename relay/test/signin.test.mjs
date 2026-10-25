// The sign-in check (build step 8, signin.js), with Bluesky's real code: passes made and signed by
// @atproto/crypto keypairs with createServiceJwt, checked around verifyJwt. Account keys and handles are
// looked up by stand-ins here (no network); atproto-signin.js wires in @atproto/identity for real.
// Needs `npm install` (the @atproto packages). ROOMS_ATPROTO_BUNDLE can name a single bundle of the same
// code instead (how the build chat's sandbox runs it: npm is blocked there).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPassChecker, createSignInCheck, didDocument, signInDetail, isHandle,
  AUDIENCE, JOIN_LXM, RELAY_DID, MAX_PASS_SECONDS,
} from '../signin.js';

async function load() {
  if (process.env.ROOMS_ATPROTO_BUNDLE) {
    const b = await import(process.env.ROOMS_ATPROTO_BUNDLE);
    return { crypto: b.crypto, verifyJwt: b.verifyJwt, createServiceJwt: b.createServiceJwt };
  }
  try {
    const crypto = await import('@atproto/crypto');
    const { verifyJwt, createServiceJwt } = await import('@atproto/xrpc-server');
    return { crypto, verifyJwt, createServiceJwt };
  } catch { return null; }
}
const atp = await load();
const skip = !atp && 'the @atproto packages are not installed (npm install)';

const ALICE = 'did:plc:rqbqpaaluty5v47jwciowpik';
const BOB = 'did:plc:joer5rzmwgec3dkr4srfmq45';
const WEBBY = 'did:web:example.com';
const now = () => Math.floor(Date.now() / 1000);

async function setup({ handles = { [ALICE]: 'alice.example', [BOB]: 'bob.example' }, back } = {}) {
  const keys = {
    [ALICE]: await atp.crypto.Secp256k1Keypair.create(),
    [BOB]: await atp.crypto.P256Keypair.create(),         // both kinds of atproto key
    [WEBBY]: await atp.crypto.Secp256k1Keypair.create(),
  };
  const lookups = [];
  const getSigningKey = async (did, force) => {
    lookups.push([did, force]);
    if (!keys[did]) throw new Error(`could not resolve ${did}`);
    return keys[did].did();
  };
  const checkPass = createPassChecker({ verifyJwt: atp.verifyJwt, getSigningKey });
  const backOf = back || Object.fromEntries(Object.entries(handles).map(([d, h]) => [h, d]));
  const check = createSignInCheck({
    checkPass,
    handleOf: async (did) => handles[did] ?? null,
    didOfHandle: async (h) => backOf[h] ?? null,
  });
  const pass = (o = {}) => atp.createServiceJwt({ iss: ALICE, aud: AUDIENCE, lxm: JOIN_LXM, keypair: keys[o.iss || ALICE], ...o });
  return { keys, check, checkPass, pass, lookups };
}
const refused = async (promise, code) => {
  await assert.rejects(promise, (err) => { assert.equal(err.code, code, `${err.code}: ${err.message}`); return true; });
};

test('the relay\'s DID document: did:web at its own name, with the #rooms_relay service; the method name', () => {
  const d = didDocument();
  assert.equal(d.id, RELAY_DID);
  assert.equal(RELAY_DID, 'did:web:relay.rooms.thunderbird.cafe');
  assert.equal(AUDIENCE, 'did:web:relay.rooms.thunderbird.cafe#rooms_relay');
  assert.equal(JOIN_LXM, 'cafe.thunderbird.rooms.join');
  assert.deepEqual(d.service, [{ id: '#rooms_relay', type: 'RoomsRelay', serviceEndpoint: 'https://relay.rooms.thunderbird.cafe' }]);
});

test('handles: domain names only', () => {
  for (const h of ['alice.bsky.social', 'thunderbird.cafe', 'a-b.c-d.example', 'x.y']) assert.ok(isHandle(h), h);
  for (const h of ['', 'nodot', '@alice.bsky.social', 'alice..bsky.social', '-a.example', 'a.example-', 'a b.example', 'a.1x', null, 7, `${'a'.repeat(64)}.example`]) assert.ok(!isHandle(h), String(h));
});

test('a good pass from an account whose handle leads back: { did, handle } (secp256k1, P-256)', { skip }, async () => {
  const { check, pass } = await setup();
  assert.deepEqual(await check(await pass()), { did: ALICE, handle: 'alice.example' });
  assert.deepEqual(await check(await pass({ iss: BOB })), { did: BOB, handle: 'bob.example' });
});

test('only did:plc: a did:web pass is refused ("account type") before anything is looked up (zod, GHSA-mrhx-c7xc-m3w5)', { skip }, async () => {
  const lookups = [];
  const keys = { [WEBBY]: await atp.crypto.Secp256k1Keypair.create() };
  const checkPass = createPassChecker({ verifyJwt: atp.verifyJwt, getSigningKey: async (did) => { lookups.push(did); return keys[did].did(); } });
  const handleLookups = [];
  const check = createSignInCheck({ checkPass, handleOf: async (d) => { handleLookups.push(d); return 'example.com'; }, didOfHandle: async () => WEBBY });
  const webPass = await atp.createServiceJwt({ iss: WEBBY, aud: AUDIENCE, lxm: JOIN_LXM, keypair: keys[WEBBY] });
  await refused(check(webPass), 'AccountType');
  // Even a pass whose payload can't be read first still never reaches a did:web lookup (the guard on the key lookup).
  await refused(createPassChecker({ verifyJwt: async (t, a, l, getKey) => { await getKey(WEBBY, false); return {}; }, getSigningKey: async (d) => { lookups.push(d); return 'x'; } })('a.b.c'), 'AccountType');
  assert.deepEqual(lookups, [], 'no DID document fetched for did:web');
  assert.deepEqual(handleLookups, []);
  assert.equal(signInDetail({ code: 'AccountType' }), 'account type');
});

test('the handle is shown in lower case, and must lead back in lower case too', { skip }, async () => {
  const { check, pass } = await setup({ handles: { [ALICE]: 'Alice.Example' }, back: { 'alice.example': ALICE } });
  assert.deepEqual(await check(await pass()), { did: ALICE, handle: 'alice.example' });
});

test('refused: the handle doesn\'t lead back, leads to someone else, there\'s no handle, or the lookups fail', { skip }, async () => {
  let s = await setup({ back: {} });
  await refused(s.check(await s.pass()), 'HandleMismatch');
  s = await setup({ back: { 'alice.example': BOB } });
  await refused(s.check(await s.pass()), 'HandleMismatch');
  s = await setup({ handles: { [ALICE]: null } });
  await refused(s.check(await s.pass()), 'NoHandle');
  s = await setup({ handles: { [ALICE]: 'not a handle' } });
  await refused(s.check(await s.pass()), 'NoHandle');
  const keys = { [ALICE]: await atp.crypto.Secp256k1Keypair.create() };
  const checkPass = createPassChecker({ verifyJwt: atp.verifyJwt, getSigningKey: async (d) => keys[d].did() });
  const pass = await atp.createServiceJwt({ iss: ALICE, aud: AUDIENCE, lxm: JOIN_LXM, keypair: keys[ALICE] });
  await refused(createSignInCheck({ checkPass, handleOf: async () => { throw new Error('plc down'); }, didOfHandle: async () => ALICE })(pass), 'LookupFailed');
  const pass2 = await atp.createServiceJwt({ iss: ALICE, aud: AUDIENCE, lxm: JOIN_LXM, keypair: keys[ALICE] });
  await refused(createSignInCheck({ checkPass, handleOf: async () => 'alice.example', didOfHandle: async () => { throw new Error('dns down'); } })(pass2), 'LookupFailed');
});

test('refused: another audience (or none of #rooms_relay), another method, no method, expired, too long', { skip }, async () => {
  const { check, pass } = await setup();
  await refused(check(await pass({ aud: 'did:web:relay.daisy.thunderbird.cafe#daisy_relay' })), 'BadJwtAudience');
  await refused(check(await pass({ aud: RELAY_DID })), 'BadJwtAudience');
  await refused(check(await pass({ lxm: 'cafe.thunderbird.daisy.lounge.enter' })), 'BadJwtLexiconMethod');
  await refused(check(await pass({ lxm: null })), 'BadJwtLexiconMethod');
  await refused(check(await pass({ exp: now() - 10 })), 'JwtExpired');
  await refused(check(await pass({ exp: now() + MAX_PASS_SECONDS + 60 })), 'PassTooLong');
});

test('refused: signed by someone else\'s key (after looking the key up again), an unknown account', { skip }, async () => {
  const { check, keys, lookups } = await setup();
  // Signed with another key of the same kind (a different kind is refused before any second lookup).
  const forged = await atp.createServiceJwt({ iss: ALICE, aud: AUDIENCE, lxm: JOIN_LXM, keypair: await atp.crypto.Secp256k1Keypair.create() });
  await refused(check(await atp.createServiceJwt({ iss: ALICE, aud: AUDIENCE, lxm: JOIN_LXM, keypair: keys[BOB] })), 'BadJwtSignature');
  lookups.length = 0;
  await refused(check(forged), 'BadJwtSignature');
  assert.deepEqual(lookups.filter(([d]) => d === ALICE).map(([, f]) => !!f), [false, true], 'looked the key up again before refusing');
  const stranger = await atp.crypto.Secp256k1Keypair.create();
  await refused(check(await atp.createServiceJwt({ iss: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', aud: AUDIENCE, lxm: JOIN_LXM, keypair: stranger })), 'BadPass');
});

test('refused: not an account (a bare did:key vouching for itself, a service), garbage, a used pass', { skip }, async () => {
  const { check, pass } = await setup();
  const k = await atp.crypto.Secp256k1Keypair.create();
  await refused(check(await atp.createServiceJwt({ iss: k.did(), aud: AUDIENCE, lxm: JOIN_LXM, keypair: k })), 'NotAnAccount');
  await refused(check(await pass({ iss: `${ALICE}#atproto_labeler`, keypair: (await setup()).keys[ALICE] })), 'NotAnAccount');
  await refused(check('not.a.pass'), 'BadPass');
  await refused(check('onlyonepart'), 'BadJwt');
  await refused(check(''), 'BadPass');
  await refused(check('x'.repeat(5000)), 'BadPass');
  const once = await pass();
  await check(once);
  await refused(check(once), 'PassUsed');
});

test('what the page is told: a few words, never the account or the server\'s message', () => {
  assert.equal(signInDetail({ code: 'HandleMismatch' }), 'handle');
  assert.equal(signInDetail({ code: 'NoHandle' }), 'handle');
  assert.equal(signInDetail({ code: 'LookupFailed' }), 'lookup');
  assert.equal(signInDetail({ code: 'PassUsed' }), 'pass');
  assert.equal(signInDetail({ code: 'JwtExpired' }), 'pass');
  assert.equal(signInDetail({ code: 'BadJwtSignature' }), 'refused');
  assert.equal(signInDetail({ code: 'NotAnAccount' }), 'refused');
  assert.equal(signInDetail(null), 'refused');
});

test('atproto-signin.js loads Bluesky\'s packages', { skip: (skip || process.env.ROOMS_ATPROTO_BUNDLE) && 'needs the installed packages' }, async () => {
  const m = await import('../atproto-signin.js');
  assert.equal(typeof m.atprotoSignIn(), 'function');
});
