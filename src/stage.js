// stage.js: what the stage shows (build step 9, claude/rooms-lab-step9.md). Small rules, kept apart so they're
// tested on their own; room-page.js draws the result.
//
// The stage holds one thing at a time: a tile (put there by the host) or a presenter's screen. The host's page
// decides which tile is on the stage and tells everyone ({ kind: "stage", uri }); the other pages follow it.
// A tile on the stage wins over a screen being shared at the same time; the host can switch back ("Back to
// screen"). When someone starts sharing their screen, the host's page takes the tile off the stage, so a new
// share is seen at once.
//
// The stage keeps one size all evening (owner, Oct 25): nothing jumps when sharing starts or stops.

/**
 * @param {object} s
 * @param {string|null} s.tile        the tile on the stage (its address), or null
 * @param {'card'|'hidden'|'missing'} s.card  this page's card for it: shown, hidden by this person, not here yet
 * @param {string|null} s.presenter   who's presenting, or null
 * @param {boolean} s.screenLive      is that screen arriving (or is it ours)?
 * @returns {'tile'|'tile-hidden'|'tile-coming'|'screen'|'waiting'|'empty'}
 */
export function whatsOnStage({ tile, card, presenter, screenLive }) {
  if (tile) return card === 'card' ? 'tile' : card === 'hidden' ? 'tile-hidden' : 'tile-coming';
  if (presenter) return screenLive ? 'screen' : 'waiting';
  return 'empty';
}

/** The host's page: a new presenter takes the stage (the tile goes back to the list). → the stage's tile. */
export function afterPresenterChange(tile, before, after) {
  return after && after !== before ? null : tile;
}

export const EMPTY_LINE = 'Nothing on the stage: nobody is sharing their screen, and no tile is on the stage.';
export const EMPTY_HINT_HOST = 'Share your screen, or put a tile on the stage from the list below.';
export const EMPTY_HINT_GUEST = 'You can ask to share your screen, or ask to open a tile.';

// The status lines. A tile names itself, so its name always comes after the page's own words ("a tile … :").
export const stageLines = {
  put: (who, name) => `${who} put a tile on the stage${name ? `: ${name}` : '.'}`,
  left: (name) => `The tile left the stage${name ? `: ${name}` : '.'}`,
  back: (whose) => `Back to ${whose} screen.`,
  sharing: (who) => `${who} is sharing their screen.`,
};

// Full screen: the standard call, or Safari's older one; on an iPhone only a video can go full screen.
export function fullScreenCall(el, video = null) {
  const doc = el?.ownerDocument;
  const enabled = !!(doc && (doc.fullscreenEnabled || doc.webkitFullscreenEnabled));
  if (enabled && el.requestFullscreen) return () => el.requestFullscreen();
  if (enabled && el.webkitRequestFullscreen) return () => el.webkitRequestFullscreen();
  if (video && typeof video.webkitEnterFullscreen === 'function') return () => video.webkitEnterFullscreen();
  return null;
}
export const fullScreenNow = (doc) => doc?.fullscreenElement || doc?.webkitFullscreenElement || null;
export function leaveFullScreen(doc) {
  try { (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc); } catch { /* not full screen */ }
}
