// mesh.js: the direct connections between the computers in a room (WebRTC), one to each other person (a
// "mesh", fine for 2 to 6 people; rooms-lab-plan.md, sections 3 and 7). Voice and the presenter's screen
// go over these, encrypted between the browsers; the relay only carries the setup messages (`signal`).
//
// Setting up uses the browser makers' "perfect negotiation" pattern: either side may change the
// connection later (a mic, a screen), and when both do at once the "polite" side (the larger peer id)
// gives way. To start, only the other side (the smaller id) makes the connection, with a small data
// channel, so people connect as soon as they're in the room, before anyone unmutes (a connection that
// can't be made shows up straight away: "couldn't connect"). The polite side waits for that first offer
// and only then adds its own mic or screen. (Both starting at once failed in Chrome when the polite side
// already had a screen to send: stepping back from its own offer broke the data channel. Oct 23.)
//
// What's sent:
// - the microphone (`setMic`): added once, the first time the person unmutes; muting only switches the
//   track off (no new setup, nothing sent while muted);
// - the screen (`setScreen`): added to every connection while presenting, removed when stopped. Its track
//   is marked as "detail" (sharp text before smooth motion) by the page.
// Received tracks are handed to the page (`onTrack(peer, track, stream)`): audio is a person's voice,
// video is their screen (there's no camera in the lab).
//
// Network routes (step 7): the browsers try a direct connection first and fall back to TURN (Cloudflare's
// relay, credentials from our relay; turn.js) when a network blocks direct ones. With `waitForIce`, no
// connection is made until the page hands over its servers (`setIceServers`, once the relay has answered or
// a short wait has passed), so the first connections already know the TURN server; a refresh later updates
// every connection (`setConfiguration`). `relayOnly` (the &turn=only test switch) sends everything through
// TURN. `route(id)` tells whether a connection goes "direct" or "relay" (from the browser's own statistics).
//
// The data channel ("room", made by the side that starts; the other side receives it) carries live tiles'
// messages (live.js), JSON text, directly between the two browsers and encrypted like voice; never through
// the relay. `sendData(peer, obj)` is true when it went out; what arrives goes to `onData(peer, obj)` (parsed,
// not yet checked: the page checks it); `onChannel(peer, "open" | "closed")` follows the channel.
/** From a connection's statistics: "relay" if its chosen pair uses a TURN candidate on either side,
 *  "direct" if it uses none, null if none is chosen yet. */
export function routeOf(stats) {
  const all = new Map();
  stats.forEach((r) => all.set(r.id, r));
  let pair = null;
  for (const r of all.values()) if (r.type === 'transport' && r.selectedCandidatePairId) pair = all.get(r.selectedCandidatePairId);
  if (!pair) for (const r of all.values()) if (r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded'))) { pair = r; break; }
  if (!pair) return null;
  const local = all.get(pair.localCandidateId), remote = all.get(pair.remoteCandidateId);
  return local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
}

export function createMesh({
  signal, iceServers = [], RTCPeerConnectionImpl = globalThis.RTCPeerConnection, waitForIce = false, relayOnly = false,
  onTrack = () => {}, onPeerState = () => {}, onError = () => {}, leaveGraceMs = 15_000,
  onData = () => {}, onChannel = () => {}, maxDataBytes = 64 * 1024,
}) {
  let self = null;
  const peers = new Map();         // peer id → { pc, polite, makingOffer, ignoreOffer, chain, senders: { mic, screen }, channel }
  let known = new Set();           // the people in the room now (from the relay's list)
  const leaving = new Map();       // peer id → timer: gone from the list, connection kept a moment
  let mic = null, micStream = null, screen = null, screenStream = null;
  let servers = iceServers, ready = !waitForIce, pendingSync = null;
  const pendingSignals = [];       // [id, data] that came before the servers did
  const config = () => ({ iceServers: servers, iceTransportPolicy: relayOnly ? 'relay' : 'all' });

  function create(id) {
    const pc = new RTCPeerConnectionImpl(config());
    const p = { pc, polite: self > id, makingOffer: false, ignoreOffer: false, chain: Promise.resolve(), senders: {}, channel: null };
    peers.set(id, p);
    pc.onnegotiationneeded = async () => {
      try {
        p.makingOffer = true;
        await pc.setLocalDescription();
        signal(id, { kind: 'rtc', description: pc.localDescription.toJSON() });
      } catch (e) { onError(id, e); } finally { p.makingOffer = false; }
    };
    pc.onicecandidate = ({ candidate }) => { if (candidate && candidate.candidate) signal(id, { kind: 'rtc', candidate: candidate.toJSON() }); };
    pc.ontrack = ({ track, streams }) => onTrack(id, track, streams[0] || new MediaStream([track]));
    pc.onconnectionstatechange = () => {
      onPeerState(id, pc.connectionState);
      if (pc.connectionState === 'failed' && !p.polite) { try { pc.restartIce(); } catch { /* old browser */ } }
    };
    if (!p.polite) useChannel(id, p, pc.createDataChannel('room'));
    pc.ondatachannel = ({ channel }) => { if (channel.label === 'room' && peers.get(id) === p) useChannel(id, p, channel); };
    if (mic) p.senders.mic = pc.addTrack(mic, micStream);
    if (screen) addScreen(p);
    onPeerState(id, 'new');
    return p;
  }

  function useChannel(id, p, ch) {
    p.channel = ch;
    ch.onopen = () => { if (p.channel === ch) onChannel(id, 'open'); };
    ch.onclose = () => { if (p.channel === ch) onChannel(id, 'closed'); };
    ch.onmessage = (e) => {
      if (p.channel !== ch || typeof e.data !== 'string' || e.data.length > maxDataBytes) return;
      let obj;
      try { obj = JSON.parse(e.data); } catch { return; }
      onData(id, obj);
    };
    if (ch.readyState === 'open') onChannel(id, 'open');
  }

  function addScreen(p) {
    p.senders.screen = p.pc.addTrack(screen, screenStream);
    try {
      const params = p.senders.screen.getParameters();
      params.degradationPreference = 'maintain-resolution';
      p.senders.screen.setParameters(params).catch(() => {});
    } catch { /* not supported: the track's "detail" hint does the same */ }
  }

  function drop(id) {
    clearTimeout(leaving.get(id));
    leaving.delete(id);
    const p = peers.get(id);
    if (!p) return;
    peers.delete(id);
    try { p.pc.close(); } catch { /* closed already */ }
    onPeerState(id, 'closed');
  }

  // One message at a time per person, in the order they arrive.
  function handle(id, data) {
    if (!ready) { if (pendingSignals.length < 500) pendingSignals.push([id, data]); return; }
    if (!(known.has(id) || peers.has(id)) || !self) return;
    const p = peers.get(id) || create(id);
    p.chain = p.chain.then(() => apply(id, p, data)).catch((e) => onError(id, e));
    return p.chain;
  }

  async function apply(id, p, data) {
    const { pc } = p;
    if (pc.signalingState === 'closed') return;
    if (data.description) {
      const d = data.description;
      const collision = d.type === 'offer' && (p.makingOffer || pc.signalingState !== 'stable');
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      await pc.setRemoteDescription(d);
      if (d.type === 'offer') {
        await pc.setLocalDescription();
        signal(id, { kind: 'rtc', description: pc.localDescription.toJSON() });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignoreOffer) throw e; }
    }
  }

  return {
    /** This page's id in the room (set on joining, and again if the relay gave a new one). */
    setSelf(id) { if (id !== self) { for (const k of [...peers.keys()]) drop(k); self = id; } },
    /** The people in the room now (not counting yourself, nor an away host): connect to new ones, drop the gone. */
    // Someone gone from the list keeps their connection for a moment (leaveGraceMs): if only their link to
    // the relay dropped, they come back under the same id and the call never noticed. A connection that has
    // already failed or closed goes at once.
    sync(ids) {
      if (!ready) { pendingSync = ids; return; }
      known = new Set(ids.filter((x) => x !== self));
      for (const id of [...peers.keys()]) {
        if (known.has(id)) { clearTimeout(leaving.get(id)); leaving.delete(id); continue; }
        const st = peers.get(id).pc.connectionState;
        if (st === 'failed' || st === 'closed' || st === 'new' || !leaveGraceMs) drop(id);
        else if (!leaving.has(id)) leaving.set(id, setTimeout(() => { if (!known.has(id)) drop(id); }, leaveGraceMs));
      }
      for (const id of known) if (!peers.has(id) && self < id) create(id);     // the larger id waits for the offer
    },
    handle,
    setMic(track, stream) {
      mic = track; micStream = stream;
      for (const p of peers.values()) {
        if (p.senders.mic) p.senders.mic.replaceTrack(track).catch((e) => onError(null, e));
        else if (track) p.senders.mic = p.pc.addTrack(track, stream);
      }
    },
    setScreen(track, stream) {
      screen = track; screenStream = stream;
      for (const p of peers.values()) {
        if (track) { if (!p.senders.screen) addScreen(p); else p.senders.screen.replaceTrack(track).catch(() => {}); }
        else if (p.senders.screen) {
          try { p.pc.removeTrack(p.senders.screen); } catch { /* closed */ }
          delete p.senders.screen;
        }
      }
    },
    state: (id) => peers.get(id)?.pc.connectionState ?? null,
    /** The servers to use (STUN, and TURN when the relay gave credentials). The first call lets connections
     *  start (with `waitForIce`); later calls (a refresh) update every connection already made. */
    setIceServers(list) {
      servers = list;
      for (const p of peers.values()) { try { p.pc.setConfiguration(config()); } catch (e) { onError(null, e); } }
      if (ready) return;
      ready = true;
      if (pendingSync) { const ids = pendingSync; pendingSync = null; this.sync(ids); }
      for (const [id, data] of pendingSignals.splice(0)) handle(id, data);
    },
    get iceReady() { return ready; },
    /** "direct", "relay" (through TURN) or null (not connected yet), from the connection's statistics. */
    async route(id) {
      const pc = peers.get(id)?.pc;
      if (!pc || pc.connectionState !== 'connected') return null;
      try { return routeOf(await pc.getStats()); } catch { return null; }
    },
    /** Send JSON to one person over the data channel: true if it went out. */
    sendData(id, obj) {
      const ch = peers.get(id)?.channel;
      if (!ch || ch.readyState !== 'open') return false;
      let text;
      try { text = JSON.stringify(obj); } catch { return false; }
      if (text.length > maxDataBytes) return false;
      try { ch.send(text); return true; } catch { return false; }
    },
    channelOpen: (id) => peers.get(id)?.channel?.readyState === 'open',
    close() { for (const id of [...peers.keys()]) drop(id); known = new Set(); },
    // For the checks.
    connection: (id) => peers.get(id)?.pc ?? null,
    get ids() { return [...peers.keys()]; },
  };
}
