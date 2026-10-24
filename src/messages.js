// messages.js: what the pages say to each other through the relay (`data` in the relay's to/all messages).
// Everything from another page is checked here first: names and ids come from people, not from us.
//
//   { kind: "rtc", description: { type, sdp } }   setting up the direct connection (to one person)
//   { kind: "rtc", candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment } }
//   { kind: "presenting", on }                     I'm presenting / I've stopped (to everyone)
//   { kind: "ask-screen", id }                     "can I see your screen?" (to one person)
//   { kind: "ask-answer", id, answer }             "yes" | "no" | "busy" | "already" (to the asker)
//
// (Step 3 puts the house tile between asking and the prompt: these become wishes.)

const isId = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x);
const str = (x, max) => typeof x === 'string' && x.length <= max;
export const ANSWERS = ['yes', 'no', 'busy', 'already'];

/** The message, cleaned, or null if it isn't one of ours. */
export function readPeerData(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  switch (d.kind) {
    case 'rtc': {
      if (d.description && typeof d.description === 'object') {
        const { type, sdp } = d.description;
        if (!['offer', 'answer', 'pranswer', 'rollback'].includes(type) || !(sdp === undefined || str(sdp, 60_000))) return null;
        return { kind: 'rtc', description: { type, sdp: sdp ?? '' } };
      }
      if (d.candidate && typeof d.candidate === 'object') {
        const c = d.candidate;
        if (!str(c.candidate, 2000)) return null;
        return { kind: 'rtc', candidate: {
          candidate: c.candidate,
          sdpMid: str(c.sdpMid, 64) ? c.sdpMid : null,
          sdpMLineIndex: Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 64 ? c.sdpMLineIndex : null,
          ...(str(c.usernameFragment, 256) ? { usernameFragment: c.usernameFragment } : {}),
        } };
      }
      return null;
    }
    case 'presenting': return typeof d.on === 'boolean' ? { kind: 'presenting', on: d.on } : null;
    case 'ask-screen': return isId(d.id) ? { kind: 'ask-screen', id: d.id } : null;
    case 'ask-answer': return isId(d.id) && ANSWERS.includes(d.answer) ? { kind: 'ask-answer', id: d.id, answer: d.answer } : null;
    default: return null;
  }
}
