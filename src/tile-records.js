// tile-records.js: reading a tile's record and serving its files, pinned to one exact version
// (rooms-lab-plan.md, sections 3 and 7: "open for everyone").
//
// A tile is opened for everyone by its address (at://<did>/ing.dasl.masl/<rkey>) and its record's CID, which
// the host's page reads once and sends to everyone. Each person's page then reads the record itself, from the
// author's own server, and opens it only if the CID is the same (someone may have changed the tile since):
// everyone runs exactly the same version. Every file is checked against the content address the record gives
// it before the tile sees it (as Daisy's pinned loader does).
//
// The record and files come from the author's server: did:plc accounts through plc.directory, did:web
// accounts through their own /.well-known/did.json (as the site's at-tile-loader.js). Nothing here runs a
// tile: the tile loader does (the page is given a `tileHost`), in a sealed frame on the loading server.

export const COLLECTION = 'ing.dasl.masl';
export const TILE_URI = /^at:\/\/(did:(?:plc:[a-z2-7]{24}|web:[a-z0-9.-]+(?:%3A[0-9]+)?))\/ing\.dasl\.masl\/([A-Za-z0-9._~:-]{1,512})$/i;
export const isRecordCid = (x) => typeof x === 'string' && /^b[a-z2-7]{20,120}$/.test(x);
export const LIMITS = Object.freeze({
  lookupMs: 10_000,              // a DID document, a record
  fileMs: 60_000,                // one of a tile's files
  docBytes: 256 * 1024,          // a DID document
  recordBytes: 2 * 1024 * 1024,  // a tile's record
  maxBytes: 50 * 1024 * 1024,    // a tile everyone in the room downloads: at most this, by its record and in fact
});

/** { did, rkey } from a tile's address, or null. */
export function parseTileUri(uri) {
  const m = typeof uri === 'string' ? TILE_URI.exec(uri.trim()) : null;
  return m ? { did: m[1], rkey: m[2] } : null;
}

const NOT_FOUND = { ok: false, status: 404, statusText: 'Not found' };
// Same header list as @dasl/tile-loader's lib/masl.js (not exported by the package).
const MASL_HEADERS = ['content-disposition', 'content-encoding', 'content-language', 'content-security-policy', 'content-type',
  'link', 'permissions-policy', 'referrer-policy', 'service-worker-allowed', 'sourcemap', 'speculation-rules',
  'supports-loading-mode', 'x-content-type-options'];
function maslResponse(entry, body) {
  const headers = {};
  for (const k of MASL_HEADERS) if (typeof entry[k] !== 'undefined') headers[k] = entry[k];
  return { ok: true, status: 200, statusText: 'Ok', headers, body };
}

/** A file's raw-codec CIDv1 ("bafkrei…"), as a PDS gives a blob (as Daisy's pinned-loader.js). */
export async function rawCid(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const all = new Uint8Array(4 + digest.length);
  all.set([0x01, 0x55, 0x12, 0x20], 0);
  all.set(digest, 4);
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = 'b', buffer = 0, bits = 0;
  for (const byte of all) {
    buffer = (buffer << 8) | byte; bits += 8;
    while (bits >= 5) { out += A[(buffer >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(buffer << (5 - bits)) & 31];
  return out;
}

const blobCidOf = (entry) => {
  const src = entry && entry.src;
  const cid = src && (src.$link || (src.ref && src.ref.$link));
  return typeof cid === 'string' && /^b[a-z2-7]{20,120}$/.test(cid) ? cid : null;
};

export function createTileRecords({ fetchImpl = (...a) => globalThis.fetch(...a), limits = LIMITS } = {}) {
  const pdsCache = new Map();

  async function get(url, { timeoutMs, maxBytes }) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: ctl.signal });
      const len = Number(res.headers?.get?.('content-length'));
      if (Number.isFinite(len) && len > maxBytes) return { ok: false, status: res.status, tooBig: true };
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > maxBytes) return { ok: false, status: res.status, tooBig: true };
      return { ok: res.ok, status: res.status, bytes: buf };
    } finally { clearTimeout(timer); }
  }
  const getJson = async (url, opts) => {
    const r = await get(url, opts);
    if (!r.ok) return r;
    try { return { ...r, json: JSON.parse(new TextDecoder().decode(r.bytes)) }; } catch { return { ok: false, status: r.status }; }
  };

  function pdsOf(did) {
    if (!pdsCache.has(did)) {
      pdsCache.set(did, (async () => {
        const web = /^did:web:(.+)$/i.exec(did);
        const url = web ? `https://${web[1].replace(/%3A/i, ':')}/.well-known/did.json` : `https://plc.directory/${did}`;
        const r = await getJson(url, { timeoutMs: limits.lookupMs, maxBytes: limits.docBytes });
        const svc = r.ok && Array.isArray(r.json?.service) ? r.json.service.find((s) => s && (s.id === '#atproto_pds' || s.id === `${did}#atproto_pds`)) : null;
        const ep = svc && typeof svc.serviceEndpoint === 'string' ? svc.serviceEndpoint.replace(/\/+$/, '') : null;
        return ep && /^https:\/\/[^\s/]+$/i.test(ep) ? ep : null;
      })().catch(() => null));
    }
    return pdsCache.get(did).then((p) => { if (!p) pdsCache.delete(did); return p; });
  }

  /** The tile's record, read from its author's server: { ok, did, rkey, pds, cid, manifest, name, … } or { ok: false, why }. */
  async function read(uri) {
    const at = parseTileUri(uri);
    if (!at) return { ok: false, why: 'That isn’t a tile address (at://…/ing.dasl.masl/…).' };
    let pds;
    try { pds = await pdsOf(at.did); } catch { pds = null; }
    if (!pds) return { ok: false, why: 'The tile’s account couldn’t be found.' };
    let r;
    try {
      r = await getJson(`${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(at.did)}&collection=${COLLECTION}&rkey=${encodeURIComponent(at.rkey)}`,
        { timeoutMs: limits.lookupMs, maxBytes: limits.recordBytes });
    } catch { r = { ok: false }; }
    if (!r.ok) return { ok: false, why: r.status === 400 || r.status === 404 ? 'There’s no tile at that address.' : 'The tile’s record couldn’t be read.' };
    const cid = r.json?.cid;
    const t = r.json?.value?.tile;
    if (!isRecordCid(cid) || !t || typeof t !== 'object' || !t.resources || typeof t.resources !== 'object') return { ok: false, why: 'That record isn’t a tile.' };
    if (!t.resources['/'] && !t.resources['/index.html']) return { ok: false, why: 'That tile has no page to show.' };
    let declaredBytes = 0;
    for (const e of Object.values(t.resources)) { const n = Number(e?.src?.size); if (Number.isFinite(n) && n > 0) declaredBytes += n; }
    if (declaredBytes > limits.maxBytes) return { ok: false, why: `That tile is too large to open for everyone (over ${Math.round(limits.maxBytes / 1048576)} MB).` };
    const w = Number(t.sizing?.width), hgt = Number(t.sizing?.height);
    return {
      ok: true, uri: `at://${at.did}/${COLLECTION}/${at.rkey}`, did: at.did, rkey: at.rkey, pds, cid, manifest: t, declaredBytes,
      name: typeof t.name === 'string' && t.name.trim() ? t.name.trim().slice(0, 120) : 'Untitled tile',
      description: typeof t.description === 'string' ? t.description.slice(0, 300) : '',
      sizing: w >= 100 && w <= 4000 && hgt >= 100 && hgt <= 4000 ? { width: w, height: hgt } : null,
    };
  }

  /** What the tile loader asks for each of the tile's files: only the record's files, each checked against
   *  its content address, at most limits.maxBytes in all. onFile(path, ok) is told about each one. */
  function pathLoader({ pds, did, manifest, onFile = () => {} }) {
    const files = new Map();       // cid → Promise<ArrayBuffer | null>
    let left = limits.maxBytes;
    async function blob(cid) {
      if (!files.has(cid)) {
        files.set(cid, (async () => {
          const r = await get(`${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`,
            { timeoutMs: limits.fileMs, maxBytes: Math.max(0, left) });
          if (!r.ok) return null;
          if ((await rawCid(r.bytes)) !== cid) return null;            // not the pinned bytes: refused
          left -= r.bytes.byteLength;
          return r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength);
        })().catch(() => null));
      }
      const buf = await files.get(cid);
      if (!buf) { files.delete(cid); return null; }
      return buf.slice(0);                                              // a fresh copy each time
    }
    return {
      async resolvePath(path) {
        const entry = manifest.resources[path] || (path === '/' ? manifest.resources['/index.html'] : null);
        const cid = blobCidOf(entry);
        const data = cid ? await blob(cid) : null;
        onFile(path, !!data);
        return data ? maslResponse(entry, data) : NOT_FOUND;
      },
    };
  }

  return { read, pathLoader, pdsOf };
}
