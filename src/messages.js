// messages.js: what the pages say to each other through the relay (`data` in the relay's to/all messages).
// Everything from another page is checked here first: names and ids come from people, not from us.
//
//   { kind: "rtc", description: { type, sdp } }   setting up the direct connection (to one person)
//   { kind: "rtc", candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment } }
//   { kind: "presenting", on }                     I'm presenting / I've stopped (to everyone)
// Wishes (build step 3): every wish goes to the host's page, which asks the house tile.
//   { kind: "wish", id, wish, target? }            to the host: "see-screen" (target: whose) or "present"
//   { kind: "wish-result", id, decision, reason }  from the host to the asker: "allow" or "deny"
//   { kind: "ask-screen", id, asker }              from the host to the person whose screen is asked for;
//                                                  pages take this only from the host
//   { kind: "go-ahead", id }                       from the host to someone who asked to present
//   { kind: "ask-answer", id, answer }             the person asked, to the asker: "yes" | "no" | "busy" | "already"
// None of these makes a page share: sharing always starts from the person's own click, then the picker.
// Tiles opened for everyone (build step 4), from the host's page only:
//   { kind: "wish", id, wish: "open-tile", uri, cid? }  to the host: "open this tile for everyone" (cid: the
//                                                  version the asker previewed, step 4b; the host refuses another)
//   { kind: "tile", uri, cid, by }                 to everyone: open this tile, this exact version (record CID)
//   { kind: "tiles", list: [{ uri, cid, by }] }    to someone who just came in: the tiles open now
//   { kind: "tile-close", uri }                    to everyone: the host closed it

import { TILE_URI, isRecordCid } from './tile-records.js';

const isId = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(x);
const isPeer = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(x);
const str = (x, max) => typeof x === 'string' && x.length <= max;
export const ANSWERS = ['yes', 'no', 'busy', 'already'];
export const PAGE_WISHES = ['see-screen', 'present', 'open-tile'];
export const MAX_TILES = 6;
const isTileUri = (x) => typeof x === 'string' && x.length <= 2600 && TILE_URI.test(x);
const readTile = (t) => (t && typeof t === 'object' && isTileUri(t.uri) && isRecordCid(t.cid) && isPeer(t.by) ? { uri: t.uri, cid: t.cid, by: t.by } : null);

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
    case 'wish':
      if (!isId(d.id) || !PAGE_WISHES.includes(d.wish)) return null;
      if (d.wish === 'see-screen') return isPeer(d.target) ? { kind: 'wish', id: d.id, wish: d.wish, target: d.target } : null;
      if (d.wish === 'open-tile') {
        if (!isTileUri(d.uri) || !(d.cid === undefined || isRecordCid(d.cid))) return null;
        return { kind: 'wish', id: d.id, wish: d.wish, uri: d.uri, ...(d.cid ? { cid: d.cid } : {}) };
      }
      return { kind: 'wish', id: d.id, wish: d.wish };
    case 'wish-result':
      if (!isId(d.id) || !['allow', 'deny'].includes(d.decision)) return null;
      return { kind: 'wish-result', id: d.id, decision: d.decision, reason: str(d.reason, 200) ? d.reason : '' };
    case 'ask-screen': return isId(d.id) && isPeer(d.asker) ? { kind: 'ask-screen', id: d.id, asker: d.asker } : null;
    case 'go-ahead': return isId(d.id) ? { kind: 'go-ahead', id: d.id } : null;
    case 'ask-answer': return isId(d.id) && ANSWERS.includes(d.answer) ? { kind: 'ask-answer', id: d.id, answer: d.answer } : null;
    case 'tile': { const t = readTile(d); return t ? { kind: 'tile', ...t } : null; }
    case 'tiles': {
      if (!Array.isArray(d.list) || d.list.length > MAX_TILES) return null;
      const list = d.list.map(readTile);
      return list.every(Boolean) ? { kind: 'tiles', list } : null;
    }
    case 'tile-close': return isTileUri(d.uri) ? { kind: 'tile-close', uri: d.uri } : null;
    default: return null;
  }
}
