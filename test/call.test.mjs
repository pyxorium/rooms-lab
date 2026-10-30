// call.test.mjs: the call away from the room (0.13.0; claude/raku-rooms-step4.md, RR23 to RR32): call.js's rules
// and words.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POPPED_LINE, BRING_BACK, POP_HINT, POP_OUT, LEAVE_ASK_MS, FLOAT_SIZE, leaveQuestion, canPopOut, needsYou,
  shouldReopen, markerState, floatLayout, stageLine, showHint,
} from '../src/call.js';

test('the agreed words (RR25, RR26, RR27)', () => {
  assert.equal(POPPED_LINE, 'The room is in its own window');
  assert.equal(BRING_BACK, 'Bring it back');
  assert.equal(POP_OUT, 'Pop out');
  assert.equal(POP_HINT, 'Presenting from another program? Pop out the room to keep it on top.');
  assert.equal(leaveQuestion(false), 'Leave?');
  assert.equal(leaveQuestion(true), 'End the room?', 'the host’s button ends the room, as in the room itself');
  assert.equal(LEAVE_ASK_MS, 4000, 'about four seconds');
  assert.deepEqual({ ...FLOAT_SIZE }, { width: 320, height: 200 });
});

test('pop out only where the browser has Document Picture-in-Picture (Chrome and Edge on computers)', () => {
  assert.equal(canPopOut({ documentPictureInPicture: { requestWindow() {} } }), true);
  assert.equal(canPopOut({ isSecureContext: false, documentPictureInPicture: { requestWindow() {} } }), false);
  assert.equal(canPopOut({}), false, 'Firefox, Safari, phones');
  assert.equal(canPopOut(null), false);
});

test('what needs you: a request waiting (the host), or a question for you', () => {
  assert.equal(needsYou({ approvals: [], prompt: null }), false);
  assert.equal(needsYou({ approvals: [{ key: 'a' }], prompt: null }), true);
  assert.equal(needsYou({ approvals: [], prompt: { id: 'x' } }), true);
  assert.equal(needsYou(null), false);
});

test('the folded call bar opens again by itself when something new needs you, or your share stops (RR24)', () => {
  const base = { approvals: [], prompt: null, notice: null };
  assert.equal(shouldReopen(base, { ...base }), false, 'nothing new: stays folded');
  assert.equal(shouldReopen(base, { ...base, approvals: [{ key: 'a' }] }), true, 'a guest’s request');
  assert.equal(shouldReopen({ ...base, approvals: [{ key: 'a' }] }, { ...base, approvals: [{ key: 'a' }] }), false, 'the same request: no');
  assert.equal(shouldReopen({ ...base, approvals: [{ key: 'a' }] }, base), false, 'a request answered: no');
  assert.equal(shouldReopen(base, { ...base, prompt: { id: 'p' } }), true, 'asked to share your screen');
  assert.equal(shouldReopen({ ...base, prompt: { id: 'p' } }, { ...base, prompt: { id: 'q' } }), true, 'a new question');
  assert.equal(shouldReopen(base, { ...base, notice: { text: 'You stopped sharing.', at: 5, reopen: true } }), true, 'your share stopped');
  assert.equal(shouldReopen({ ...base, notice: { at: 5, reopen: true } }, { ...base, notice: { at: 5, reopen: true } }), false, 'the same notice: no');
  assert.equal(shouldReopen(base, null), false);
});

test('the marker (RR28): mic on or crossed, a ring while anyone talks, a dot when something needs you; said in words', () => {
  const quiet = markerState({ micOn: false, talking: false, approvals: [], prompt: null });
  assert.deepEqual({ mic: quiet.mic, ring: quiet.ring, dot: quiet.dot }, { mic: 'off', ring: false, dot: false });
  assert.equal(quiet.label, 'In a room · you’re muted');
  const busy = markerState({ micOn: true, talking: true, approvals: [{ key: 'a' }], prompt: null });
  assert.deepEqual({ mic: busy.mic, ring: busy.ring, dot: busy.dot }, { mic: 'on', ring: true, dot: true });
  assert.equal(busy.label, 'In a room · someone is talking · your microphone is on · a request is waiting for you');
  assert.match(markerState({ prompt: { id: 'p' } }).label, /a question is waiting for you/);
});

test('the floating window (RR30): a picture only while someone else’s screen is on the stage', () => {
  const stream = {};
  assert.equal(floatLayout({ stage: { what: 'screen' }, screen: stream, sharing: false }), 'picture');
  assert.equal(floatLayout({ stage: { what: 'screen' }, screen: null, sharing: true }), 'compact', 'your own share is never shown back to you');
  assert.equal(floatLayout({ stage: { what: 'tile' }, screen: null }), 'compact');
  assert.equal(floatLayout({ stage: { what: 'empty' } }), 'compact');
  assert.equal(floatLayout({ stage: { what: 'waiting' }, screen: null }), 'compact');
});

test('the stage line', () => {
  assert.equal(stageLine({ what: 'tile', name: 'Poll' }), 'Poll, on the stage');
  assert.equal(stageLine({ what: 'tile' }), 'A tile, on the stage');
  assert.equal(stageLine({ what: 'screen', caption: 'Robin’s screen' }), 'Robin’s screen');
  assert.equal(stageLine({ what: 'empty' }), 'Nothing on the stage');
  assert.equal(stageLine(null), 'Nothing on the stage');
});

test('the hint (RR26): once per call, only where the window can pop out, never after Pop out', () => {
  assert.equal(showHint({ canPop: true, seen: false, popped: false, used: false }), true);
  assert.equal(showHint({ canPop: false, seen: false, popped: false, used: false }), false);
  assert.equal(showHint({ canPop: true, seen: true, popped: false, used: false }), false);
  assert.equal(showHint({ canPop: true, seen: false, popped: true, used: false }), false);
  assert.equal(showHint({ canPop: true, seen: false, popped: false, used: true }), false);
});
