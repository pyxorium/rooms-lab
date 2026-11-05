// pong-physics.js: the court and the ball, with no browser parts (tested in Node: test/pong-physics.test.mjs).
//
// The court is drawn from the Thunderbird Café Station's Pong (thunderbird.cafe's "Pong" tile): 800 long and
// 500 wide in its own units, paddles 80 long and 12 thick, 24 in from each end, a ball of radius 8; a serve
// at 320 a second, ×1.05 at every paddle hit up to 700, an edge hit angling the ball (offset × 0.7). One thing
// is done differently: the station stepped its ball 240 times a second so a fast ball couldn't skip through a
// paddle; here the ball's path between two events is worked out exactly (straight lines, mirrored at the
// side walls), so the moment it reaches a paddle's line is known exactly and nothing can skip.
//
// Positions: s runs along the court (0 at player A's end, 800 at B's); p across it (0 to 500, the walls).
// A segment is the ball's straight run from one event (a serve or a hit): { s, p, vs, vp }, speeds a second.

export const COURT = Object.freeze({ length: 800, width: 500 });
export const PADDLE = Object.freeze({ length: 80, thickness: 12, margin: 24 });
export const BALL_R = 8;
export const SERVE_SPEED = 320, SPEED_UP = 1.05, MAX_SPEED = 700;
export const PADDLE_SPEED = 500;          // keys move a paddle this fast; a finger may not go faster (P10)

/** Where a side's paddle meets the ball: the s at which the ball touches the paddle's face. */
export const planeOf = (side) => (side === 'a' ? PADDLE.margin + PADDLE.thickness / 2 + BALL_R : COURT.length - PADDLE.margin - PADDLE.thickness / 2 - BALL_R);
/** Past this, the ball is out (a little beyond the end, so a miss is seen to fly off). */
export const outOf = (side) => (side === 'a' ? -BALL_R * 3 : COURT.length + BALL_R * 3);
/** The side a segment is heading to. */
export const headingTo = (seg) => (seg.vs > 0 ? 'b' : 'a');

const LO = BALL_R, HI = COURT.width - BALL_R, SPAN = HI - LO;
/** p after moving freely from p0 by d, mirrored at the two side walls; and how many times it bounced. */
export function mirror(p0, d) {
  let x = (p0 - LO + d) % (2 * SPAN);
  if (x < 0) x += 2 * SPAN;
  return x <= SPAN ? LO + x : HI - (x - SPAN);
}
/** How many times the ball has touched a side wall after moving from p0 by d (for the wall's beep). */
export function wallHits(p0, d) { const x = p0 - LO + d; return x >= 0 ? Math.floor(x / SPAN) : Math.floor(-x / SPAN) + 1; }

/** The ball t seconds into a segment. */
export function ballAt(seg, t) { return { s: seg.s + seg.vs * t, p: mirror(seg.p, seg.vp * t) }; }
/** How long until the segment reaches the line of the side it's heading to. */
export function timeToPlane(seg) { const side = headingTo(seg); return (planeOf(side) - seg.s) / seg.vs; }
/** How long until it's out past that side's end. */
export function timeToOut(seg) { return (outOf(headingTo(seg)) - seg.s) / seg.vs; }

/** The serve: from just in front of the server's paddle, across the court. `angle` (−0.3 to 0.3) is the
 *  server's own random pick, sent with the serve so every copy draws the same ball. */
export function serveSegment(server, angle) {
  const a = Math.max(-0.3, Math.min(0.3, Number(angle) || 0));
  const start = PADDLE.margin + PADDLE.thickness + BALL_R * 4;
  const dir = server === 'a' ? 1 : -1;
  return { s: server === 'a' ? start : COURT.length - start, p: COURT.width / 2, vs: dir * SERVE_SPEED * Math.cos(a), vp: SERVE_SPEED * Math.sin(a) };
}

/** Does a paddle centred at `paddleP` take a ball crossing its line at `crossP`? */
export const takes = (paddleP, crossP) => Math.abs(crossP - paddleP) < PADDLE.length / 2;

/** The return: the station's rule. From where the ball met the paddle (crossP, on `side`'s line), how far off
 *  the paddle's centre it was sets the angle; the ball comes back a little faster. */
export function returnSegment(seg, side, paddleP, crossP) {
  const offset = Math.max(-1, Math.min(1, (crossP - paddleP) / (PADDLE.length / 2)));
  const speed = Math.min(Math.hypot(seg.vs, seg.vp) * SPEED_UP, MAX_SPEED);
  const angle = offset * 0.7;
  const dir = side === 'a' ? 1 : -1;
  return { s: planeOf(side), p: crossP, vs: dir * Math.abs(speed * Math.cos(angle)), vp: speed * Math.sin(angle) + offset * 40 };
}

/** A paddle's centre kept on the court. */
export const clampPaddle = (p) => Math.max(PADDLE.length / 2, Math.min(COURT.width - PADDLE.length / 2, p));

/** A paddle moving toward `target` (a finger) at no more than the keys' speed, over dt seconds (P10). */
export function follow(p, target, dt) {
  const step = PADDLE_SPEED * dt;
  const d = target - p;
  return clampPaddle(Math.abs(d) <= step ? target : p + Math.sign(d) * step);
}

/** A segment from someone's message, checked (finite numbers on the court, a sensible speed); null if not. */
export function readSegment(x) {
  if (!x || typeof x !== 'object') return null;
  const { s, p, vs, vp } = x;
  if (![s, p, vs, vp].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  if (s < 0 || s > COURT.length || p < 0 || p > COURT.width) return null;
  const speed = Math.hypot(vs, vp);
  if (Math.abs(vs) < 50 || speed > MAX_SPEED * 1.2) return null;
  return { s, p, vs, vp };
}

/** The computer's paddle (alone only), the station's three presets: how often it looks at the ball, and how
 *  fast it can move (a share of the court's width a second). */
export const BOT = Object.freeze({
  easy: Object.freeze({ lag: 0.45, speedFraction: 0.15 }),
  medium: Object.freeze({ lag: 0.25, speedFraction: 0.30 }),
  hard: Object.freeze({ lag: 0.12, speedFraction: 0.46 }),
});
