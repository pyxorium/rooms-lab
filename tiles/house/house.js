// house.js: the Rooms lab house tile (rooms-lab-plan.md, section 6). It runs hidden, only on the host's
// page; everyone else's wishes travel to the host's page through the relay, and the host's page asks this
// tile. It holds the rules (rules.js) and nothing else: no network, no storage, no memory beyond the room's
// state the page last sent (who's here, who's presenting). If it restarts (the host reloads) the page
// sends that state again.
//
//   page → house   { kind: "ping" }  { kind: "state", host, presenter, peers }  { kind: "wish", id, by, wish, target?, uri? }
//   house → page   { kind: "hello", rules }  { kind: "pong" }  { kind: "rule", id, decision, reason }
import { connect } from './talk.js';
import { decide, RULE_SET } from './rules.js';

let state = null;

// On its own (a tile gallery, a viewer, or opened directly) no page sets the house up: after a moment it
// shows a card saying what it is instead of an empty page (as Daisy's house does).
export const ALONE_MS = 1500;
function showCard() {
  if (state) return;
  const pic = document.getElementById('card-pic');
  pic.addEventListener('error', () => { pic.hidden = true; }, { once: true });   // copies without pictures
  pic.src = './banner.png';
  document.getElementById('card').hidden = false;
  document.documentElement.dataset.alone = '1';
}

const talk = await connect(onMessage);
if (talk.via === 'none') showCard(); else setTimeout(showCard, ALONE_MS);
talk.send('hello', { rules: RULE_SET });

function onMessage(p) {
  if (p.kind === 'ping') return talk.send('pong');
  if (p.kind === 'state') {
    state = { host: p.host, presenter: p.presenter || null, peers: Array.isArray(p.peers) ? p.peers : [] };
    document.getElementById('card').hidden = true;
    delete document.documentElement.dataset.alone;
    return;
  }
  if (p.kind === 'wish') {
    if (typeof p.id !== 'string') return;
    const { decision, reason } = decide(state, p);
    talk.send('rule', { id: p.id, decision, reason });
  }
}
