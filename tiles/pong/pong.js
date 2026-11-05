// pong.js: Live Pong (rooms-pong-plan.md, P1 to P22). Two-player Pong for a room, built to measure how fast
// live tiles are. Shared live, everyone sees the same game; anyone taps "I'd like to play" and the first two
// on the list play, first to 7. Alone (Raku, a gallery, a room before it's shared live), you play the computer.
//
// How it stays in step (no referee copy, P4): every copy applies the same messages in the room's one order
// (pong-state.js). The ball travels as events, not a stream (P2): a serve, then each hit says where the ball
// goes from the paddle, and every copy draws the straight runs and wall bounces in between (pong-physics.js).
// The receiving player's own copy calls its hit or miss (P3), where its paddle really is. A segment starts on
// each screen when its message arrives there, so the next player always gets the ball's whole run to react;
// on the other screens the ball waits at that player's paddle until their copy says "hit" or "miss" (P17):
// that short "stick" is the round trip between the two players, the plainest sign of how fast the room is.
// The only steady stream is each player's own paddle (P2), at most 10 a second by default, drawn on the other
// screens one update behind (P18). Your own paddle moves at once on your screen.
import { joinLive } from './live-talk.js';
import { emptyState, apply, snapshot, readSnapshot, sideOf, idOfSide, nameOf, cleanName, WIN, MAX_NAME } from './pong-state.js';
import {
  COURT, PADDLE, BALL_R, planeOf, ballAt, timeToPlane, timeToOut, returnSegment, takes, clampPaddle, follow, headingTo,
  wallHits, PADDLE_SPEED, BOT,
} from './pong-physics.js';

// ---- Settings (this copy's own) ----
const THEMES = { green: { fg: '#4dff88', ball: '#eaffea' }, white: { fg: '#e8e8e8', ball: '#ffffff' }, amber: { fg: '#ffb000', ball: '#ffe0a0' } };
const settings = { theme: 'green', crt: true, sound: true, bot: 'medium', rate: 10 };
const RATES = [5, 10, 15, 20];
const SERVE_WAIT = 1000, FIRST_SERVE_WAIT = 3000, GONE_MS = 15000, SYNC_WAIT_MS = 2000, RESULT_MS = 5000;
const BOT_ID = 'computer';

// ---- What this copy knows ----
let you = null, here = [], roomPaused = false;
let mode = 'waiting';            // 'alone' (playing the computer), 'live' (shared live with others), 'waiting'
let state = emptyState();
let lastN = 0, aloneN = 0;
let synced = false, syncBuffer = [], syncTimer = null;
let notice = '', noticeTimer = null;
let wantName = false;            // the name box is open
let lastName = '';               // what you typed last (this visit only)

const $ = (s) => document.querySelector(s);
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
const nowMs = () => performance.now();
function tell(text) { notice = text; clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice = ''; drawBar(); }, 6000); drawBar(); }

// ---- Numbers for the speed readout (P11, P20) ----
const stats = {
  rtts: [], sentTimes: new Map(), k: 0,           // round trips (ms) of your own messages coming back
  arrive: [],                                       // when other players' paddle updates arrived (ms)
  sent: [],                                         // when this copy sent a paddle update (ms)
  heldBack: 0, limits: { rate: 0, room: 0, other: 0 }, limitAt: -1e9,
  gameMsgs: 0, gameG: null,
};
const recent = (arr, ms) => { const t = nowMs() - ms; while (arr.length && arr[0] < t) arr.shift(); return arr.length; };
function rttSummary() {
  const r = stats.rtts.slice(-20);
  if (!r.length) return null;
  const sorted = [...r].sort((a, b) => a - b);
  return { typical: Math.round(sorted[Math.floor(sorted.length / 2)]), worst: Math.round(sorted[sorted.length - 1]), n: r.length };
}
// A copy of the room's per-copy limit (10 a second, bursts of 30), kept by this copy so the paddle stream
// always leaves room for the game's own messages (a hit must never be refused for a paddle update).
const bucket = (() => { let tokens = 30, at = nowMs(); return { take(reserve) { const t = nowMs(); tokens = Math.min(30, tokens + ((t - at) / 1000) * 9.5); at = t; if (tokens - 1 < reserve) return false; tokens -= 1; return true; }, spend() { this.take(-1e9); } }; })();

// ---- Sending ----
// Game messages are sent again until they come back in the room's order (a message can be refused by the
// room's limits or lost when the host's page reloads); applying one twice changes nothing.
const pending = new Map();      // JSON text → { data, at, tries }
function emit(data) {
  if (mode === 'alone') { aloneN += 1; onApplied(aloneN, you, data); return; }
  if (mode !== 'live' || !synced) return;
  const text = JSON.stringify(data);
  if (!['pad', 'ping', 'state'].includes(data.t)) pending.set(text, { data, at: nowMs(), tries: 1 });
  bucket.spend();
  live.send(data);
}
function retryPending() {
  const r = rttSummary();
  const wait = Math.max(700, (r ? r.worst : 300) * 3);
  for (const [text, p] of pending) {
    if (nowMs() - p.at < wait) continue;
    if (p.tries >= 8) { pending.delete(text); continue; }
    p.at = nowMs(); p.tries += 1;
    bucket.spend();
    live.send(p.data);
  }
}
// "Emit as" someone else: alone only (your moves and the computer's, applied at once on this page).
function emitAs(from, data) { aloneN += 1; onApplied(aloneN, from, data); }

// ---- The room (live-talk.js) ----
const live = joinLive({
  onPresence(p) {
    you = p.you; here = p.here;
    if (here.length > 1) {
      if (mode !== 'live') startLive();
      else if (synced) {
        if (p.joined.some((id) => id !== you)) live.send(snapshot(state, lastN));           // catch newcomers up
        if (p.joined.includes(you) && sideOf(state.game, you)) emit({ t: 'back', g: state.game.g, backs: state.game.backs });
      }
    } else if (mode !== 'alone') startAlone();
    draw(); drawBar();
  },
  onMessage({ n, from, data }) {
    if (mode !== 'live') return;
    if (!synced) {
      if (data && data.t === 'state') {
        const snap = readSnapshot(data);
        if (snap) {
          state = snap.state; lastN = snap.upto;
          for (const m of syncBuffer) if (m.n > snap.upto) onApplied(m.n, m.from, m.data);
          finishSync();
        }
        return;
      }
      syncBuffer.push({ n, from, data });
      return;
    }
    onApplied(n, from, data);
  },
  onPaused() { roomPaused = true; ball.freeze(); drawBar(); },
  onResumed() {
    roomPaused = false; ball.thaw();
    // The host's page may have reloaded: its numbering starts again, so this copy has applied nothing of the new
    // count yet (a snapshot it sends now says so, and a newcomer then replays everything it heard).
    lastN = 0;
    // the rally in play when the room paused is played again (P15), served by its server
    const g = state.game;
    if (synced && g?.rally && idOfSide(g, g.server) === you) setTimeout(() => { if (state.game?.rally) emit({ t: 'serve', g: g.g, pt: g.pt, angle: angle(), again: true }); }, 800);
    drawBar();
  },
  onLimit(reason) {
    stats.limitAt = nowMs();
    if (reason === 'rate' || reason === 'room') stats.limits[reason] += 1; else stats.limits.other += 1;
    for (const p of pending.values()) p.at = Math.min(p.at, nowMs() - 400);   // try the game's messages again soon
    drawGauge();
  },
});

function startLive() {
  mode = 'live'; synced = false; syncBuffer = []; pending.clear();
  state = emptyState(); lastN = 0; resetLocal();
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { state = emptyState(); for (const m of syncBuffer) onApplied(m.n, m.from, m.data); finishSync(); }, SYNC_WAIT_MS);
}
function finishSync() {
  clearTimeout(syncTimer); syncTimer = null; syncBuffer = []; synced = true;
  if (sideOf(state.game, you)) emit({ t: 'back', g: state.game.g, backs: state.game.backs });     // a player coming back after a reload
  drawBar();
}
function startAlone() {
  mode = 'alone'; synced = false; pending.clear(); clearTimeout(syncTimer);
  state = emptyState(); aloneN = 0; resetLocal();
}

// ---- Applying a message (live or alone) ----
let lastResult = null;           // { last, at }: the result shown for a few seconds after a game
let rallyAt = null;              // when the rally's latest segment arrived here (the ball's clock)
function onApplied(n, from, data) {
  if (!data || typeof data !== 'object') return;
  if (mode === 'live') lastN = n;
  if (from === you && mode === 'live') {
    pending.delete(JSON.stringify(data));
    if ((data.t === 'pad' || data.t === 'ping') && stats.sentTimes.has(data.k)) {
      stats.rtts.push(nowMs() - stats.sentTimes.get(data.k)); stats.sentTimes.delete(data.k);
      if (stats.rtts.length > 100) stats.rtts.splice(0, 50);
    }
  }
  if (state.game && stats.gameG === state.game.g) stats.gameMsgs += 1;
  if (data.t === 'pad') {
    if (from !== you && state.game && data.g === state.game.g && typeof data.p === 'number' && Number.isFinite(data.p)) {
      pads.add(from, clampPaddle(data.p));
      stats.arrive.push(nowMs());
    }
    return;
  }
  if (data.t === 'ping' || data.t === 'state') return;
  const before = state.game?.g ?? null;
  const what = apply(state, data, from, n);
  if (what === 'served' || what === 'hit') rallyAt = ball.now();     // the ball sets off on this screen now
  if (what === 'hit' && from !== you && mode === 'live') beep(220, 0.08);     // (your own hits, and all hits alone, beep as they happen)
  if (what === 'point' || what === 'won' || what === 'claimed') { beep(90, 0.25); ball.out(); }
  if (what === 'won' || what === 'claimed') lastResult = { last: state.last, at: nowMs() };
  if ((state.game?.g ?? null) !== before) { newGame(); }
  if (what === 'listed' && from === you) { wantName = false; }
  drawBar();
}

function newGame() {
  stats.gameG = state.game?.g ?? null; stats.gameMsgs = 0;
  pads.clear(); myPaddle.p = myPaddle.prev = COURT.width / 2; botPaddle.p = botPaddle.prev = COURT.width / 2;
  serveAt = null; goneSince = null; claimed = false;
}

// ---- Paddles ----
const myPaddle = { p: COURT.width / 2, prev: COURT.width / 2, keys: new Map(), touch: null };   // keys: key → direction
const botPaddle = { p: COURT.width / 2, prev: COURT.width / 2, target: COURT.width / 2, lookedAt: 0 };
// Other players' paddles: the updates as they arrived, drawn one update behind (P18).
const pads = {
  byId: new Map(),
  add(id, p) { const a = this.byId.get(id) || []; a.push({ t: nowMs(), p }); if (a.length > 12) a.shift(); this.byId.set(id, a); },
  clear() { this.byId.clear(); },
  at(id) {
    const a = this.byId.get(id);
    if (!a || !a.length) return COURT.width / 2;
    if (a.length === 1) return a[0].p;
    const gaps = []; for (let i = 1; i < a.length; i++) gaps.push(a[i].t - a[i - 1].t);
    const behind = Math.max(50, Math.min(250, gaps.reduce((x, y) => x + y, 0) / gaps.length));
    const t = nowMs() - behind;
    if (t >= a[a.length - 1].t) return a[a.length - 1].p;
    if (t <= a[0].t) return a[0].p;
    for (let i = a.length - 1; i > 0; i--) {
      if (a[i - 1].t <= t) { const f = (t - a[i - 1].t) / (a[i].t - a[i - 1].t || 1); return a[i - 1].p + (a[i].p - a[i - 1].p) * f; }
    }
    return a[a.length - 1].p;
  },
};
// Sent on an even schedule (the rate on average, even when the screen's frames don't line up with it), and only
// when the paddle has moved.
let padNext = 0, padLastP = null;
function sendPaddle() {
  const g = state.game;
  if (mode !== 'live' || !synced || !g || !sideOf(g, you)) return;
  const gap = 1000 / settings.rate;
  if (nowMs() < padNext) return;
  if (padLastP !== null && Math.abs(myPaddle.p - padLastP) < 0.5) return;
  padNext = Math.max(padNext + gap, nowMs() - gap / 2);
  if (!bucket.take(4)) { stats.heldBack += 1; return; }
  padLastP = myPaddle.p;
  const k = ++stats.k;
  stats.sentTimes.set(k, nowMs());
  if (stats.sentTimes.size > 200) stats.sentTimes.delete(stats.sentTimes.keys().next().value);
  stats.sent.push(nowMs());
  live.send({ t: 'pad', g: g.g, p: Math.round(myPaddle.p * 10) / 10, k });
}
let pingAt = 0;
function sendPing() {
  if (mode !== 'live' || !synced || $('#gauge').hidden || nowMs() - pingAt < 2000) return;
  pingAt = nowMs();
  if (!bucket.take(6)) return;
  const k = ++stats.k;
  stats.sentTimes.set(k, nowMs());
  live.send({ t: 'ping', k });
}

// ---- The ball as this screen draws it ----
// A segment starts when its message arrives here (or, for your own hit, the moment you hit it). The clock
// stops while the room is paused.
const ball = {
  key: null, seg: null, t0: 0, decided: false, fly: null, frozenAt: null, pausedFor: 0, lastWalls: 0, lastT: 0,
  now() { return ((this.frozenAt ?? nowMs()) - this.pausedFor) / 1000; },
  freeze() { if (this.frozenAt === null) this.frozenAt = nowMs(); },
  thaw() { if (this.frozenAt !== null) { this.pausedFor += nowMs() - this.frozenAt; this.frozenAt = null; } },
  localR: null, localH: null,
  start(key, seg, t0 = this.now(), local = null) { this.key = key; this.seg = seg; this.t0 = t0; this.decided = false; this.fly = null; this.lastWalls = 0; this.lastT = 0; this.localR = local ? local.r : null; this.localH = local ? local.h : null; },
  // The point is over: the ball flies on from where it is (or from the paddle line it waited at).
  out() {
    if (!this.seg) return;
    const t = Math.min(this.now() - this.t0, controls(headingTo(this.seg)) ? Infinity : timeToPlane(this.seg));
    this.fly = { seg: this.seg, t0: this.now() - t };
    this.key = null; this.seg = null;
  },
};
const rallyKey = (r) => `${r.r}:${r.hits}`;

// Which sides this copy moves: alone, both (you and the computer); live, yours if you're playing.
function controls(side) {
  const g = state.game;
  if (!g) return false;
  if (mode === 'alone') return true;
  return mode === 'live' && synced && idOfSide(g, side) === you;
}
const paddleOf = (side) => {
  const g = state.game;
  if (!g) return COURT.width / 2;
  const id = idOfSide(g, side);
  if (id === you) return myPaddle.p;
  if (mode === 'alone' && id === BOT_ID) return botPaddle.p;
  return pads.at(id);
};
const prevPaddleOf = (side) => { const id = idOfSide(state.game, side); return id === you ? myPaddle.prev : id === BOT_ID ? botPaddle.prev : paddleOf(side); };
const angle = () => (Math.random() * 0.6 - 0.3);

let serveAt = null, goneSince = null, claimed = false;
function step(dt) {
  const g = state.game;
  // your paddle: keys, or a finger (no faster than the keys, P10)
  myPaddle.prev = myPaddle.p;
  botPaddle.prev = botPaddle.p;
  if (!roomPaused) {
    let dir = 0;
    for (const k of myPaddle.keys.values()) dir += k;
    if (dir) myPaddle.p = clampPaddle(myPaddle.p + Math.sign(dir) * PADDLE_SPEED * dt);
    else if (myPaddle.touch !== null) myPaddle.p = follow(myPaddle.p, myPaddle.touch, dt);
    if (window.__pong.autopilot && sideOf(g, you)) autopilot(dt);
  }
  sendPaddle();
  sendPing();
  if (mode === 'live') retryPending();
  if (!g) { ball.key = null; ball.seg = null; return; }

  // the rally as the room knows it
  const r = g.rally;
  // (your own hit goes on at once on your screen: the room's rally catches up when the hit comes back)
  const ahead = ball.localR === r?.r && ball.localH > (r?.hits ?? Infinity);
  if (r && rallyKey(r) !== ball.key && !ahead) ball.start(rallyKey(r), r.seg, rallyAt ?? ball.now());
  if (!r && ball.seg) ball.out();
  if (mode === 'alone' && !roomPaused) bot(dt);

  if (r && ball.seg && !roomPaused) {
    const t = ball.now() - ball.t0;
    const tp = timeToPlane(ball.seg);
    const side = headingTo(ball.seg);
    if (controls(side) && !ball.decided && t >= tp) {
      // this copy's call (P3): where was the paddle when the ball reached its line?
      ball.decided = true;
      const frac = dt > 0 ? Math.max(0, Math.min(1, 1 - (t - tp) / dt)) : 1;
      const paddleP = prevPaddleOf(side) + (paddleOf(side) - prevPaddleOf(side)) * frac;
      const crossP = ballAt(ball.seg, tp).p;
      const from = idOfSide(g, side);
      if (takes(paddleP, crossP)) {
        const seg = returnSegment(ball.seg, side, paddleP, crossP);
        const msg = { t: 'hit', r: r.r, h: r.hits + 1, seg: { s: seg.s, p: round3(seg.p), vs: round3(seg.vs), vp: round3(seg.vp) } };
        ball.start(`${r.r}:${r.hits + 1}`, msg.seg, ball.t0 + tp, { r: r.r, h: r.hits + 1 });     // carry on at once on this screen
        beep(220, 0.08);
        if (from === you) emit(msg); else emitAs(from, msg);
      } else if (from === you) emit({ t: 'miss', r: r.r, h: r.hits });
      else emitAs(from, { t: 'miss', r: r.r, h: r.hits });
    }
  }

  // serving: the server's copy, after a short wait (P9); never while paused (P15) or the room is paused
  const serverSide = g.server;
  const canServe = controls(serverSide) && !g.rally && !g.pauseBy && !roomPaused && (mode === 'alone' || here.includes(idOfSide(g, serverSide === 'a' ? 'b' : 'a')));
  if (!canServe) serveAt = null;
  else {
    if (serveAt === null) serveAt = nowMs() + (g.pt === 1 && g.score.a + g.score.b === 0 ? FIRST_SERVE_WAIT : SERVE_WAIT);
    if (nowMs() >= serveAt) {
      serveAt = nowMs() + 2000;     // (sent again only if it didn't take)
      const msg = { t: 'serve', g: g.g, pt: g.pt, angle: round3(angle()) };
      if (idOfSide(g, serverSide) === you) emit(msg); else emitAs(BOT_ID, msg);
    }
  }

  // someone gone (P6): the player who stayed claims the game after ~15 s
  if (mode === 'live' && synced) {
    const mine = sideOf(g, you);
    const opp = mine ? idOfSide(g, mine === 'a' ? 'b' : 'a') : null;
    if (opp && !here.includes(opp) && !roomPaused) {
      goneSince ??= nowMs();
      if (!claimed && nowMs() - goneSince >= GONE_MS) { claimed = true; emit({ t: 'claim', g: g.g, backs: g.backs }); }
    } else { goneSince = null; claimed = false; }
  }
}
const round3 = (x) => Math.round(x * 1000) / 1000;

// people on the list who left the room: off the list after ~15 s (sent by one copy: the first id here)
const absentSince = new Map();
function tidyList() {
  if (mode !== 'live' || !synced || roomPaused) return;
  for (const id of state.list) {
    if (here.includes(id)) { absentSince.delete(id); continue; }
    if (!absentSince.has(id)) absentSince.set(id, nowMs());
    if (nowMs() - absentSince.get(id) >= GONE_MS && [...here].sort()[0] === you) { absentSince.set(id, nowMs()); emit({ t: 'gone', id }); }
  }
}
setInterval(tidyList, 1000);

// The computer's paddle (alone): the station's CPU, looking at the ball every so often, moving at its speed.
function bot(dt) {
  const preset = BOT[settings.bot] || BOT.medium;
  const now = ball.now();
  const b = drawnBall();
  if (now - botPaddle.lookedAt > preset.lag) { botPaddle.target = b ? b.p : COURT.width / 2; botPaddle.lookedAt = now; }
  const max = preset.speedFraction * COURT.width * dt;
  const d = botPaddle.target - botPaddle.p;
  botPaddle.p = clampPaddle(Math.abs(d) <= max ? botPaddle.target : botPaddle.p + Math.sign(d) * max);
}
// For the checks: a player's copy can play itself (window.__pong.autopilot = "good", "busy" or "miss"). It
// meets the ball a little off the paddle's centre (a new aim for each run of the ball), as a person would;
// "busy" also never keeps still (a paddle stream running flat out); "miss" keeps away from the ball.
let aim = { key: null, off: 0 };
function autopilot(dt) {
  const b = drawnBall();
  const how = window.__pong.autopilot;
  if (ball.key !== aim.key) aim = { key: ball.key, off: (Math.random() * 2 - 1) * 28 };
  const wiggle = how === 'busy' ? Math.sin(nowMs() / 60) * 14 : 0;
  const target = how === 'miss' ? (b && b.p > COURT.width / 2 ? 60 : COURT.width - 60) : (b ? b.p - aim.off : COURT.width / 2) + wiggle;
  myPaddle.p = follow(myPaddle.p, target, dt);
}

// Where the ball is drawn now (null: no ball).
function drawnBall() {
  if (ball.seg) {
    const t = ball.now() - ball.t0;
    const side = headingTo(ball.seg);
    // on others' screens the ball waits at the receiver's line for their call (P17)
    if (controls(side) && t > timeToOut(ball.seg)) return null;          // your miss: gone off the court
    const tt = controls(side) ? t : Math.min(t, timeToPlane(ball.seg));
    return { ...ballAt(ball.seg, Math.max(0, tt)), t: tt, seg: ball.seg };
  }
  if (ball.fly) {
    const t = ball.now() - ball.fly.t0;
    if (t > timeToOut(ball.fly.seg) + 0.15) { ball.fly = null; return null; }
    return { ...ballAt(ball.fly.seg, t), t, seg: ball.fly.seg };
  }
  return null;
}

// ---- Sound (the station's square-wave beeps) ----
let audio = null;
function unlockAudio() { try { audio ??= new AudioContext(); if (audio.state === 'suspended') audio.resume(); } catch { /* no sound */ } }
function beep(freq, dur) {
  if (!settings.sound || !audio) return;
  try {
    const o = audio.createOscillator(), gn = audio.createGain();
    o.type = 'square'; o.frequency.value = freq;
    gn.gain.setValueAtTime(0.15, audio.currentTime);
    gn.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + dur);
    o.connect(gn); gn.connect(audio.destination); o.start(); o.stop(audio.currentTime + dur);
  } catch { /* no sound */ }
}

// ---- The court on this screen ----
// Players see themselves on their own side (P16): on the left, or at the bottom when the tile is taller than
// wide (a phone held upright). Watchers see A on the left (or at the bottom).
const canvas = $('#court');
const ctx = canvas.getContext('2d');
function view() {
  const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
  const portrait = h > w * 1.15;
  const me = sideOf(state.game, you) === 'b' && mode === 'live' ? 'b' : 'a';
  const W = portrait ? COURT.width : COURT.length, H = portrait ? COURT.length : COURT.width;
  const scale = Math.min(w / W, h / H);
  return { portrait, me, W, H, scale, ox: (w - W * scale) / 2, oy: (h - H * scale) / 2 };
}
// court (s, p) → canvas units (before scaling)
function toView(v, s, p) {
  if (!v.portrait) return v.me === 'a' ? { x: s, y: p } : { x: COURT.length - s, y: p };
  return v.me === 'a' ? { x: p, y: COURT.length - s } : { x: COURT.width - p, y: s };
}
// a screen point → the court's p (for a finger)
function pFromScreen(v, cx, cy) {
  const x = (cx - v.ox) / v.scale, y = (cy - v.oy) / v.scale;
  if (!v.portrait) return y;
  return v.me === 'a' ? x : COURT.width - x;
}
// arrow keys → which way along p (landscape: up and down; upright: left and right)
function keyDir(v, key) {
  const k = key.toLowerCase();
  if (!v.portrait) return k === 'arrowup' || k === 'w' ? -1 : k === 'arrowdown' || k === 's' ? 1 : 0;
  const d = k === 'arrowleft' || k === 'a' ? -1 : k === 'arrowright' || k === 'd' ? 1 : 0;
  return v.me === 'a' ? d : -d;
}

function draw() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const v = view();
  const theme = THEMES[settings.theme];
  const blur = settings.crt ? 16 : 0;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
  ctx.setTransform(v.scale * dpr, 0, 0, v.scale * dpr, v.ox * dpr, v.oy * dpr);
  // the court's edge, faint (on a wide or tall card the court sits in the middle, with black around it)
  ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, v.W - 2, v.H - 2);
  // the net
  ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.lineWidth = 3; ctx.setLineDash([10, 14]);
  ctx.beginPath();
  const n1 = toView(v, COURT.length / 2, 0), n2 = toView(v, COURT.length / 2, COURT.width);
  ctx.moveTo(n1.x, n1.y); ctx.lineTo(n2.x, n2.y); ctx.stroke(); ctx.setLineDash([]);
  const g = state.game;
  const glow = (f) => { ctx.save(); if (blur) { ctx.shadowColor = theme.fg; ctx.shadowBlur = blur; } f(); ctx.restore(); };
  // the paddles
  const paddle = (side, p) => {
    const s = side === 'a' ? PADDLE.margin : COURT.length - PADDLE.margin;
    const c1 = toView(v, s - PADDLE.thickness / 2, p - PADDLE.length / 2), c2 = toView(v, s + PADDLE.thickness / 2, p + PADDLE.length / 2);
    glow(() => { ctx.fillStyle = theme.fg; ctx.fillRect(Math.min(c1.x, c2.x), Math.min(c1.y, c2.y), Math.abs(c2.x - c1.x), Math.abs(c2.y - c1.y)); });
  };
  if (g) { paddle('a', paddleOf('a')); paddle('b', paddleOf('b')); }
  else if (mode === 'alone') { paddle('a', myPaddle.p); paddle('b', botPaddle.p); }
  // the ball
  const b = drawnBall();
  if (b) {
    const w = wallHits(b.seg.p, b.seg.vp * b.t);
    if (w > ball.lastWalls && b.seg === ball.seg) beep(150, 0.06);
    if (b.seg === ball.seg) ball.lastWalls = w;
    const at = toView(v, b.s, b.p);
    ctx.save(); if (blur) { ctx.shadowColor = theme.ball; ctx.shadowBlur = 20; }
    ctx.fillStyle = theme.ball; ctx.beginPath(); ctx.arc(at.x, at.y, BALL_R, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  // scores and names, at each player's end
  ctx.textAlign = 'center';
  const score = (side, value, name) => {
    const s = side === 'a' ? COURT.length * 0.25 : COURT.length * 0.75;
    const at = v.portrait ? toView(v, s, 60) : toView(v, s, 0);
    const y = v.portrait ? at.y : 54;
    glow(() => { ctx.fillStyle = theme.ball; ctx.font = "48px 'Courier New', monospace"; ctx.fillText(String(value), at.x, y); });
    if (name) { ctx.fillStyle = theme.fg; ctx.font = "16px 'Courier New', monospace"; ctx.fillText(name, at.x, y + 24); }
  };
  if (g) {
    score('a', g.score.a, label(g.a)); score('b', g.score.b, label(g.b));
  }
  // the message in the middle
  const msg = centerText();
  if (msg) {
    const mid = { x: v.W / 2, y: v.H / 2 };
    glow(() => {
      ctx.fillStyle = theme.ball; ctx.font = `${msg.big ? 30 : 20}px 'Courier New', monospace`;
      wrap(msg.text, mid.x, mid.y - (msg.small ? 14 : 0), v.W - 60, msg.big ? 34 : 24);
    });
    if (msg.small) { ctx.fillStyle = theme.fg; ctx.font = "15px 'Courier New', monospace"; wrap(msg.small, mid.x, mid.y + 30, v.W - 60, 19); }
  }
  // the keys hint, until the court has them (P10)
  if (playing() && !document.hasFocus() && !touchSeen) {
    ctx.fillStyle = theme.fg; ctx.font = "15px 'Courier New', monospace";
    ctx.fillText(v.portrait ? 'Click here, then use ← → (or A/D)' : 'Click here, then use ↑ ↓ (or W/S)', v.W / 2, v.H - 18);
  }
}
function wrap(text, x, y, max, lh) {
  const words = String(text).split(' ');
  const lines = []; let cur = '';
  for (const w of words) { const t = cur ? `${cur} ${w}` : w; if (ctx.measureText(t).width > max && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur);
  lines.forEach((l, i) => ctx.fillText(l, x, y + (i - (lines.length - 1) / 2) * lh));
}
const label = (id) => (id === you ? `${mode === 'alone' ? 'You' : `${nameOf(state, id)} (you)`}` : id === BOT_ID ? 'Computer' : nameOf(state, id));
const playing = () => !!sideOf(state.game, you);

function centerText() {
  const g = state.game;
  if (mode === 'live' && !synced) return { text: 'Joining the game…' };
  if (roomPaused) return { text: 'Paused', small: 'waiting for the room to come back', big: true };
  if (lastResult && nowMs() - lastResult.at < RESULT_MS && !g?.rally) {
    const l = lastResult.last;
    const w = l.winner === 'a' ? l.a : l.b;
    const who = w === you ? (mode === 'alone' ? 'You win' : 'You win') : w === BOT_ID ? 'The computer wins' : `${nameOf(state, w)} wins`;
    const sc = `${Math.max(l.score.a, l.score.b)}–${Math.min(l.score.a, l.score.b)}`;
    return { text: l.how === 'claim' ? `${who} by default` : `${who} ${sc}`, small: g ? `Next: ${label(g.a)} vs ${label(g.b)}` : '', big: true };
  }
  if (!g) {
    if (mode === 'alone') return { text: 'Live Pong', small: 'Press space or tap Play to play the computer. Shared live in a room, everyone plays together.', big: true };
    if (state.list.length === 1) return { text: 'Waiting for a second player', small: `${label(state.list[0])} is ready` };
    return { text: 'Live Pong', small: 'Tap “I’d like to play”: the first two on the list play, first to 7.', big: true };
  }
  if (mode === 'live') {
    const mine = sideOf(g, you);
    const opp = mine ? idOfSide(g, mine === 'a' ? 'b' : 'a') : null;
    if (opp && goneSince !== null) return { text: `Waiting for ${nameOf(state, opp)} to come back…`, small: `${Math.max(0, Math.ceil((GONE_MS - (nowMs() - goneSince)) / 1000))}` };
  }
  if (g.pauseBy && !g.rally) return { text: `Paused by ${label(g.pauseBy)}`, small: 'either player can resume' };
  if (!g.rally) {
    const server = idOfSide(g, g.server);
    return { text: server === you ? 'Your serve' : `${label(server)} serves` };
  }
  return null;
}

// ---- The bar under the court: the list, your button, the notes ----
function drawBar() {
  const g = state.game;
  // status line (top)
  const st = $('#status');
  st.dataset.state = roomPaused ? 'paused' : mode === 'live' ? 'live' : 'alone';
  st.textContent = roomPaused ? 'Paused: waiting for the room to come back'
    : mode === 'live' ? `Live · ${here.length} here`
      : 'Just you, playing the computer';
  document.documentElement.dataset.live = mode === 'live' ? 'live' : 'alone';
  // the pause button (players, between points: P15)
  const pb = $('#pauseBtn');
  const mine = sideOf(g, you);
  pb.hidden = !(mode === 'live' && synced && mine);
  if (!pb.hidden) {
    pb.textContent = g.pauseBy ? 'Resume' : 'Pause';
    pb.title = g.pauseBy ? 'Resume (P)' : 'Pause after this point (P)';
    pb.disabled = roomPaused;
  }
  // the line
  const line = $('#line');
  const actions = $('#actions');
  const parts = [];
  if (mode === 'live') {
    if (g) parts.push(`Playing: ${label(g.a)} vs ${label(g.b)}${g.pauseBy && g.rally ? ' · pausing after this point' : ''}`);
    const next = state.list.map(label);
    parts.push(next.length ? `Next: ${next.join(', ')}` : g ? 'Nobody else on the list' : 'Nobody on the list yet');
    const watching = here.length - state.list.filter((id) => here.includes(id)).length - (g ? [g.a, g.b].filter((id) => here.includes(id)).length : 0);
    if (watching > 0) parts.push(`${watching} watching`);
  } else parts.push(g ? 'You vs the computer · first to 7' : 'You vs the computer');
  line.textContent = parts.join(' · ');
  // the buttons (rebuilt only when what they show changes, so a click is never lost under the pointer)
  const key = JSON.stringify([mode, synced, !!g, mine, state.list.includes(you), wantName, settings.bot]);
  if (actions.dataset.key !== key) {
    actions.dataset.key = key;
    actions.replaceChildren(...buttons());
  }
  $('#notice').textContent = notice;
  drawGauge();
}
function buttons() {
  const g = state.game;
  if (mode === 'alone') {
    if (g) return [];
    return [el('button', { type: 'button', class: 'primary', id: 'playBtn', onclick: playAlone }, state.last ? 'Play again' : 'Play')];
  }
  if (mode !== 'live' || !synced) return [];
  if (sideOf(g, you)) return [];
  if (state.list.includes(you)) return [el('button', { type: 'button', id: 'leaveBtn', onclick: () => emit({ t: 'list', on: false }) }, 'Leave the list')];
  if (!wantName) return [el('button', { type: 'button', class: 'primary', id: 'playBtn', onclick: () => { wantName = true; drawBar(); setTimeout(() => $('#nameBox')?.focus(), 0); } }, 'I’d like to play')];
  const box = el('input', { type: 'text', id: 'nameBox', maxlength: MAX_NAME, placeholder: 'Your name (or leave blank)', 'aria-label': 'Your name', value: lastName });
  const go = () => { lastName = cleanName(box.value); emit({ t: 'list', on: true, name: lastName }); };
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') { wantName = false; drawBar(); } });
  return [box, el('button', { type: 'button', class: 'primary', id: 'joinBtn', onclick: go }, 'Join the list'), el('button', { type: 'button', onclick: () => { wantName = false; drawBar(); } }, 'Cancel')];
}
function playAlone() {
  if (mode !== 'alone' || state.game) return;
  unlockAudio();
  lastResult = null;
  emitAs(you, { t: 'list', on: true, name: 'You' });
  emitAs(BOT_ID, { t: 'list', on: true, name: 'Computer' });
  canvas.focus();
}
function togglePause() {
  const g = state.game;
  if (mode !== 'live' || !sideOf(g, you) || roomPaused) return;
  emit({ t: g.pauseBy ? 'resume' : 'pause', g: g.g });
}

// ---- The speed readout (P11) and settings ----
function numbers() {
  const r = rttSummary();
  const arriving = recent(stats.arrive, 2000) / 2, sent = recent(stats.sent, 2000) / 2;
  const role = mode === 'alone' ? 'alone (playing the computer)' : playing() ? 'playing' : 'watching';
  return {
    role, here: mode === 'live' ? here.length : 1,
    rtt: r, arriving, sent, rate: settings.rate, heldBack: stats.heldBack,
    limits: { ...stats.limits }, slowed: nowMs() - stats.limitAt < 3000, gameMsgs: stats.gameMsgs,
  };
}
function numbersText() {
  const x = numbers();
  return [
    'Live Pong numbers',
    `Role: ${x.role}; ${x.here} here`,
    `Round trip: ${x.rtt ? `typical ${x.rtt.typical} ms, worst ${x.rtt.worst} ms (last ${x.rtt.n})` : 'none yet'}`,
    `Paddle updates arriving: ${x.arriving.toFixed(1)} a second`,
    `Paddle rate setting: ${x.rate} a second; sent ${x.sent.toFixed(1)} a second; held back ${x.heldBack}`,
    `Room limits: ${x.limits.rate + x.limits.room + x.limits.other} (rate ${x.limits.rate}, room ${x.limits.room}, other ${x.limits.other})`,
    `Messages this game: ${x.gameMsgs}`,
  ].join('\n');
}
function drawGauge() {
  const panel = $('#gauge');
  if (panel.hidden) return;
  const x = numbers();
  const set = (id, text, cls) => { const d = panel.querySelector(`#${id}`); if (d && d.textContent !== text) d.textContent = text; if (d) d.className = cls || ''; };
  set('g-rtt', x.rtt ? `${x.rtt.typical} ms typical · ${x.rtt.worst} ms worst` : mode === 'live' ? 'measuring…' : '—');
  set('g-arr', `${x.arriving.toFixed(1)} a second`);
  set('g-sent', `${x.sent.toFixed(1)} a second · held back ${x.heldBack}`);
  const total = x.limits.rate + x.limits.room + x.limits.other;
  set('g-lim', x.slowed ? `Slowed by the room (${total})` : total ? `none now (${total} so far)` : 'none', x.slowed ? 'slowed' : '');
  set('g-role', x.role);
  set('g-msgs', String(x.gameMsgs));
  for (const b of panel.querySelectorAll('.rates button')) b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === settings.rate));
}
function buildGauge() {
  const panel = $('#gauge');
  const out = el('textarea', { readonly: true, 'aria-label': 'The numbers, to copy', hidden: true });
  panel.replaceChildren(
    el('h2', {}, 'Speed readout'),
    el('dl', {},
      el('dt', {}, 'Round trip'), el('dd', { id: 'g-rtt' }),
      el('dt', {}, 'Arriving'), el('dd', { id: 'g-arr' }),
      el('dt', {}, 'Sent'), el('dd', { id: 'g-sent' }),
      el('dt', {}, 'Room limits'), el('dd', { id: 'g-lim' }),
      el('dt', {}, 'You'), el('dd', { id: 'g-role' }),
      el('dt', {}, 'This game'), el('dd', { id: 'g-msgs' })),
    el('div', { class: 'row rates', role: 'group', 'aria-label': 'Paddle updates a second' }, el('span', {}, 'Paddle rate:'),
      RATES.map((r) => el('button', { type: 'button', 'data-rate': r, onclick: () => { settings.rate = r; drawGauge(); } }, String(r)))),
    el('div', { class: 'row' }, el('button', { type: 'button', id: 'copyBtn', onclick: () => {
      const text = numbersText();
      out.value = text; out.hidden = false; out.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      // (the clipboard API only where the frame allows it: a tile's frame usually doesn't)
      const allowed = document.featurePolicy?.allowsFeature?.('clipboard-write') === true;
      if (ok) tell('Copied the numbers.');
      else if (allowed && navigator.clipboard) navigator.clipboard.writeText(text).then(() => tell('Copied the numbers.'), () => tell('Select the numbers below and copy them.'));
      else tell('Select the numbers below and copy them.');
    } }, 'Copy numbers')),
    out,
    el('p', { class: 'note' }, 'Round trip: your own messages through the host’s page and back. Arriving: the other paddle’s updates.'),
  );
  drawGauge();
}
function buildGear() {
  const panel = $('#gear');
  const sel = (label, value, opts, onchange) => el('label', {}, label, (() => { const s = el('select', { onchange: (e) => onchange(e.target.value) }, opts.map(([v, t]) => el('option', { value: v, selected: v === value }, t))); return s; })());
  const chk = (label, value, onchange) => el('label', {}, el('input', { type: 'checkbox', checked: value, onchange: (e) => onchange(e.target.checked) }), label);
  panel.replaceChildren(
    el('h2', {}, 'Settings'),
    sel('Theme', settings.theme, [['green', 'Green phosphor'], ['white', 'White'], ['amber', 'Amber']], (v) => { settings.theme = v; document.documentElement.dataset.theme = v; }),
    chk('CRT effects', settings.crt, (v) => { settings.crt = v; document.documentElement.dataset.crt = v ? 'on' : 'off'; }),
    chk('Sound', settings.sound, (v) => { settings.sound = v; if (v) unlockAudio(); }),
    sel('The computer (alone)', settings.bot, [['easy', 'Easy'], ['medium', 'Medium'], ['hard', 'Hard']], (v) => { settings.bot = v; }),
  );
}
function togglePanel(id, btn) {
  const p = $(id);
  const open = p.hidden;
  for (const [pid, bid] of [['#gauge', '#gaugeBtn'], ['#gear', '#gearBtn']]) { $(pid).hidden = true; $(bid).setAttribute('aria-expanded', 'false'); }
  p.hidden = !open; $(btn).setAttribute('aria-expanded', String(open));
  if (open && id === '#gauge') { buildGauge(); pingAt = 0; }
  if (open && id === '#gear') buildGear();
}
$('#gaugeBtn').addEventListener('click', () => togglePanel('#gauge', '#gaugeBtn'));
$('#gearBtn').addEventListener('click', () => togglePanel('#gear', '#gearBtn'));
$('#pauseBtn').addEventListener('click', togglePause);

// ---- Input: keys on computers, a finger on touch screens; the mouse doesn't move the paddle (P10) ----
let touchSeen = false;
addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
  unlockAudio();
  const d = keyDir(view(), e.key);
  if (d) { myPaddle.keys.set(e.key.toLowerCase(), d); e.preventDefault(); return; }
  if (e.key === ' ' || e.key === 'Enter') { if (e.target === canvas || e.target === document.body) { e.preventDefault(); playAlone(); } }
  if (e.key === 'p' || e.key === 'P') togglePause();
});
addEventListener('keyup', (e) => { myPaddle.keys.delete(e.key.toLowerCase()); });
addEventListener('blur', () => { myPaddle.keys.clear(); myPaddle.touch = null; });
canvas.addEventListener('pointerdown', (e) => {
  unlockAudio();
  canvas.focus();
  if (e.pointerType === 'mouse') { if (mode === 'alone' && !state.game) playAlone(); return; }
  touchSeen = true;
  canvas.setPointerCapture?.(e.pointerId);
  myPaddle.touch = pFromScreen(view(), e.offsetX, e.offsetY);
  if (mode === 'alone' && !state.game) playAlone();
});
canvas.addEventListener('pointermove', (e) => { if (e.pointerType !== 'mouse' && myPaddle.touch !== null) myPaddle.touch = pFromScreen(view(), e.offsetX, e.offsetY); });
for (const t of ['pointerup', 'pointercancel']) canvas.addEventListener(t, (e) => { if (e.pointerType !== 'mouse') myPaddle.touch = null; });

function resetLocal() {
  ball.key = null; ball.seg = null; ball.fly = null;
  pads.clear(); serveAt = null; goneSince = null; claimed = false; lastResult = null; wantName = false;
  stats.gameG = null; stats.gameMsgs = 0;
  absentSince.clear();
}

// ---- The loop ----
let lastFrame = null;
const frameGaps = [];
function frame(t) {
  const dt = lastFrame === null ? 0 : Math.min((t - lastFrame) / 1000, 0.1);
  if (lastFrame !== null) { frameGaps.push(t - lastFrame); if (frameGaps.length > 60) frameGaps.shift(); }
  lastFrame = t;
  step(dt);
  draw();
  if (!$('#gauge').hidden && Math.floor(t / 250) !== Math.floor((t - dt * 1000) / 250)) drawGauge();
  requestAnimationFrame(frame);
}

// For checks and curious eyes: what this copy knows (autopilot: "good" or "miss", for the checks only).
window.__pong = {
  get state() { return state; }, get you() { return you; }, get here() { return [...here]; }, get mode() { return mode; },
  get synced() { return synced; }, get roomPaused() { return roomPaused; }, get ball() { return drawnBall(); },
  get myPaddle() { return myPaddle.p; }, numbers, numbersText, settings, autopilot: null,
  get stickMs() { return stick.last; }, get center() { return centerText()?.text ?? null; },
  get frameMs() { return frameGaps.length ? Math.round(frameGaps.reduce((x, y) => x + y, 0) / frameGaps.length) : null; }, get view() { const v = view(); return { portrait: v.portrait, me: v.me }; },
};
// The "stick" on this screen (P17): how long the ball last waited at the other player's line.
const stick = { last: null, since: null };
setInterval(() => {
  const b = drawnBall();
  const waiting = b && ball.seg && !controls(headingTo(ball.seg)) && b.t >= timeToPlane(ball.seg) - 1e-6;
  if (waiting && stick.since === null) stick.since = nowMs();
  if (!waiting && stick.since !== null) { stick.last = nowMs() - stick.since; stick.since = null; }
}, 10);

document.documentElement.dataset.crt = 'on';
drawBar();
requestAnimationFrame(frame);
