// turn-standin.mjs: a tiny TURN server (UDP, RFC 8656's long-term credentials) for the browser checks only,
// standing in for Cloudflare's turn.cloudflare.com, so a real Chromium can be made to send everything through
// TURN (&turn=only) and the page's "via relay" tag can be seen. Not for real use: one realm, no TCP or TLS,
// no quotas, and it forgets everything when stopped.
//
// What it does, as Chrome expects: Binding; Allocate (first a 401 with realm and nonce, then with
// USERNAME/REALM/NONCE/MESSAGE-INTEGRITY → XOR-RELAYED-ADDRESS, XOR-MAPPED-ADDRESS, LIFETIME); Refresh;
// CreatePermission; ChannelBind; Send indications and ChannelData out; Data indications and ChannelData back.
// Every allocation gets its own UDP socket on `relayHost`. `stats()` counts what was relayed.
import dgram from 'node:dgram';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { crc32 } from 'node:zlib';

const MAGIC = 0x2112a442;
const M = { binding: 0x001, allocate: 0x003, refresh: 0x004, send: 0x006, data: 0x007, permission: 0x008, channelBind: 0x009 };
const A = { username: 0x0006, integrity: 0x0008, error: 0x0009, channel: 0x000c, lifetime: 0x000d, peer: 0x0012, data: 0x0013, realm: 0x0014, nonce: 0x0015, relayed: 0x0016, transport: 0x0019, mapped: 0x0020, fingerprint: 0x8028 };

function parse(buf) {
  if (buf.length < 20 || (buf[0] & 0xc0) !== 0 || buf.readUInt32BE(4) !== MAGIC) return null;
  const type = buf.readUInt16BE(0), len = buf.readUInt16BE(2);
  if (20 + len > buf.length) return null;
  const method = (type & 0x000f) | ((type & 0x00e0) >> 1) | ((type & 0x3e00) >> 2);
  const cls = ((type & 0x0010) >> 4) | ((type & 0x0100) >> 7);
  const attrs = new Map(); let integrityAt = -1;
  for (let i = 20; i + 4 <= 20 + len;) {
    const t = buf.readUInt16BE(i), l = buf.readUInt16BE(i + 2);
    if (t === A.integrity) integrityAt = i;
    if (!attrs.has(t)) attrs.set(t, buf.subarray(i + 4, i + 4 + l));
    i += 4 + l + ((4 - (l % 4)) % 4);
  }
  return { method, cls, tid: buf.subarray(8, 20), attrs, integrityAt, raw: buf };
}

const typeOf = (method, cls) => (method & 0x000f) | ((method & 0x0070) << 1) | ((method & 0x0f80) << 2) | ((cls & 1) << 4) | ((cls & 2) << 7);
const attr = (t, v) => { const pad = (4 - (v.length % 4)) % 4; const b = Buffer.alloc(4 + v.length + pad); b.writeUInt16BE(t, 0); b.writeUInt16BE(v.length, 2); v.copy(b, 4); return b; };
function xorAddr(ip, port) {
  const b = Buffer.alloc(8);
  b[1] = 0x01; b.writeUInt16BE(port ^ (MAGIC >>> 16), 2);
  const parts = ip.split('.').map(Number);
  b.writeUInt32BE((((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) ^ MAGIC) >>> 0, 4);
  return b;
}
function readXorAddr(v) {
  if (!v || v.length < 8 || v[1] !== 0x01) return null;
  const port = v.readUInt16BE(2) ^ (MAGIC >>> 16);
  const n = (v.readUInt32BE(4) ^ MAGIC) >>> 0;
  return { ip: [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'), port };
}
function build(method, cls, tid, list, key) {
  let body = Buffer.concat(list.map(([t, v]) => attr(t, v)));
  const head = (extra) => { const h = Buffer.alloc(20); h.writeUInt16BE(typeOf(method, cls), 0); h.writeUInt16BE(body.length + extra, 2); h.writeUInt32BE(MAGIC, 4); tid.copy(h, 8); return h; };
  if (key) {
    const mac = createHmac('sha1', key).update(Buffer.concat([head(24), body])).digest();
    body = Buffer.concat([body, attr(A.integrity, mac)]);
  }
  const crc = (crc32(Buffer.concat([head(8), body])) ^ 0x5354554e) >>> 0;
  const fp = Buffer.alloc(4); fp.writeUInt32BE(crc, 0);
  body = Buffer.concat([body, attr(A.fingerprint, fp)]);
  return Buffer.concat([head(0), body]);
}
function integrityOk(msg, key) {
  if (msg.integrityAt < 0) return false;
  const upTo = Buffer.from(msg.raw.subarray(0, msg.integrityAt));
  upTo.writeUInt16BE(msg.integrityAt - 20 + 24, 2);
  const mac = createHmac('sha1', key).update(upTo).digest();
  return mac.equals(msg.attrs.get(A.integrity));
}

export async function startTurnStandin({ host = '127.0.0.1', relayHost = host, users = { tester: 'secret' }, realm = 'rooms-lab-check' } = {}) {
  const server = dgram.createSocket('udp4');
  const nonce = randomBytes(8).toString('hex');
  const allocs = new Map();                 // "ip:port" of the client → { relay, perms: Set(ip), channels: Map(n → "ip:port"), byPeer: Map("ip:port" → n), key }
  const counts = { allocations: 0, relayedOut: 0, relayedIn: 0, refused: 0 };
  const keyFor = (user) => (users[user] ? createHash('md5').update(`${user}:${realm}:${users[user]}`).digest() : null);

  server.on('message', (buf, from) => {
    const client = `${from.address}:${from.port}`;
    // ChannelData from a client: 0x4000–0x7fff in the first two bytes.
    if (buf.length >= 4 && buf[0] >= 0x40 && buf[0] <= 0x7f) {
      const a = allocs.get(client); if (!a) return;
      const n = buf.readUInt16BE(0), len = buf.readUInt16BE(2), to = a.channels.get(n);
      if (!to) return;
      const [ip, port] = to.split(':');
      counts.relayedOut++; a.relay.send(buf.subarray(4, 4 + len), Number(port), ip);
      return;
    }
    const m = parse(buf); if (!m) return;
    const reply = (cls, list, key) => server.send(build(m.method, cls, m.tid, list, key), from.port, from.address);
    const fail = (code, why, extra = []) => {
      const v = Buffer.concat([Buffer.from([0, 0, Math.floor(code / 100), code % 100]), Buffer.from(why)]);
      counts.refused++; reply(3, [[A.error, v], ...extra]);
    };
    if (m.method === M.binding && m.cls === 0) return reply(2, [[A.mapped, xorAddr(from.address, from.port)]]);
    if (m.method === M.send && m.cls === 1) {
      const a = allocs.get(client), peer = readXorAddr(m.attrs.get(A.peer)), data = m.attrs.get(A.data);
      if (a && peer && data && a.perms.has(peer.ip)) { counts.relayedOut++; a.relay.send(data, peer.port, peer.ip); }
      return;
    }
    if (m.cls !== 0) return;
    // Every request below needs the long-term credentials.
    const user = m.attrs.get(A.username)?.toString();
    const key = user && keyFor(user);
    if (!user || !m.attrs.has(A.integrity)) return fail(401, 'Unauthorized', [[A.realm, Buffer.from(realm)], [A.nonce, Buffer.from(nonce)]]);
    if (!key || !integrityOk(m, key)) return fail(401, 'Unauthorized', [[A.realm, Buffer.from(realm)], [A.nonce, Buffer.from(nonce)]]);
    const a = allocs.get(client);
    if (m.method === M.allocate) {
      if (a) return reply(2, [[A.relayed, xorAddr(relayHost, a.relay.address().port)], [A.mapped, xorAddr(from.address, from.port)], [A.lifetime, Buffer.from([0, 0, 0x02, 0x58])]], key);
      const relay = dgram.createSocket('udp4');
      const al = { relay, perms: new Set(), channels: new Map(), byPeer: new Map(), key };
      relay.on('message', (data, peer) => {
        if (!al.perms.has(peer.address)) return;
        counts.relayedIn++;
        const n = al.byPeer.get(`${peer.address}:${peer.port}`);
        if (n) {
          const h = Buffer.alloc(4); h.writeUInt16BE(n, 0); h.writeUInt16BE(data.length, 2);
          const pad = Buffer.alloc((4 - (data.length % 4)) % 4);
          server.send(Buffer.concat([h, data, pad]), from.port, from.address);
        } else server.send(build(M.data, 1, randomBytes(12), [[A.peer, xorAddr(peer.address, peer.port)], [A.data, data]]), from.port, from.address);
      });
      relay.bind(0, relayHost, () => {
        allocs.set(client, al); counts.allocations++;
        reply(2, [[A.relayed, xorAddr(relayHost, relay.address().port)], [A.mapped, xorAddr(from.address, from.port)], [A.lifetime, Buffer.from([0, 0, 0x02, 0x58])]], key);
      });
      return;
    }
    if (!a) return fail(437, 'Allocation Mismatch');
    if (m.method === M.refresh) {
      const life = m.attrs.get(A.lifetime);
      if (life && life.readUInt32BE(0) === 0) { a.relay.close(); allocs.delete(client); }
      return reply(2, [[A.lifetime, life || Buffer.from([0, 0, 0x02, 0x58])]], key);
    }
    if (m.method === M.permission) {
      const peer = readXorAddr(m.attrs.get(A.peer)); if (!peer) return fail(400, 'Bad Request');
      a.perms.add(peer.ip); return reply(2, [], key);
    }
    if (m.method === M.channelBind) {
      const ch = m.attrs.get(A.channel), peer = readXorAddr(m.attrs.get(A.peer));
      if (!ch || !peer) return fail(400, 'Bad Request');
      const n = ch.readUInt16BE(0), where = `${peer.ip}:${peer.port}`;
      a.channels.set(n, where); a.byPeer.set(where, n); a.perms.add(peer.ip);
      return reply(2, [], key);
    }
    return fail(400, 'Bad Request');
  });
  await new Promise((resolve) => server.bind(0, host, resolve));
  const port = server.address().port;
  return {
    port,
    url: `turn:${host}:${port}?transport=udp`,
    servers: (user = Object.keys(users)[0]) => [{ urls: [`turn:${host}:${port}?transport=udp`], username: user, credential: users[user] }],
    stats: () => ({ ...counts, open: allocs.size }),
    close: () => { for (const a of allocs.values()) { try { a.relay.close(); } catch { /* closed */ } } server.close(); },
  };
}
