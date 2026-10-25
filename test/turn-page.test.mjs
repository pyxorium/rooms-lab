// TURN on the page (step 7): the relay's credentials checked before the browser gets them, the route read
// from a connection's statistics, and the mesh waiting for its servers before connecting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readIceServers } from '../src/messages.js';
import { readIceServers as relayRead } from '../relay/turn.js';
import { createMesh, routeOf } from '../src/mesh.js';
import { HONEST, NET_NOTES } from '../src/room-page.js';
import { TIMES } from '../src/config.js';

const TURN_ENTRY = { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u'.repeat(96), credential: 'c'.repeat(96) };

test('the page takes only well-formed ICE servers with a TURN entry, the same shape the relay sends', () => {
  const fromRelay = relayRead({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, TURN_ENTRY] });
  assert.deepEqual(readIceServers(fromRelay), fromRelay);
  assert.equal(readIceServers(null), null);
  assert.equal(readIceServers([{ urls: ['stun:stun.cloudflare.com:3478'] }]), null, 'STUN only: nothing new');
  assert.equal(readIceServers([{ ...TURN_ENTRY, username: '' }]), null);
  assert.equal(readIceServers([{ ...TURN_ENTRY, urls: ['https://evil.example/'] }]), null);
  assert.equal(readIceServers([{ ...TURN_ENTRY, urls: 'turn:turn.cloudflare.com:3478' }]), null, 'urls must be a list');
  assert.equal(readIceServers(Array(5).fill(TURN_ENTRY)), null, 'too many');
  assert.deepEqual(Object.keys(readIceServers([{ ...TURN_ENTRY, extra: 1 }])[0]).sort(), ['credential', 'urls', 'username']);
});

// Statistics shaped like Chrome's getStats().
const stats = (localType, remoteType, viaTransport = true) => {
  const m = new Map();
  m.set('L', { id: 'L', type: 'local-candidate', candidateType: localType });
  m.set('R', { id: 'R', type: 'remote-candidate', candidateType: remoteType });
  m.set('P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', state: 'succeeded', nominated: true });
  if (viaTransport) m.set('T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' });
  return m;
};

test('the route tag: "relay" when either side of the chosen pair is a TURN candidate, else "direct"', () => {
  assert.equal(routeOf(stats('host', 'srflx')), 'direct');
  assert.equal(routeOf(stats('srflx', 'prflx')), 'direct');
  assert.equal(routeOf(stats('relay', 'host')), 'relay');
  assert.equal(routeOf(stats('host', 'relay')), 'relay', 'the other person is the one behind TURN');
  assert.equal(routeOf(stats('relay', 'host', false)), 'relay', 'Firefox: no transport report, the nominated pair');
  assert.equal(routeOf(new Map()), null);
});

// A stand-in RTCPeerConnection that records its configuration.
class FakePC {
  static made = [];
  constructor(cfg) { this.cfg = cfg; this.connectionState = 'new'; this.signalingState = 'stable'; FakePC.made.push(this); }
  createDataChannel() { return { readyState: 'connecting' }; }
  setConfiguration(cfg) { this.cfg = cfg; }
  addTrack() { return {}; }
  close() { this.connectionState = 'closed'; }
  async setLocalDescription() {}
  get localDescription() { return { toJSON: () => ({ type: 'offer', sdp: '' }) }; }
}

test('the mesh waits for its servers before connecting, then uses them; a refresh updates connections already made; turn=only means relay only', () => {
  FakePC.made = [];
  const stun = [{ urls: ['stun:stun.l.google.com:19302'] }];
  const mesh = createMesh({ signal: () => {}, iceServers: stun, RTCPeerConnectionImpl: FakePC, waitForIce: true });
  mesh.setSelf('aaaaaaaaaaaa');
  mesh.sync(['bbbbbbbbbbbb']);
  mesh.handle('cccccccccccc', { description: { type: 'offer', sdp: '' } });
  assert.equal(FakePC.made.length, 0, 'nothing made before the servers are known');
  mesh.setIceServers([...stun, TURN_ENTRY]);
  assert.equal(FakePC.made.length, 1, 'the waiting sync went ahead (the offer from someone not in the list is ignored)');
  assert.deepEqual(FakePC.made[0].cfg, { iceServers: [...stun, TURN_ENTRY], iceTransportPolicy: 'all' });
  const fresh = { ...TURN_ENTRY, username: 'v'.repeat(96) };
  mesh.setIceServers([...stun, fresh]);
  assert.equal(FakePC.made[0].cfg.iceServers[1].username, fresh.username, 'refreshed in place');
  mesh.close();

  FakePC.made = [];
  const testMesh = createMesh({ signal: () => {}, iceServers: stun, RTCPeerConnectionImpl: FakePC, relayOnly: true });
  testMesh.setSelf('aaaaaaaaaaaa');
  testMesh.sync(['bbbbbbbbbbbb']);
  assert.equal(FakePC.made[0].cfg.iceTransportPolicy, 'relay');
  testMesh.close();

  FakePC.made = [];
  const plain = createMesh({ signal: () => {}, iceServers: stun, RTCPeerConnectionImpl: FakePC });
  plain.setSelf('aaaaaaaaaaaa');
  plain.sync(['bbbbbbbbbbbb']);
  assert.equal(FakePC.made.length, 1, 'without waitForIce, as before');
  plain.close();
});

test('the honest wording says where media goes, and the timings match the 4-hour credentials', () => {
  const text = HONEST.join(' ');
  assert.match(text, /directly between computers when they can/);
  assert.match(text, /Cloudflare's relay, still encrypted; Cloudflare sees addresses and timing, not what's said or shown/);
  assert.doesNotMatch(text, /no TURN/i);
  assert.equal(NET_NOTES.unavailable, "The fallback relay isn't available right now, so people on strict networks may not be able to connect.");
  assert.equal(TIMES.iceRefreshMs, 3 * 3600_000);
  assert.ok(TIMES.iceWaitMs >= 2000 && TIMES.iceWaitMs <= 6000);
});
