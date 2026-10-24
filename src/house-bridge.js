// house-bridge.js: the host's page holding the house tile (rooms-lab-plan.md, R1 and section 6).
//
// The house runs only on the host's computer, hidden. Everyone's wishes come to the host's page through the
// relay; the page asks the house; the house answers allow, deny or ask-host. Messages between the page and
// the house go through fixed rules, like the table routers (Daisy's page/router.js):
//   page → house   ping, state, wish                (stamped from: "page")
//   house → page   hello, pong, rule                 (anything else is dropped, and logged)
// A rule must answer a wish the page actually asked about, with allow, deny or ask-host.
//
// The page keeps powers no house can override (R1): the consent prompts, the browser's picker, the call,
// ending the room, removing someone, stopping your own share. The house only decides whether a request may
// go on to the person it's about.
//
// No house (it didn't load, isn't set up, or doesn't answer in time): the page's own fallback, "the host
// approves each request" (fallbackRule below). The asker never waits on a stuck tile.
//
// Which requests a house decides: it lists them in its hello (`wishes`, live tiles onward). The page asks it
// only about those, and decides any other request with the same fallback (so a house published before a new
// kind of request never refuses it just for being new). A house whose hello has no list is the first one
// (Oct 24): it knows see-screen, present and open-tile.
//
// `makeFrame()` gives the house's frame: on the site (build step 5) the tile loader's frame for the pinned
// house record; on the lab's dev page a sealed (sandboxed) frame of tiles/house/. Either way the house
// talks with the tiles protocol's data messages, so the bridge listens for those from that frame only.

export const UP = 'tiles-protocol-up-data-payload';
export const DOWN = 'tiles-protocol-down-data-payload';
export const GAME = 'rooms';
export const VERSION = 1;
export const PAGE_TO_HOUSE = ['ping', 'state', 'wish'];
export const HOUSE_TO_PAGE = ['hello', 'pong', 'rule'];
export const DECISIONS = ['allow', 'deny', 'ask-host'];
export const FIRST_HOUSE_WISHES = Object.freeze(['see-screen', 'present', 'open-tile']);
export const LIMITS = Object.freeze({ maxBytes: 8 * 1024, burst: 40, perSecond: 20 });
export const TIMES = Object.freeze({ helloMs: 8000, answerMs: 2500 });

/** The page's own rule when there's no house: "the host approves each request" (R1). The host's own
 *  requests, and requests to see the host's screen, go ahead: the host's own prompt is the decision. */
export function fallbackRule(state, wish) {
  if (wish.by === state.host) return { decision: 'allow', reason: 'The host decides for themselves.' };
  if (wish.wish === 'see-screen' && wish.target === state.host) return { decision: 'allow', reason: 'The host answers for their own screen.' };
  return { decision: 'ask-host', reason: 'The host approves each request.' };
}

/** A payload from the house, checked: { kind, ... } to use, or { drop: why }. */
export function readFromHouse(raw, { asked = () => true, limits = LIMITS } = {}) {
  if (!raw || typeof raw !== 'object' || raw.game !== GAME || raw.v !== VERSION || typeof raw.kind !== 'string') return { drop: 'not a Rooms message' };
  let size = Infinity;
  try { size = JSON.stringify(raw).length; } catch { /* not sendable */ }
  if (size > limits.maxBytes) return { drop: 'too big' };
  if (!HOUSE_TO_PAGE.includes(raw.kind)) return { drop: `the house may not send "${String(raw.kind).slice(0, 30)}"` };
  if (raw.kind === 'hello') {
    const wishes = Array.isArray(raw.wishes)
      ? raw.wishes.filter((w) => typeof w === 'string' && /^[a-z-]{1,30}$/.test(w)).slice(0, 20)
      : [...FIRST_HOUSE_WISHES];
    return { kind: 'hello', rules: typeof raw.rules === 'string' ? raw.rules.slice(0, 60) : '', wishes };
  }
  if (raw.kind === 'pong') return { kind: 'pong' };
  // a rule
  if (typeof raw.id !== 'string' || !asked(raw.id)) return { drop: 'a rule for no wish the page asked about' };
  if (!DECISIONS.includes(raw.decision)) return { drop: 'not allow, deny or ask-host' };
  const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : '';
  return { kind: 'rule', id: raw.id, decision: raw.decision, reason };
}

export function createHouseBridge({
  makeFrame = null, mount = null, win = globalThis, times = TIMES, limits = LIMITS, now = () => Date.now(),
  onLog = () => {}, onStatus = () => {},
}) {
  let frame = null, status = 'off', rules = '', wishes = [], lastState = '', helloTimer = null, n = 0;
  const pending = new Map();         // our wish id → { resolve, timer }
  const bucket = { tokens: limits.burst, at: now() };
  const allowed = () => {
    const t = now();
    bucket.tokens = Math.min(limits.burst, bucket.tokens + ((t - bucket.at) / 1000) * limits.perSecond);
    bucket.at = t;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };
  const set = (s, extra) => { if (s !== status) { status = s; onStatus(s, extra); } };

  function post(kind, fields) {
    const w = frame && frame.contentWindow;
    if (!w) return false;
    w.postMessage({ action: DOWN, payload: { ...fields, game: GAME, v: VERSION, kind, from: 'page' } }, '*');
    return true;
  }

  function onMessage(e) {
    if (!frame || e.source !== frame.contentWindow) return;
    const d = e.data;
    if (!d || d.action !== UP) return;
    if (!allowed()) { onLog('drop', 'too many messages from the house'); return; }
    const m = readFromHouse(d.payload, { asked: (id) => pending.has(id), limits });
    if (m.drop) { onLog('drop', m.drop); return; }
    if (m.kind === 'hello') {
      clearTimeout(helloTimer);
      rules = m.rules;
      wishes = m.wishes;
      lastState = '';
      set('ready', { rules });
      onLog('ready', `the house is ready (rules: ${rules || 'unnamed'})`);
      if (stateNow) sendState(stateNow);
      return;
    }
    if (m.kind === 'pong') return;
    const p = pending.get(m.id);
    pending.delete(m.id);
    clearTimeout(p.timer);
    p.resolve({ decision: m.decision, reason: m.reason, by: 'house' });
  }

  let stateNow = null;
  function sendState(s) {
    const text = JSON.stringify(s);
    if (text === lastState) return;
    lastState = text;
    post('state', s);
  }

  return {
    async start() {
      if (!makeFrame) { set('off'); return; }
      set('loading');
      win.addEventListener('message', onMessage);
      try { frame = await makeFrame(); } catch { frame = null; }
      if (!frame) { set('failed'); return; }
      if (mount) mount.append(frame);
      helloTimer = setTimeout(() => { if (status === 'loading') set('failed'); }, times.helloMs);
    },
    /** The room as the host's page sees it: { host, presenter, peers: [{ peer, name, host, away? }] }. */
    setState(s) { stateNow = s; if (status === 'ready') sendState(s); },
    /** The house's decision on a wish ({ by, wish, target?, uri? }; by: who asks), or the page's fallback. */
    decide(state, wish) {
      if (status !== 'ready') return Promise.resolve({ ...fallbackRule(state, wish), by: 'page' });
      if (!wishes.includes(wish.wish)) return Promise.resolve({ ...fallbackRule(state, wish), by: 'page', unknown: true });
      const id = `w${++n}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          onLog('timeout', 'the house didn’t answer in time: the host decides');
          resolve({ ...fallbackRule(state, wish), by: 'page' });
        }, times.answerMs);
        pending.set(id, { resolve, timer });
        this.setState(state);
        post('wish', { id, ...wish });
      });
    },
    get status() { return status; },
    get rules() { return rules; },
    /** The requests the house decides (from its hello). */
    get wishes() { return [...wishes]; },
    get frame() { return frame; },
    stop() {
      clearTimeout(helloTimer);
      win.removeEventListener('message', onMessage);
      for (const p of pending.values()) clearTimeout(p.timer);
      pending.clear();
      if (frame) frame.remove();
      frame = null;
      set('off');
    },
  };
}
