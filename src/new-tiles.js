// new-tiles.js: the new-tile offer (0.10.0; claude/rooms-new-tile-offer-plan.md, mockup
// claude/rooms-new-tile-offer-mockup.html).
//
// A signed-in person (or the host) who publishes a tile somewhere else, say in the Foundry's tab, finds it
// offered on their own page: "Twilight Sprite is now saved in your account." [Preview it] [Not now]. Nothing
// links the Foundry and the room: the tile's record in the person's own account is the signal.
//   - Only the publisher's own page looks, and only at its own account: nobody else (not even the host) learns
//     of a new tile unless its maker shows it. Typed names can't be matched to an account: no offer for them.
//   - When: once each time the room's tab becomes visible again (back from the Foundry's tab), and every 30 s
//     while it's visible (windows side by side); never while hidden; the slow check pauses while an offer waits.
//   - What: tile records in the account created after joining (a minute's slack for clocks), newest first;
//     not ones already in the strip or previewed; not ones "Not now" dropped (for this visit).
//   - "Preview it" does what pasting the address and pressing Preview does (step 4b), nothing more.

export const POLL_MS = 30_000;             // the slow check, while the room's tab is visible
export const SLACK_MS = 60_000;            // a tile published up to a minute before joining still counts
export const LIST_LIMIT = 10;              // the newest this many records are looked at each time

const S32 = '234567abcdefghijklmnopqrstuvwxyz';
/** A record key's time (ms since 1970) when it's a TID, as atproto's record keys usually are; else null. */
export function tidTime(rkey) {
  if (typeof rkey !== 'string' || !/^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/.test(rkey)) return null;
  let v = 0n;
  for (const ch of rkey) v = (v << 5n) | BigInt(S32.indexOf(ch));
  return Number(v >> 10n) / 1000;
}

/** When a listed record was made: its key's time, else its createdAt, else null. */
export function madeAt(t) {
  const fromKey = tidTime(t?.rkey);
  if (fromKey !== null) return fromKey;
  const c = Date.parse(t?.createdAt);
  return Number.isFinite(c) ? c : null;
}

/** The offer's words: "Twilight Sprite is now saved in your account." / "… and +2 more are now saved …". */
export function offerWords(tiles) {
  if (!tiles.length) return null;
  const name = tiles[0].name || 'Your new tile';
  return tiles.length === 1
    ? { name, more: 0, tail: ' is now saved in your account.' }
    : { name, more: tiles.length - 1, tail: ' are now saved in your account.' };
}

// list(did) → [{ uri, rkey, cid, name, createdAt }] newest first (tile-records.js recent()); throws on failure.
// skip(uri) → true for a tile already in the strip or previewed. onOffer(tiles) → draw the offer ([] = none).
// isVisible() → is the room's tab visible. The timer functions are swappable for the tests.
export function createNewTileWatcher({ did, since, list, skip = () => false, onOffer = () => {}, isVisible = () => true,
  pollMs = POLL_MS, slackMs = SLACK_MS, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  if (typeof did !== 'string' || !did.startsWith('did:')) throw new Error('new tiles: an account is needed');
  const dropped = new Set();     // uris "Not now" dropped, or taken to a preview: not offered again this visit
  let offered = [];              // what the offer shows now
  let busy = null, stopped = false;
  const timer = setIntervalImpl(() => { if (isVisible() && !offered.length) check(); }, pollMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  const same = (a, b) => a.length === b.length && a.every((t, i) => t.uri === b[i].uri);
  function show(next) {
    if (same(next, offered)) return;
    offered = next;
    onOffer(offered.slice());
  }
  /** Look once (now): any new tiles to offer? Never two looks at a time. */
  function check() {
    if (stopped) return Promise.resolve(offered.slice());
    if (busy) return busy;
    busy = (async () => {
      try {
        const listed = await list(did);
        if (stopped) return offered.slice();
        const fresh = (Array.isArray(listed) ? listed : []).filter((t) => {
          if (!t || typeof t.uri !== 'string' || !t.uri.startsWith(`at://${did}/`)) return false;
          const when = madeAt(t);
          return when !== null && when >= since - slackMs && !dropped.has(t.uri) && !skip(t.uri);
        }).sort((a, b) => madeAt(b) - madeAt(a));
        show(fresh);
      } catch { /* the account's server didn't answer: try again next time */ }
      return offered.slice();
    })().finally(() => { busy = null; });
    return busy;
  }
  return {
    check,
    /** The room's tab became visible again. */
    visible() { return check(); },
    /** "Not now": drop everything offered, for this visit. */
    notNow() { for (const t of offered) dropped.add(t.uri); show([]); },
    /** "Preview it" on one: it goes to the preview, and leaves the offer. */
    take(uri) { dropped.add(uri); show(offered.filter((t) => t.uri !== uri)); },
    /** A tile reached the strip some other way (pasted, opened by the host): no longer offered. */
    forget(uri) { if (offered.some((t) => t.uri === uri)) show(offered.filter((t) => t.uri !== uri)); },
    get offered() { return offered.slice(); },
    stop() { stopped = true; clearIntervalImpl(timer); },
  };
}
