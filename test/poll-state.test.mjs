// The live poll's logic (tiles/poll/poll-state.js) on its own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, apply, results, snapshot, mayReplace, readPoll } from '../tiles/poll/poll-state.js';

const N = 'nnnnnnnnnnnnnnnn', R = 'rrrrrrrrrrrrrrrr', T = 'tttttttttttttttt';
const ask = (id, extra = {}) => ({ t: 'ask', id, q: 'Tea or coffee?', options: ['Tea', 'Coffee'], ...extra });
const P1 = 'poll0000000000a1', P2 = 'poll0000000000b2';

test('a poll: a question and 2 to 6 options, trimmed; anything else isn\'t one', () => {
  assert.deepEqual(readPoll({ id: P1, q: '  Tea   or coffee? ', options: [' Tea', 'Coffee '] }), { id: P1, q: 'Tea or coffee?', options: ['Tea', 'Coffee'] });
  for (const bad of [{ id: P1, q: '', options: ['a', 'b'] }, { id: P1, q: 'x', options: ['a'] }, { id: P1, q: 'x', options: Array(7).fill('a') },
    { id: P1, q: 'x'.repeat(141), options: ['a', 'b'] }, { id: P1, q: 'x', options: ['a', 'y'.repeat(61)] }, { id: 'BAD', q: 'x', options: ['a', 'b'] },
    { id: P1, q: 'x', options: ['a', ''] }, null]) assert.equal(readPoll(bad), null, JSON.stringify(bad));
});

test('the first to ask owns the poll: a second ask is refused; the asker (or anyone, once the asker left) replaces it', () => {
  const s = emptyState();
  assert.equal(apply(s, ask(P1), N, [N, R]), 'asked');
  assert.equal(apply(s, ask(P2), R, [N, R]), 'refused-ask');
  assert.equal(apply(s, ask(P2, { replaces: P1 }), R, [N, R]), 'refused-ask', 'only the asker replaces it');
  assert.equal(mayReplace(s, R, [N, R]), false);
  assert.equal(mayReplace(s, R, [R]), true, 'the asker left');
  assert.equal(apply(s, ask(P2, { replaces: P1 }), R, [R]), 'replaced');
  assert.equal(s.poll.asker, R);
  assert.equal(apply(s, ask('poll0000000000c3', { replaces: P1 }), R, [R]), 'refused-ask', 'it must replace the current poll');
});

test('votes: one each, changeable; the latest (by k) counts whatever order they arrive in; your vote is marked', () => {
  const s = emptyState();
  apply(s, ask(P1), N);
  apply(s, { t: 'vote', poll: P1, option: 0, k: 10 }, N);
  apply(s, { t: 'vote', poll: P1, option: 1, k: 10 }, R);
  apply(s, { t: 'vote', poll: P1, option: 0, k: 20 }, R);
  assert.equal(apply(s, { t: 'vote', poll: P1, option: 1, k: 15 }, R), 'ignored', 'an older vote doesn\'t undo a newer one');
  assert.deepEqual(results(s, R), { counts: [2, 0], total: 2, mine: 0 });
  assert.deepEqual(results(s, T), { counts: [2, 0], total: 2, mine: null });
  for (const bad of [{ option: 2 }, { option: -1 }, { option: 1.5 }, { k: 0 }, { poll: 'x' }]) assert.equal(apply(s, { t: 'vote', poll: P1, option: 1, k: 99, ...bad }, T), 'ignored', JSON.stringify(bad));
});

test('close: only the asker; results freeze (the copies show Closed)', () => {
  const s = emptyState();
  apply(s, ask(P1), N);
  assert.equal(apply(s, { t: 'close', poll: P1 }, R), 'ignored');
  assert.equal(apply(s, { t: 'close', poll: P1 }, N), 'closed');
  assert.equal(s.poll.closed, true);
});

test('state for newcomers: taken when there\'s no poll; votes merge by k; a closed poll stays closed; another poll doesn\'t replace ours', () => {
  const a = emptyState();
  apply(a, ask(P1), N);
  apply(a, { t: 'vote', poll: P1, option: 1, k: 5 }, N);
  apply(a, { t: 'vote', poll: P1, option: 0, k: 7 }, R);
  const snap = snapshot(a);
  assert.equal(snap.t, 'state');
  const b = emptyState();
  assert.equal(apply(b, snap, N), 'merged');
  assert.deepEqual(results(b, R), results(a, R));
  assert.equal(b.poll.asker, N);
  // a stale snapshot (Robin's older vote) doesn't undo her newer one
  apply(b, { t: 'vote', poll: P1, option: 1, k: 9 }, R);
  apply(b, snap, N);
  assert.equal(results(b, R).mine, 1);
  // a different poll's state doesn't replace the current poll
  const other = emptyState(); apply(other, ask(P2), T);
  apply(b, snapshot(other), T);
  assert.equal(b.poll.id, P1);
  // closed travels
  apply(a, { t: 'close', poll: P1 }, N);
  apply(b, snapshot(a), N);
  assert.equal(b.poll.closed, true);
  assert.equal(apply(emptyState(), { t: 'state', poll: null, votes: {} }, N), 'ignored', 'an empty room: nothing to take');
});

test('agreement: copies that start from different places but read the same messages in the same order end up the same', () => {
  // Nick's copy was live with P1; Robin's copy arrives (starts afresh). The room's order, as the host numbered it:
  const order = [
    [{ t: 'vote', poll: P1, option: 1, k: 30 }, T],      // Ted votes while Robin is arriving
    [snapshot((() => { const s = emptyState(); apply(s, ask(P1), N); apply(s, { t: 'vote', poll: P1, option: 0, k: 20 }, T); return s; })()), N],   // Nick's (slightly stale) state
    [ask(P2), R],                                          // Robin offers her own poll: refused everywhere
    [{ t: 'vote', poll: P1, option: 0, k: 40 }, R],
  ];
  const nick = emptyState(); apply(nick, ask(P1), N); apply(nick, { t: 'vote', poll: P1, option: 0, k: 20 }, T);
  const robin = emptyState();
  for (const [data, from] of order) { apply(nick, data, from, [N, R, T]); apply(robin, data, from, [N, R, T]); }
  assert.deepEqual(robin, nick);
  assert.deepEqual(results(robin, R), { counts: [1, 1], total: 2, mine: 0 });
  assert.equal(results(robin, T).mine, 1, 'Ted\'s newer vote won over the stale state');
});
