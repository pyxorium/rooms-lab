// Publishes the Rooms lab's tiles (the house, the live poll) and its lexicon (the "Rooms" permission set,
// step 8) from the thunderbird.cafe account (modelled on daisy-tiles' scripts/publish.mjs). Run from
// C:\thunderbird-cafe\rooms-lab (Node 22, no packages needed):
//
//   node scripts/publish.mjs                 publish every tile that isn't published yet, and the lexicon
//                                            when it's new or changed
//   node scripts/publish.mjs poll            only that tile (house, poll), if it isn't published yet
//   node scripts/publish.mjs --dry-run …     show what would be published; ask nothing, write nothing
//   node scripts/publish.mjs --again house   publish that tile again, as a new record (a new address);
//                                            --again needs the tile's name, so nothing is republished by accident
//
// It shows what will be published, asks for the account's app password (hidden as you type) and once
// more before writing. The tile is always created as a new record (never overwriting). What was published
// is written to published.json, which the site's copy (build step 5) pins: the page loads exactly that
// record (its CID) and refuses a changed one.
//
// The lexicon (lexicons\cafe.thunderbird.rooms.authJoin.json) is put as com.atproto.lexicon.schema under its own
// name, and only when it's new or changed (naming a tile publishes that tile only). Sign-in servers find it
// through the Wix TXT record _lexicon.rooms (value did=<thunderbird.cafe's DID>), and cache it up to a day.
import readline from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, TILES, publishFiles, cspOf } from './tiles.mjs';
import { rawCid } from './lib/cid.js';
import { publishTile, publishLexicon } from './lib/tile-record.js';

export const ACCOUNT = 'did:plc:6vxjigxrqizmbo56gojxico3';     // thunderbird.cafe
export const PUBLISHED_FILE = join(ROOT, 'published.json');
const GENERATOR = 'Rooms lab';
export const LEXICON_IDS = [
  'cafe.thunderbird.rooms.authJoin',      // permission set "Rooms": a pass for the relay, to show a verified handle (step 8)
];
export const readLexicons = () => LEXICON_IDS.map((id) => JSON.parse(readFileSync(join(ROOT, 'lexicons', `${id}.json`), 'utf8')));

async function getJson(fetchImpl, url, init) {
  const res = await fetchImpl(url, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!res.ok) {
    const err = new Error((body && (body.message || body.error)) || `Request failed (${res.status})`);
    err.status = res.status; err.error = body && body.error;
    throw err;
  }
  return body;
}

export async function tileToPublish(id) {
  const files = publishFiles(id);
  for (const f of files) f.cid = await rawCid(f.bytes);
  const page = new TextDecoder().decode(files.find((f) => f.path === '/').bytes);
  const t = TILES[id];
  return { id, name: t.name, description: t.description, sizing: t.sizing, generator: GENERATOR, csp: cspOf(page), files };
}

export async function runPublish({ fetchImpl = fetch, ask, askHidden, log = console.log, dryRun = false, again = false, only = [],
  readPublished = () => (existsSync(PUBLISHED_FILE) ? JSON.parse(readFileSync(PUBLISHED_FILE, 'utf8')) : {}),
  writePublished = (o) => writeFileSync(PUBLISHED_FILE, JSON.stringify(o, null, 2) + '\n'),
  lexicons = readLexicons(), now = () => new Date().toISOString() }) {
  const doc = await getJson(fetchImpl, `https://plc.directory/${ACCOUNT}`);
  const svc = (doc.service || []).find((s) => s.type === 'AtprotoPersonalDataServer' || String(s.id).endsWith('#atproto_pds'));
  if (!svc) throw new Error('Could not find the account\'s server.');
  const pds = String(svc.serviceEndpoint).replace(/\/+$/, '');
  const aka = (doc.alsoKnownAs || []).find((a) => a.startsWith('at://'));
  const handle = aka ? aka.slice(5) : ACCOUNT;

  for (const id of only) if (!TILES[id]) throw new Error(`There's no tile called "${id}" (${Object.keys(TILES).join(', ')}).`);
  if (again && !only.length) throw new Error(`Say which tile to publish again: --again ${Object.keys(TILES).join(' or --again ')}.`);
  const published = readPublished() || {};
  const todo = [];
  for (const id of Object.keys(TILES)) {
    if (only.length && !only.includes(id)) continue;
    if (again || !published[id]) todo.push(await tileToPublish(id));
  }
  const had = published.lexicons || {};
  const lexiconsDue = only.length ? [] : lexicons.filter((l) => !had[l.id] || had[l.id].text !== JSON.stringify(l));

  log(`\nAccount: @${handle} (${ACCOUNT}), server ${pds}`);
  if (!todo.length && !lexiconsDue.length) { log('\nAlready published (see published.json). Use --again <tile> to publish one as a new record.'); return { changed: false, published }; }
  log('\nThis will publish:');
  for (const t of todo) {
    const kb = t.files.reduce((n, f) => n + f.bytes.length, 0) / 1024;
    log(`  - a new tile "${t.name}": ${t.files.length} files, ${kb.toFixed(1)} KB (${t.files.map((f) => f.path).join(' ')})`);
  }
  for (const l of lexiconsDue) {
    const kind = l.defs?.main?.type === 'permission-set' ? `permission set "${l.defs.main.title}"` : 'record type';
    log(`  - the lexicon ${l.id} (${kind}), as com.atproto.lexicon.schema/${l.id}${had[l.id] ? ' (changed)' : ''}`);
  }
  log('It is public. Nothing else in the account is touched.');
  if (dryRun) { log('\nDry run: nothing was written.'); return { changed: false, plan: todo, lexiconsDue: lexiconsDue.map((l) => l.id) }; }

  const password = await askHidden(`\nApp password for @${handle} (hidden): `);
  if (!password) throw new Error('No app password given; nothing was published.');
  const session = await getJson(fetchImpl, `${pds}/xrpc/com.atproto.server.createSession`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: ACCOUNT, password }),
  });
  if (session.did !== ACCOUNT) throw new Error('That app password belongs to a different account; nothing was published.');
  const auth = { Authorization: `Bearer ${session.accessJwt}` };
  const ok = (await ask('Publish now? [y/N] ')).trim().toLowerCase();
  if (ok !== 'y' && ok !== 'yes') { log('Stopped; nothing was published.'); return { changed: false }; }

  const xrpc = async (nsid, { method, params, body, contentType }) => {
    const url = new URL(`${pds}/xrpc/${nsid}`);
    for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
    const bytes = body instanceof Uint8Array;
    return getJson(fetchImpl, url.toString(), {
      method, headers: { ...auth, ...(body !== undefined ? { 'Content-Type': bytes ? contentType : 'application/json' } : {}) },
      body: body === undefined ? undefined : bytes ? body : JSON.stringify(body),
    });
  };
  const fetchBlob = async (cid) => {
    const res = await fetchImpl(`${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(ACCOUNT)}&cid=${encodeURIComponent(cid)}`);
    if (!res.ok) throw new Error(`Reading back ${cid} failed (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  };

  const out = { ...published, account: ACCOUNT, handle };
  for (const t of todo) {
    log(`\nPublishing "${t.name}"…`);
    const r = await publishTile({ xrpc, fetchBlob, did: ACCOUNT, tile: t, now, log });
    out[t.id] = { uri: r.uri, cid: r.cid, manifestCid: r.manifestCid, publishedAt: r.record.createdAt };
    writePublished(out);
    log(`  done: ${r.uri}`);
  }
  for (const l of lexiconsDue) {
    log(`\nPublishing the lexicon ${l.id}…`);
    const r = await publishLexicon({ xrpc, did: ACCOUNT, lexicon: l });
    const back = await xrpc('com.atproto.repo.getRecord', { method: 'GET', params: { repo: ACCOUNT, collection: 'com.atproto.lexicon.schema', rkey: l.id } });
    if (back.cid !== r.cid) throw new Error(`The lexicon ${l.id} was put, but reading it back gave another version.`);
    out.lexicons = { ...(out.lexicons || {}), [l.id]: { uri: r.uri, cid: r.cid, text: JSON.stringify(l) } };
    writePublished(out);
    log(`  done: ${r.uri}`);
  }
  log(`\nPublished, and read back to check.${todo.some((t) => t.id === 'house') ? ' Next: copy-to-site.mjs pins the house in the site.' : ''}`);
  if (lexiconsDue.length) log(`The Wix TXT record _lexicon.rooms (value did=${ACCOUNT}) must be in place for sign-in servers to find the permission set.`);
  log('Delete this app password (Bluesky: Settings > Privacy and security > App passwords).');
  return { changed: true, published: out };
}

function makeAsk() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  const write = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => { if (!muted || s.includes('\n')) write(muted ? '\n' : s); };
  const ask = (q) => new Promise((r) => rl.question(q, r));
  const askHidden = (q) => new Promise((r) => { process.stdout.write(q); muted = true; rl.question('', (a) => { muted = false; r(a.trim()); }); });
  return { ask, askHidden, close: () => rl.close() };
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const args = process.argv.slice(2);
  const io = makeAsk();
  runPublish({ ask: io.ask, askHidden: io.askHidden, dryRun: args.includes('--dry-run'), again: args.includes('--again'), only: args.filter((a) => !a.startsWith('--')) })
    .catch((err) => { console.error(`\n${err.message}`); process.exitCode = 1; })
    .finally(() => io.close());
}
