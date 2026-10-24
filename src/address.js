// address.js: what the room's address box accepts, turned into one form.
//
// COPY of the tile-address part of Raku's src/address.js (pyxorium/raku, Oct 23 2026, commit 566e281): the same
// forms people copy out of Raku and the viewers, so an address that opens a tile there opens it here too.
// Raku's own pages (raku:…, accounts, search) are left out. Keep the two in step when either changes.
//
// Accepted:
//   at://<did or handle>/ing.dasl.masl/<rkey>              (Raku shows tiles with the handle)
//   https://lexicographer.space/@<did or handle>/<rkey>     (the viewer; www. too)
//   https://appmosphe.re/@<did or handle>/<rkey>            (same short form)
//   https://webtil.es/browser/#url=<at:// address, plain or encoded>
//   tile://<rkey>.<did, encoded>/                           (Beaver's form, webbeef's browser)
//   @<did or handle>/<rkey>
// Plain string work, no network (tested in Node). A handle is then turned into its DID by the asker's own page
// (tile-records.js didFor, checked both ways): the room only ever sends the DID form.

const COLLECTION = 'ing.dasl.masl';
export const DID_PLC = /^did:plc:[a-z2-7]{24}$/;
export const DID_WEB = /^did:web:[a-z0-9.-]+(%3[Aa][0-9]+)?$/i;
// atproto handles: dot-separated labels, a letter-led last label (no IP addresses).
const HANDLE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/i;
// Record keys: atproto's allowed characters, not "." or "..".
const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/;

export const isDid = (s) => DID_PLC.test(s) || DID_WEB.test(s);
export const isHandle = (s) => HANDLE.test(s);
export const isRkey = (s) => RKEY.test(s) && s !== '.' && s !== '..';

const VIEWER_HOSTS = new Set(['lexicographer.space', 'www.lexicographer.space', 'appmosphe.re', 'www.appmosphe.re']);
const WEBTILES_HOSTS = new Set(['webtil.es', 'www.webtil.es']);

const fail = (reason) => ({ ok: false, reason });
export const HINT = 'Paste a tile’s address: at://… (as Raku shows it), a lexicographer.space, appmosphe.re or webtil.es link, or tile://…';

function actorAndKey(actor, rkey) {
  actor = String(actor || '').replace(/^@/, '');
  if (actor.startsWith('did:')) {
    if (!isDid(actor)) return fail('That account (a DID) can’t be looked up here: did:plc and did:web only.');
    if (actor.startsWith('did:plc:')) actor = actor.toLowerCase();
    else actor = 'did:web:' + actor.slice(8).toLowerCase();
  } else {
    actor = actor.toLowerCase();
    if (!isHandle(actor)) return fail(`"${actor}" isn’t a handle or a DID.`);
  }
  if (!isRkey(rkey)) return fail('The tile’s record key is missing or not valid.');
  return { ok: true, actor, rkey, uri: `at://${actor}/${COLLECTION}/${rkey}` };
}

function fromAtUri(s) {
  const m = s.match(/^at:\/\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/?$/);
  if (!m) return fail('That at:// address needs three parts: an account, ing.dasl.masl and a record key.');
  if (m[2] !== COLLECTION) return fail(`That record isn’t a web tile (its collection is ${m[2]}, not ${COLLECTION}).`);
  let actor;
  try { actor = decodeURIComponent(m[1]); } catch { return fail('That at:// address’s account can’t be read.'); }
  return actorAndKey(actor, m[3]);
}

function fromTileUri(s) {
  // tile://<rkey>.<did, percent-encoded>/  e.g. tile://3mabc.did%3Aplc%3Axyz/
  const m = s.match(/^tile:\/\/([^/?#]+)\/?$/i);
  if (!m) return fail('That tile:// address should look like tile://<record key>.<account>/');
  const host = m[1];
  const at = host.search(/\.did(%3a|:)/i);
  if (at < 1) return fail('That tile:// address should look like tile://<record key>.<account>/');
  let did;
  try { did = decodeURIComponent(host.slice(at + 1)); } catch { return fail('That tile:// address’s account can’t be read.'); }
  return actorAndKey(did, host.slice(0, at));
}

/** Reads what someone typed or pasted. → { ok: true, actor, rkey, uri } (actor: a DID or a handle) or { ok: false, reason } */
export function parseAddress(input) {
  const s = String(input || '').trim();
  if (!s) return fail(HINT);
  if (/^at:\/\//i.test(s)) return fromAtUri(s.replace(/^at:\/\//i, 'at://'));
  if (/^tile:\/\//i.test(s)) return fromTileUri(s);
  if (/^@?[^/\s]+\/[^/\s]+$/.test(s) && !/^https?:/i.test(s)) {
    const [actor, rkey] = s.split('/');
    return actorAndKey(actor, rkey);
  }
  let u;
  try { u = new URL(s); } catch { return fail(HINT); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return fail(HINT);
  const host = u.hostname.toLowerCase();
  if (WEBTILES_HOSTS.has(host)) {
    const hash = new URLSearchParams(u.hash.replace(/^#/, ''));
    const inner = hash.get('url');
    if (!inner) return fail('That webtil.es link doesn’t name a tile.');
    return /^at:\/\//i.test(inner) ? fromAtUri(inner) : fail('That webtil.es link doesn’t name a tile.');
  }
  if (VIEWER_HOSTS.has(host)) {
    const m = u.pathname.match(/^\/@([^/]+)\/([^/]+)\/?$/);
    if (!m) return fail(`That ${host} link isn’t a tile’s page.`);
    let actor, rkey;
    try { actor = decodeURIComponent(m[1]); rkey = decodeURIComponent(m[2]); } catch { return fail(`That ${host} link can’t be read.`); }
    return actorAndKey(actor, rkey);
  }
  return fail(`A room opens web tiles, not other web pages. ${HINT}`);
}
