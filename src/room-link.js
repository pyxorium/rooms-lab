// room-link.js: the page's connection to the Rooms lab relay (a WebSocket), modelled on Raku's
// relay-connection.js. It joins the room, passes messages to one person or to everyone, and comes back by
// itself after a drop (0.5 s, then longer, up to 8 s).
//
// A drop of this connection doesn't drop the call: voice and screens go directly between the computers,
// so they carry on while the page reconnects to the relay. Only new connections (someone joining) and
// room messages wait.
//
// What it does with the relay's answers (relay/rooms.js has the rules):
// - the host joins with `create: true` and, once it has one, its host key, so after a relay restart the
//   host's page makes the room again with the same key;
// - a guest whose room isn't there gets "no room" and tries again every few seconds for a minute (the
//   relay may have restarted and the host's page not be back yet), then gives up;
// - "peer taken" (the relay still holds this page's old connection, not yet noticed as dead): a new peer
//   id, and the page is told (`onSelf`), since its direct connections must start again under the new id;
// - "host key" (a host link that doesn't match the room): joins as a guest instead;
// - "ended", "removed", "replaced", "full" and bad names or codes end the connection for good (`over`).
import { newPeerId } from './formats.js';
import { TIMES } from './config.js';

export function connectRoom({
  url, room, name, create = false, hostKey = null, peer: firstPeer = newPeerId(),
  onMessage = () => {}, onState = () => {}, onSelf = () => {},
  WebSocketImpl = globalThis.WebSocket, makePeerId = newPeerId, times = TIMES,
  setTimer = (f, ms) => setTimeout(f, ms), clearTimer = (t) => clearTimeout(t),
}) {
  let ws = null, stopped = false, joined = false, delay = 500, timer = null, noRoom = 0;
  let peer = firstPeer, key = hostKey, wantsHost = !!(create || hostKey), isHost = false;
  const queue = [];

  const joinMessage = () => ({ t: 'join', room, peer, name, ...(wantsHost ? { create: true } : {}), ...(wantsHost && key ? { hostKey: key } : {}) });
  const sendRaw = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const over = (why, detail) => {
    if (stopped) return;
    stopped = true; joined = false;
    clearTimer(timer);
    onState('over', { why, ...detail });
    if (ws) { try { ws.close(); } catch { /* closing anyway */ } }
  };

  function open() {
    if (stopped) return;
    onState(joined ? 'down' : 'connecting');
    joined = false;
    try { ws = new WebSocketImpl(url); } catch { return retry(); }
    const me = ws;
    me.onopen = () => { delay = 500; sendRaw(joinMessage()); };
    me.onmessage = (e) => {
      if (me !== ws) return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (!m || typeof m.t !== 'string') return;
      handle(m);
    };
    me.onclose = (e) => {
      if (me !== ws) return;
      ws = null;
      const was = joined;
      joined = false;
      if (stopped) return;
      if (e && e.code >= 4000 && e.code <= 4002) return over(e.code === 4000 ? 'ended' : e.code === 4001 ? 'removed' : 'replaced');
      onState('down', { wasJoined: was });
      retry();
    };
    me.onerror = () => {};
  }

  function handle(m) {
    switch (m.t) {
      case 'joined':
        joined = true; noRoom = 0;
        isHost = !!m.host;
        if (m.host && m.hostKey) key = m.hostKey;
        onState('joined', { host: isHost, hostKey: isHost ? key : null, peer });
        while (queue.length && joined) sendRaw(queue.shift());
        break;
      case 'ended': return over('ended', { by: m.why });
      case 'removed': return over('removed');
      case 'replaced': return over('replaced');
      case 'full': return over('full');
      case 'error': return error(m);
      default: break;
    }
    onMessage(m);
  }

  function error(m) {
    if (joined) return onMessage(m);          // a refused message once in the room ("not here", "too many"…)
    switch (m.why) {
      case 'no room':
        if (wantsHost) return over('no room');
        if (++noRoom > times.noRoomTries) return over('no room');
        onState('no-room', { tries: noRoom });
        clearTimer(timer);
        timer = setTimer(() => sendRaw(joinMessage()), times.noRoomRetryMs);
        return;
      case 'peer taken':
        peer = makePeerId();
        onSelf(peer);
        return sendRaw(joinMessage());
      case 'host key':
        wantsHost = false; key = null;
        onState('not-host');
        return sendRaw(joinMessage());
      case 'room taken': return over('room taken');
      case 'name': case 'room': case 'peer': return over('refused', { detail: m.why });
      default: return onMessage(m);
    }
  }

  function retry() {
    clearTimer(timer);
    timer = setTimer(open, delay);
    delay = Math.min(delay * 2, 8000);
  }

  function send(m) {
    if (stopped) return;
    if (joined && ws && ws.readyState === 1) sendRaw(m);
    else if (queue.length < 200) queue.push(m);
  }

  open();
  return {
    to: (p, data) => send({ t: 'to', peer: p, data }),
    all: (data) => send({ t: 'all', data }),
    remove: (p) => send({ t: 'remove', peer: p }),
    end: () => send({ t: 'end' }),
    /** Ask the relay for TURN credentials (answered with { t: "ice", … } through onMessage). */
    askIce: () => send({ t: 'ice' }),
    stop() { stopped = true; clearTimer(timer); if (ws) { try { ws.close(); } catch { /* closing anyway */ } } },
    // For the checks: drop the connection as a network blip would (it comes back by itself).
    blip() { if (ws) ws.close(); },
    get peer() { return peer; },
    get hostKey() { return key; },
    get isHost() { return isHost; },
    get joined() { return joined; },
  };
}
