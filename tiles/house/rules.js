// rules.js: the room's rules, as the house tile holds them (rooms-lab-plan.md, R1 and section 6). No
// browser parts, so they're tested in Node (test/house-rules.test.mjs).
//
// The house only *mediates*. For every wish it answers:
//   allow     the request may go on, to the person it's about: they still get their page's prompt, then
//             the browser's picker. A house never starts a share, and can't.
//   deny      it stops here, with a reason the asker sees;
//   ask-host  the host decides (their page shows Allow / Deny).
//
// This house's one rule set, "the host approves":
//   - anyone may ask to see someone's screen, or ask to present: the host approves;
//   - the host's own requests go ahead (the host would only be approving themselves);
//   - asking to see the host's screen goes straight to the host, whose own prompt is the decision;
//   - one presenter at a time: while someone presents, nobody can ask to see a screen or to present;
//   - the host may open a tile for everyone; anyone else asks the host (used from build step 4);
//   - the host may share a tile live with the room (its copies send each other what people do in them);
//     anyone else asks the host (live tiles, rooms-live-tiles-plan.md L5);
//   - nothing is decided while the host is away (their page, and the house with it, is gone anyway).
//
// state: { host, presenter, peers: [{ peer, name, host, away? }] }   (from the host's page)
// wish:  { id, by, wish: "see-screen" | "present" | "open-tile" | "live", target?, uri? }   (by: who asks; every message
//        from the page also carries from: "page", the tiles' envelope)

export const RULE_SET = 'host-approves';
export const WISHES = ['see-screen', 'present', 'open-tile', 'live'];
const TILE_URI = /^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]{1,2000}\/ing\.dasl\.masl\/[A-Za-z0-9._~:-]{1,512}$/;

const answer = (decision, reason) => ({ decision, reason });

export function decide(state, wish) {
  if (!state || !Array.isArray(state.peers) || !wish || typeof wish !== 'object') return answer('deny', 'The house has no room to decide for.');
  const here = new Set(state.peers.filter((p) => p && !p.away).map((p) => p.peer));
  const host = state.host;
  if (!host || !here.has(host)) return answer('deny', 'The host is away. Try again when they’re back.');
  if (!here.has(wish.by)) return answer('deny', 'Only people in the room can ask.');
  const byHost = wish.by === host;

  switch (wish.wish) {
    case 'see-screen': {
      if (!wish.target || !here.has(wish.target)) return answer('deny', 'They’re not in the room.');
      if (wish.target === wish.by) return answer('deny', 'That’s your own screen.');
      if (state.presenter) return answer('deny', 'Someone is presenting. One screen at a time.');
      if (wish.target === host) return answer('allow', 'The host answers for their own screen.');
      if (byHost) return answer('allow', 'The host may ask anyone.');
      return answer('ask-host', 'The host approves screen requests.');
    }
    case 'present': {
      if (state.presenter === wish.by) return answer('deny', 'You’re already presenting.');
      if (state.presenter) return answer('deny', 'Someone is presenting. One screen at a time.');
      if (byHost) return answer('allow', 'The host may present any time.');
      return answer('ask-host', 'The host approves who presents.');
    }
    case 'open-tile': {
      if (typeof wish.uri !== 'string' || !TILE_URI.test(wish.uri)) return answer('deny', 'That isn’t a tile address.');
      if (byHost) return answer('allow', 'The host may open tiles for everyone.');
      return answer('ask-host', 'The host approves tiles opened for everyone.');
    }
    case 'live': {
      if (typeof wish.uri !== 'string' || !TILE_URI.test(wish.uri)) return answer('deny', 'That isn’t a tile address.');
      if (byHost) return answer('allow', 'The host may share tiles live.');
      return answer('ask-host', 'The host approves tiles shared live.');
    }
    default: return answer('deny', 'The house doesn’t know that request.');
  }
}
