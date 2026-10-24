// poll.js: the live poll (rooms-live-tiles-plan.md, L7 to L7e). Ask a question with 2 to 6 options; everyone
// votes (one vote each, which you can change); the results show live. The first to ask owns the poll: only
// they can close it or start a new one, unless they've left. Shared live in a room, every copy sees the same
// poll; alone (a gallery, a viewer, a room before it's shared live) it's a poll for one.
//
// Newcomers: when someone comes in (or back), every copy that has been live sends the poll as it stands (the
// copies merge what they hear, so repeats do no harm). A copy that has never been live (it just arrived, or
// live sharing just started) sets its own poll aside, starts afresh and waits a moment for the room's; if the
// room has none, it offers its own, and the first poll in the room's order wins (anyone else's copy says so).
// When live sharing stops, every copy keeps what it has; if it starts again, they all start afresh this way.
import { joinLive } from './live-talk.js';
import { emptyState, apply, results, snapshot, mayReplace, readPoll, MAX_OPTIONS, MIN_OPTIONS, MAX_Q, MAX_OPTION } from './poll-state.js';
import { READY } from './ready.js';

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
  return e;
};

let state = emptyState();
let you = null, here = [], paused = false, writing = false, notice = '';
let lastK = 0;
let wasLive = false;       // has this copy been live (with others) since live sharing last started?
let held = null;           // our poll as it was before we joined (a `state` message), offered if the room has none
let waiting = null;        // a timer while we wait for the room's poll
let offered = null;        // the id of the poll we offered, until we know whether it won
const WAIT_MS = 2000;
let noticeTimer = null;
// A short note under the poll; it goes after a few seconds.
function tell(text) { notice = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice = ''; render(); }, 6000); }

const newId = () => {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => abc[x % 36]).join('');
};
const nextK = () => { lastK = Math.max(Date.now(), lastK + 1); return lastK; };
const isLive = () => here.length > 1;

const live = joinLive({
  onPresence(p) {
    you = p.you; here = p.here;
    if (here.length <= 1) {                               // on our own (not live, or live sharing stopped)
      if (waiting) { clearTimeout(waiting); waiting = null; if (!state.poll && held) restore(held); held = null; }
      wasLive = false;
    } else if (!wasLive) {                                // just arrived in a live room
      if (!waiting) { held = state.poll ? snapshot(state) : null; state = emptyState(); waiting = setTimeout(offer, WAIT_MS); }
    } else if (p.joined.length && state.poll) live.send(snapshot(state));
    render();
  },
  onMessage({ from, data }) {
    const what = apply(state, data, from, here);
    if (what === 'refused-ask' && from === you) tell('Someone else’s poll was shared first.');
    if (what === 'asked' || what === 'replaced') { if (from === you) writing = false; notice = ''; }
    if (offered && state.poll) { if (state.poll.id !== offered) tell('Someone else’s poll was shared first.'); offered = null; }
    if (waiting && state.poll) offer();                   // the room's poll arrived
    render();
  },
  onPaused() { paused = true; render(); },
  onResumed() { paused = false; render(); },
  onLimit(reason) {
    tell({
      rate: 'Slow down a little: that didn’t go out.', room: 'The room is busy: that didn’t go out. Try again.',
      paused: 'Paused: that didn’t go out.', connection: 'No direct connection to the host: that didn’t go out.',
      size: 'That’s too long to send.', json: 'That couldn’t be sent.',
    }[reason] || 'That didn’t go out.');
    render();
  },
});

// Done waiting (the room's poll came, or nobody had one): from now on we're a live copy. If the room has no
// poll, offer ours (with its votes); the first one in the room's order wins.
function offer() {
  clearTimeout(waiting);
  waiting = null;
  wasLive = true;
  const mine = held;
  held = null;
  if (!mine) return;
  if (state.poll) { if (state.poll.id !== mine.poll.id) tell('Someone else’s poll was shared first.'); render(); return; }
  offered = mine.poll.id;
  live.send(mine);
}
function restore(snap) { state = emptyState(); apply(state, snap, snap.poll.asker, here); }

// ---- Asking ----
function ask(q, options) {
  const poll = readPoll({ id: newId(), q, options });
  if (!poll) { tell(`A question (up to ${MAX_Q} characters) and ${MIN_OPTIONS} to ${MAX_OPTIONS} options (up to ${MAX_OPTION} each).`); render(); return; }
  live.send({ t: 'ask', ...poll, ...(state.poll ? { replaces: state.poll.id } : {}) });
}
const vote = (option) => { if (state.poll && !state.poll.closed && !paused) live.send({ t: 'vote', poll: state.poll.id, option, k: nextK() }); };
const closePoll = () => { if (state.poll && state.poll.asker === you) live.send({ t: 'close', poll: state.poll.id }); };

// ---- Drawing ----
function statusLine() {
  if (paused) return 'Paused: waiting for the room to come back';
  if (isLive()) return `Live · ${here.length} here`;
  return 'Just you. When a room shares this poll live, everyone votes together.';
}

function form() {
  const q = el('input', { type: 'text', id: 'q', maxlength: MAX_Q, placeholder: 'Your question', 'aria-label': 'Question' });
  const list = el('ol', { class: 'opts' });
  const addRow = (v = '') => {
    if (list.children.length >= MAX_OPTIONS) return;
    const input = el('input', { type: 'text', maxlength: MAX_OPTION, placeholder: `Option ${list.children.length + 1}`, 'aria-label': `Option ${list.children.length + 1}`, value: v });
    const drop = el('button', { type: 'button', class: 'drop', 'aria-label': 'Remove this option', onclick: () => { if (list.children.length > MIN_OPTIONS) { li.remove(); sync(); } } }, '×');
    const li = el('li', {}, input, drop);
    list.append(li);
    sync();
  };
  const sync = () => {
    more.disabled = list.children.length >= MAX_OPTIONS;
    for (const b of list.querySelectorAll('.drop')) b.disabled = list.children.length <= MIN_OPTIONS;
  };
  const more = el('button', { type: 'button', class: 'more', onclick: () => addRow() }, 'Add an option');
  const pick = el('select', { 'aria-label': 'A ready-made poll', onchange: () => {
    const r = READY[Number(pick.value)];
    if (!r) return;
    q.value = r.q;
    list.replaceChildren();
    r.options.forEach((o) => addRow(o));
    pick.value = '';
  } }, el('option', { value: '' }, 'Pick a ready-made poll…'), READY.map((r, i) => el('option', { value: String(i) }, r.q)));
  addRow(); addRow(); addRow();
  // No <form>: a tile runs in a sandboxed frame, where forms can't be submitted (not even to a script).
  const submit = () => ask(q.value, [...list.querySelectorAll('input')].map((i) => i.value).filter((v) => v.trim()));
  const go = el('button', { type: 'button', class: 'primary', onclick: submit }, 'Start poll');
  const cancel = state.poll ? el('button', { type: 'button', onclick: () => { writing = false; render(); } }, 'Cancel') : null;
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  return el('div', { class: 'ask' }, pick, q, list, el('div', { class: 'row' }, more, el('span', { class: 'grow' }), cancel, go));
}

// (The width is set from script: the tile's policy allows no inline style attributes.)
const bar = (pct) => { const b = el('span', { class: 'bar' }); b.style.width = `${pct}%`; return b; };

function pollView() {
  const p = state.poll;
  const r = results(state, you);
  const max = Math.max(1, ...r.counts);
  const items = p.options.map((o, i) => {
    const mine = r.mine === i;
    return el('li', { class: `opt${mine ? ' mine' : ''}` },
      el('button', { type: 'button', class: 'vote', disabled: p.closed || paused, 'aria-pressed': String(mine), onclick: () => vote(i) },
        bar(Math.round((r.counts[i] / max) * 100)),
        el('span', { class: 'label' }, o),
        mine ? el('span', { class: 'yours' }, 'Your vote') : null,
        el('span', { class: 'count' }, String(r.counts[i]))));
  });
  const canNew = mayReplace(state, you, here);
  return el('section', { class: 'poll' },
    p.closed ? el('p', { class: 'closed' }, 'Closed') : null,
    el('h1', {}, p.q),
    el('ol', { class: 'results' }, items),
    el('p', { class: 'tally' }, `${r.total} ${r.total === 1 ? 'vote' : 'votes'}${isLive() ? ` · ${here.length} here` : ''}`),
    el('div', { class: 'row' },
      p.asker === you && !p.closed ? el('button', { type: 'button', onclick: closePoll, disabled: paused }, 'Close poll') : null,
      canNew ? el('button', { type: 'button', onclick: () => { writing = true; notice = ''; render(); }, disabled: paused }, 'New poll') : null));
}

function render() {
  $('#status').textContent = statusLine();
  $('#status').dataset.state = paused ? 'paused' : isLive() ? 'live' : 'alone';
  $('#notice').textContent = notice;
  const main = $('#main');
  const showForm = !state.poll || writing;
  if (showForm && main.dataset.view === 'form') return;      // keep what's being typed
  main.dataset.view = showForm ? 'form' : 'poll';
  main.replaceChildren(showForm ? form() : pollView());
}

render();
// For checks and curious eyes: what this copy knows.
window.__poll = { get state() { return state; }, get you() { return you; }, get here() { return [...here]; }, get mode() { return live.mode; } };
