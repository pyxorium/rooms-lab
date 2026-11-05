// Live Pong's logic (tiles/pong/pong-state.js) and court (tiles/pong/pong-physics.js): no referee copy, so
// every copy must reach the same list, game, score and result from the same messages in the same order.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyState, apply, snapshot, readSnapshot, sideOf, WIN, nextUp } from '../tiles/pong/pong-state.js';
import {
  COURT, BALL_R, planeOf, mirror, ballAt, timeToPlane, serveSegment, returnSegment, takes, follow, readSegment, headingTo, wallHits, PADDLE_SPEED, MAX_SPEED,
} from '../tiles/pong/pong-physics.js';

const SAM = 'samsamsamsamsam1', ROB = 'robrobrobrobrob2', LEE = 'leeleeleeleelee3', ANA = 'anaanaanaanaana4';

// A room: several copies applying the same numbered messages.
function room(k = 3) {
  const copies = Array.from({ length: k }, () => emptyState());
  let n = 0;
  return {
    copies,
    send(from, data) { n += 1; return copies.map((c) => apply(c, data, from, n)); },
    get n() { return n; },
    same() { for (const c of copies.slice(1)) assert.deepEqual(c, copies[0]); return copies[0]; },
  };
}
// The receiver returns the ball from the middle of its paddle (as its copy would).
function hitFrom(state, from) {
  const r = state.game.rally;
  const side = sideOf(state.game, from);
  const t = timeToPlane(r.seg);
  const at = ballAt(r.seg, t);
  return { t: 'hit', r: r.r, h: r.hits + 1, seg: returnSegment(r.seg, side, at.p, at.p) };
}

test('the play list: the first two on it play; names typed or "Player N"; tap again after a game (P7, P8)', () => {
  const R = room();
  R.send(SAM, { t: 'list', on: true, name: '  Sam\u0007 ' });
  let s = R.same();
  assert.deepEqual(s.list, [SAM]);
  assert.equal(s.names[SAM], 'Sam');
  assert.equal(s.game, null, 'one on the list: waiting for a second player');
  R.send(ROB, { t: 'list', on: true, name: '' });
  s = R.same();
  assert.ok(s.game, 'two on the list: a game starts');
  assert.equal(s.game.a, SAM);
  assert.equal(s.game.b, ROB);
  assert.equal(s.names[ROB], 'Player 1');
  assert.deepEqual(s.list, [], 'the players leave the list');
  R.send(LEE, { t: 'list', on: true, name: 'Lee' });
  R.send(ANA, { t: 'list', on: true, name: 'A very long name that goes on and on' });
  s = R.same();
  assert.deepEqual(nextUp(s), [LEE, ANA]);
  assert.equal(s.names[ANA].length, 20);
  assert.deepEqual(R.send(SAM, { t: 'list', on: true }), ['ignored', 'ignored', 'ignored'], 'a player in a game can’t join the list');
  R.send(LEE, { t: 'list', on: false });
  assert.deepEqual(R.same().list, [ANA]);
  R.send(SAM, { t: 'gone', id: ANA });
  assert.deepEqual(R.same().list, []);
});

test('a whole game: serves, returns, misses; the loser serves; first to 7; every copy the same (P2 to P4, P9)', () => {
  const R = room(4);
  R.send(SAM, { t: 'list', on: true, name: 'Sam' });
  R.send(ROB, { t: 'list', on: true, name: 'Rob' });
  R.send(LEE, { t: 'list', on: true, name: 'Lee' });
  let s = R.same();
  const g = s.game.g;
  assert.equal(s.game.server, 'a');
  assert.deepEqual(R.send(ROB, { t: 'serve', g, pt: 1, angle: 0.1 }), Array(4).fill('ignored'), 'only the server serves');
  let rounds = 0;
  while (R.copies[0].game && R.copies[0].game.g === g) {
    s = R.copies[0];
    const server = s.game.server === 'a' ? s.game.a : s.game.b;
    R.send(server, { t: 'serve', g, pt: s.game.pt, angle: 0.2 });
    // a short rally: the receiver returns once, then the server's side misses
    let st = R.copies[0];
    const receiver = st.game.rally.to === 'a' ? st.game.a : st.game.b;
    R.send(receiver, hitFrom(st, receiver));
    st = R.copies[0];
    assert.deepEqual(R.send(receiver, hitFrom(st, receiver)), Array(4).fill('ignored'), 'not your turn twice');
    const backTo = st.game.rally.to === 'a' ? st.game.a : st.game.b;
    assert.equal(backTo, server);
    R.send(backTo, { t: 'miss', r: st.game.rally.r, h: st.game.rally.hits });
    R.same();
    rounds += 1;
    assert.ok(rounds <= 20);
  }
  s = R.same();
  assert.equal(rounds, WIN, 'the receiver of the first serve wins every point here, 7–0');
  assert.equal(s.last.winner, 'b');
  assert.deepEqual(s.last.score, { a: 0, b: WIN });
  assert.equal(s.last.how, 'score');
  assert.equal(s.game, null, 'Lee alone on the list: waiting for a second player (the players tap again)');
  assert.deepEqual(s.list, [LEE]);
  R.send(ROB, { t: 'list', on: true });
  s = R.same();
  assert.ok(s.game && s.game.a === LEE && s.game.b === ROB, 'the next two on the list play next');
  assert.equal(s.names[ROB], 'Rob', 'a name is remembered while someone is still around');
});

test('the loser of a point serves the next one', () => {
  const R = room(2);
  R.send(SAM, { t: 'list', on: true });
  R.send(ROB, { t: 'list', on: true });
  const g = R.copies[0].game.g;
  R.send(SAM, { t: 'serve', g, pt: 1, angle: 0 });
  const r = R.copies[0].game.rally;
  R.send(ROB, { t: 'miss', r: r.r, h: 0 });
  const s = R.same();
  assert.deepEqual(s.game.score, { a: 1, b: 0 });
  assert.equal(s.game.server, 'b', 'Rob lost the point, so Rob serves');
  assert.equal(s.game.pt, 2);
});

test('out-of-turn, stale and odd messages change nothing', () => {
  const R = room(2);
  R.send(SAM, { t: 'list', on: true });
  R.send(ROB, { t: 'list', on: true });
  const g = R.copies[0].game.g;
  R.send(SAM, { t: 'serve', g, pt: 1, angle: 0 });
  const before = JSON.stringify(R.copies[0]);
  const r = R.copies[0].game.rally;
  const ignored = (from, data) => assert.deepEqual(R.send(from, data), ['ignored', 'ignored'], JSON.stringify(data));
  ignored(SAM, { t: 'serve', g, pt: 1, angle: 0 });                      // a second serve mid-rally
  ignored(SAM, hitFrom(R.copies[0], ROB));                               // the server hitting the ball heading to Rob
  ignored(LEE, hitFrom(R.copies[0], ROB));                               // a watcher
  ignored(ROB, { ...hitFrom(R.copies[0], ROB), r: r.r + 1 });            // another rally
  ignored(ROB, { ...hitFrom(R.copies[0], ROB), h: 3 });                  // skipping hits
  ignored(ROB, { ...hitFrom(R.copies[0], ROB), seg: { s: 400, p: 250, vs: -300, vp: 0 } });   // not from the paddle
  ignored(ROB, { ...hitFrom(R.copies[0], ROB), seg: { s: planeOf('b'), p: 250, vs: 300, vp: 0 } }); // the wrong way
  ignored(ROB, { ...hitFrom(R.copies[0], ROB), seg: { s: planeOf('b'), p: 250, vs: -5000, vp: 0 } }); // too fast
  ignored(ROB, { ...hitFrom(R.copies[0], ROB), seg: { s: planeOf('b'), p: NaN, vs: -300, vp: 0 } });
  ignored(SAM, { t: 'miss', r: r.r, h: 0 });                             // the server can't miss for Rob
  ignored(ROB, { t: 'pause', g: g + 1 });
  ignored(LEE, { t: 'pause', g });
  ignored(ROB, { t: 'claim', g, backs: 1 });
  ignored(ROB, null);
  ignored(ROB, { t: 'nonsense' });
  assert.equal(JSON.stringify(R.copies[0]), before);
});

test('pause between points: the rally plays out, the next serve waits; either player resumes (P15)', () => {
  const R = room(2);
  R.send(SAM, { t: 'list', on: true });
  R.send(ROB, { t: 'list', on: true });
  const g = R.copies[0].game.g;
  R.send(SAM, { t: 'serve', g, pt: 1, angle: 0 });
  R.send(ROB, { t: 'pause', g });
  let s = R.same();
  assert.equal(s.game.pauseBy, ROB);
  assert.ok(s.game.rally, 'the rally goes on');
  R.send(ROB, { t: 'miss', r: s.game.rally.r, h: 0 });
  assert.deepEqual(R.send(ROB, { t: 'serve', g, pt: 2, angle: 0 }), ['ignored', 'ignored'], 'no serve while paused');
  R.send(SAM, { t: 'resume', g });
  s = R.same();
  assert.equal(s.game.pauseBy, null);
  assert.deepEqual(R.send(ROB, { t: 'serve', g, pt: 2, angle: 0 }), ['served', 'served']);
});

test('a vanished player: "back" replays the point; a claim after a back that the claimer hadn’t seen is refused (P6)', () => {
  const R = room(2);
  R.send(SAM, { t: 'list', on: true });
  R.send(ROB, { t: 'list', on: true });
  const g = R.copies[0].game.g;
  R.send(SAM, { t: 'serve', g, pt: 1, angle: 0 });
  // Rob's copy reloads mid-rally and comes back: the point is played again
  assert.deepEqual(R.send(ROB, { t: 'back', g, backs: 0 }), ['back', 'back']);
  assert.deepEqual(R.send(ROB, { t: 'back', g, backs: 0 }), ['ignored', 'ignored'], 'the same comeback never counts twice (a message sent again)');
  let s = R.same();
  assert.equal(s.game.rally, null);
  assert.equal(s.game.pt, 1);
  assert.equal(s.game.backs, 1);
  // the server serves the same point again
  assert.deepEqual(R.send(SAM, { t: 'serve', g, pt: 1, angle: 0.1 }), ['served', 'served']);
  // and "again" after a room pause replaces the rally in play
  assert.deepEqual(R.send(SAM, { t: 'serve', g, pt: 1, angle: -0.1, again: true }), ['served', 'served']);
  // Sam had counted Rob gone (seeing backs 0): his claim comes after Rob's back in the order: refused
  assert.deepEqual(R.send(SAM, { t: 'claim', g, backs: 0 }), ['ignored', 'ignored']);
  // Rob goes for good; Sam claims with what he knows: Sam wins by default
  assert.deepEqual(R.send(SAM, { t: 'claim', g, backs: 1 }), ['claimed', 'claimed']);
  s = R.same();
  assert.equal(s.game, null);
  assert.equal(s.last.winner, 'a');
  assert.equal(s.last.how, 'claim');
});

test('newcomers: a snapshot is checked, then the messages after it apply the same way', () => {
  const R = room(2);
  R.send(SAM, { t: 'list', on: true, name: 'Sam' });
  R.send(ROB, { t: 'list', on: true, name: 'Rob' });
  R.send(LEE, { t: 'list', on: true, name: 'Lee' });
  const g = R.copies[0].game.g;
  R.send(SAM, { t: 'serve', g, pt: 1, angle: 0.25 });
  const snap = snapshot(R.copies[0], R.n);
  const got = readSnapshot(JSON.parse(JSON.stringify(snap)));
  assert.ok(got);
  assert.equal(got.upto, R.n);
  const late = got.state;
  assert.deepEqual(late, R.copies[0]);
  // the newcomer applies what comes next exactly as the others do
  const st = R.copies[0];
  const msg = hitFrom(st, ROB);
  R.send(ROB, msg);
  apply(late, msg, ROB, R.n);
  assert.deepEqual(late, R.copies[0]);
  // broken snapshots are refused
  const bad = (f) => { const x = JSON.parse(JSON.stringify(snap)); f(x.s); assert.equal(readSnapshot(x), null); };
  bad((s) => { s.list = ['NOT AN ID']; });
  bad((s) => { s.game.score.a = 99; });
  bad((s) => { s.game.rally.seg.vs = 1e6; });
  bad((s) => { s.game.pauseBy = LEE; });
  bad((s) => { s.game.b = s.game.a; });
  assert.equal(readSnapshot({ t: 'state', upto: -1, s: {} }), null);
});

test('the court: the ball mirrors at the side walls; paddle lines; serves; returns; the finger cap (pong-physics.js)', () => {
  // mirroring stays on the court and is continuous
  for (let d = -3000; d <= 3000; d += 7) {
    const p = mirror(250, d);
    assert.ok(p >= BALL_R - 1e-9 && p <= COURT.width - BALL_R + 1e-9);
    assert.ok(Math.abs(mirror(250, d + 0.5) - p) <= 0.5 + 1e-9, 'no jumps');
  }
  assert.equal(mirror(250, 0), 250);
  assert.equal(mirror(480, 20), 484, 'bounces off the far wall (492)');
  assert.equal(wallHits(250, 0), 0);
  assert.equal(wallHits(250, 300), 1);
  assert.equal(wallHits(250, -300), 1);
  // the serve crosses the court toward the other side, from in front of the server
  const sa = serveSegment('a', 0.2), sb = serveSegment('b', -9);
  assert.equal(headingTo(sa), 'b');
  assert.equal(headingTo(sb), 'a');
  assert.ok(Math.abs(Math.hypot(sb.vs, sb.vp) - 320) < 1e-9, 'angle clamped, speed 320');
  // reaching the line exactly
  const t = timeToPlane(sa);
  assert.ok(Math.abs(ballAt(sa, t).s - planeOf('b')) < 1e-9);
  // a centred return comes straight back, a little faster; an edge hit angles it
  const at = ballAt(sa, t);
  const back = returnSegment(sa, 'b', at.p, at.p);
  assert.equal(headingTo(back), 'a');
  assert.ok(Math.abs(Math.hypot(back.vs, back.vp) - 320 * 1.05) < 1e-6);
  assert.equal(back.vp, 0);
  const edge = returnSegment(sa, 'b', at.p, at.p + 39);
  assert.ok(edge.vp > 100, 'an edge hit angles the ball');
  assert.ok(takes(250, 289) && !takes(250, 291));
  assert.ok(readSegment(back) && !readSegment({ ...back, vs: 10 }));
  // speed tops out
  let seg = sa;
  for (let i = 0; i < 40; i++) { const side = headingTo(seg); const a = ballAt(seg, timeToPlane(seg)); seg = returnSegment(seg, side, a.p, a.p); }
  assert.ok(Math.hypot(seg.vs, seg.vp) <= MAX_SPEED + 1e-6);
  // a finger moves the paddle no faster than the keys (P10)
  assert.equal(follow(100, 400, 0.1), 100 + PADDLE_SPEED * 0.1);
  assert.equal(follow(100, 120, 0.1), 120);
  assert.equal(follow(100, -50, 1), 40, 'kept on the court');
});
