// call.js: the call away from the room (0.13.0; claude/raku-rooms-step4.md, RR23 to RR32). Small rules and words,
// kept apart so they're tested on their own; call-ui.js draws the call bar, the marker and the floating window, and
// room-page.js keeps the state they show (its `call` API).
//
// - The call bar: on the host page's other tabs (Raku), what's on, the people, Mute, Pop out, Back to the room, Leave
//   (asking in place), and whatever needs you (a guest's request for the host, "asks to see your screen", your own
//   share). It folds; it opens again by itself when something new needs you (RR24).
// - The marker: the room's tab shows the call (a mic, a ring while anyone talks, crossed while you're muted, a dot when
//   something needs you; RR28, RR32).
// - The floating window (Document Picture-in-Picture, Chrome and Edge on computers): always on top, even over other
//   programs; a live screen when someone else shares one, compact otherwise (RR30). While it's open the call bar
//   shrinks to one line (RR25), which folds too (RR31).
// - The hint: the first screen share in a call, "Presenting from another program? …" (RR26).

export const POP_OUT = 'Pop out';
export const BRING_BACK = 'Bring it back';
export const BACK_TO_ROOM = 'Back to the room';
export const POPPED_LINE = 'The room is in its own window';
export const POP_HINT = 'Presenting from another program? Pop out the room to keep it on top.';
export const SHARING_LINE = 'You’re sharing your screen';
export const STOP = 'Stop';
export const LEAVE = 'Leave';
export const END_ROOM = 'End room';
export const YES = 'Yes';
export const NO = 'No';
/** The in-place question (RR27): a guest leaves; the host's button ends the room, as in the room itself. */
export const leaveQuestion = (host) => (host ? 'End the room?' : 'Leave?');
/** How long "Leave? Yes · No" waits before going back to Leave (RR27). */
export const LEAVE_ASK_MS = 4000;
/** How long a notice (your share stopped…) shows in the call bar. */
export const NOTICE_MS = 5000;
/** The floating window's first size (RR30); afterwards whatever the person drags it to. */
export const FLOAT_SIZE = Object.freeze({ width: 320, height: 200 });
export const FOLD_TITLE = 'Fold the call bar (the room’s tab opens it again)';
export const UNFOLD_TITLE = 'Show the call bar';
export const MORE = 'More';
export const FOLD = 'Fold';

/** Can this browser open the floating window? (Chrome and Edge on computers; not Firefox, Safari or phones.) */
export function canPopOut(win = globalThis) {
  try { return !!win && win.isSecureContext !== false && typeof win.documentPictureInPicture?.requestWindow === 'function'; } catch { return false; }
}

/** Does something need you? A guest's request (the host), or a question for you (share your screen?). */
export const needsYou = (s) => !!s && ((s.approvals?.length || 0) > 0 || !!s.prompt);

/** The call bar opens again by itself (RR24) when something new needs you, or a notice that asks for it arrives. */
export function shouldReopen(before, after) {
  if (!after) return false;
  const n = (s) => (s?.approvals?.length || 0) + (s?.prompt ? 1 : 0);
  if (n(after) > n(before)) return true;
  if (after.prompt && before?.prompt && after.prompt.id !== before.prompt.id) return true;
  return !!after.notice?.reopen && after.notice.at !== before?.notice?.at;
}

/** What the marker shows (RR28): the mic on or crossed, the ring while anyone talks, the dot when something needs you. */
export function markerState(s) {
  const on = !!s?.micOn;
  const ring = !!s?.talking;
  const dot = needsYou(s);
  const parts = ['In a room'];
  if (ring) parts.push('someone is talking');
  parts.push(on ? 'your microphone is on' : 'you’re muted');
  if (dot) parts.push(s.approvals?.length ? 'a request is waiting for you' : 'a question is waiting for you');
  return { mic: on ? 'on' : 'off', ring, dot, label: parts.join(' · ') };
}

/** The floating window's layout (RR30): a picture while someone else's screen is on the stage; compact otherwise. */
export const floatLayout = (s) => (s?.stage?.what === 'screen' && s?.screen && !s?.sharing ? 'picture' : 'compact');

/** The line saying what's on the stage, for the call bar and the floating window. */
export function stageLine(stage) {
  if (!stage || !stage.what || stage.what === 'empty') return 'Nothing on the stage';
  if (stage.what === 'tile') return `${stage.name || 'A tile'}, on the stage`;
  return stage.caption || '';
}

/** The one-time hint (RR26): the first screen share in a call, where the window can pop out, unless you already did. */
export const showHint = ({ canPop, seen, popped, used }) => !!canPop && !seen && !popped && !used;
