// poll-state.js: what the live poll knows, and how each message changes it. No browser parts, so it's tested
// in Node (test/poll-state.test.mjs). Every copy applies the same messages in the room's one order (the host's
// page numbers them), so every copy ends up the same (rooms-live-tiles-plan.md, L7a to L7d).
//
// Messages (the `data` a copy sends; `from` is the sender's copy id, given by the room):
//   { t: "ask", id, q, options: [2 to 6], replaces? }   a poll. The first one wins: it's taken only when there's
//        no poll yet, or when it replaces the current one and comes from its asker (or the asker has left).
//   { t: "vote", poll, option, k }    your vote (change it any time); k grows with each of your votes, so the
//        latest vote counts however the copies learn of it
//   { t: "close", poll }              the asker closes the poll: results freeze
//   { t: "state", poll, votes }       for newcomers: the poll and its votes. Taken when there's no poll yet;
//        its votes merge (by k); a closed poll stays closed.

export const MAX_OPTIONS = 6, MIN_OPTIONS = 2, MAX_Q = 140, MAX_OPTION = 60;
export const isPollId = (x) => typeof x === 'string' && /^[a-z0-9]{8,32}$/.test(x);

export function emptyState() { return { poll: null, votes: {} }; }

const clean = (s, max) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/** A poll from someone's message, checked; null if it isn't one. */
export function readPoll(p) {
  if (!p || typeof p !== 'object' || !isPollId(p.id)) return null;
  const q = clean(p.q);
  if (!q || q.length > MAX_Q || !Array.isArray(p.options)) return null;
  const options = p.options.map((o) => clean(o));
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS || options.some((o) => !o || o.length > MAX_OPTION)) return null;
  return { id: p.id, q, options };
}

const isOption = (state, poll, option) => Number.isInteger(option) && option >= 0
  && option < (state.poll && state.poll.id === poll ? state.poll.options.length : MAX_OPTIONS);
const isK = (k) => Number.isSafeInteger(k) && k > 0;

function setVote(state, poll, voter, option, k) {
  const v = state.votes[poll] || (state.votes[poll] = {});
  const had = v[voter];
  if (had && had[1] >= k) return false;
  v[voter] = [option, k];
  // keep the votes of a few polls at most (the current one, and any a newcomer might still hear of)
  const ids = Object.keys(state.votes);
  if (ids.length > 4) for (const id of ids) if (state.poll?.id !== id && id !== poll && Object.keys(state.votes).length > 4) delete state.votes[id];
  return true;
}

/** Apply one message. Returns what happened: "asked", "replaced", "refused-ask", "voted", "closed",
 *  "merged", "ignored". `here`: the copy ids here now (who may replace a poll whose asker left). */
export function apply(state, data, from, here = []) {
  if (!data || typeof data !== 'object') return 'ignored';
  switch (data.t) {
    case 'ask': {
      const p = readPoll(data);
      if (!p) return 'ignored';
      const cur = state.poll;
      if (!cur) { state.poll = { ...p, asker: from, closed: false }; return 'asked'; }
      if (data.replaces === cur.id && cur.id !== p.id && (from === cur.asker || !here.includes(cur.asker))) {
        state.poll = { ...p, asker: from, closed: false };
        return 'replaced';
      }
      return 'refused-ask';
    }
    case 'vote': {
      if (!isPollId(data.poll) || !isOption(state, data.poll, data.option) || !isK(data.k)) return 'ignored';
      return setVote(state, data.poll, from, data.option, data.k) ? 'voted' : 'ignored';
    }
    case 'close': {
      const cur = state.poll;
      if (!cur || data.poll !== cur.id || from !== cur.asker || cur.closed) return 'ignored';
      cur.closed = true;
      return 'closed';
    }
    case 'state': {
      let what = 'ignored';
      const p = data.poll ? readPoll(data.poll) : null;
      if (p && isPollId(data.poll.asker)) {
        if (!state.poll) { state.poll = { ...p, asker: data.poll.asker, closed: !!data.poll.closed }; what = 'merged'; }
        else if (state.poll.id === p.id && data.poll.closed === true && !state.poll.closed) { state.poll.closed = true; what = 'merged'; }
      }
      if (p && data.votes && typeof data.votes === 'object') {
        for (const [voter, v] of Object.entries(data.votes).slice(0, 64)) {
          if (!isPollId(voter) || !Array.isArray(v) || !isOption(state, p.id, v[0]) || !isK(v[1])) continue;
          if (setVote(state, p.id, voter, v[0], v[1])) what = 'merged';
        }
      }
      return what;
    }
    default: return 'ignored';
  }
}

/** The current poll's results: counts per option, how many voted, and your vote (or null). */
export function results(state, you) {
  const p = state.poll;
  if (!p) return null;
  const v = state.votes[p.id] || {};
  const counts = p.options.map(() => 0);
  let total = 0;
  for (const [, [option]] of Object.entries(v)) if (option < counts.length) { counts[option] += 1; total += 1; }
  const mine = v[you] ? v[you][0] : null;
  return { counts, total, mine };
}

/** What a copy sends newcomers. */
export function snapshot(state) {
  const p = state.poll;
  return { t: 'state', poll: p ? { id: p.id, q: p.q, options: p.options, asker: p.asker, closed: p.closed } : null, votes: p ? { ...(state.votes[p.id] || {}) } : {} };
}

/** May `you` start a new poll now? (No poll, or you asked the current one, or its asker has left.) */
export function mayReplace(state, you, here) {
  const p = state.poll;
  return !p || p.asker === you || !here.includes(p.asker);
}
