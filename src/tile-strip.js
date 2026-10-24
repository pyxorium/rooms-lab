// tile-strip.js: the strip of tiles opened for everyone (rooms-lab-plan.md, section 7), under the stage.
//
// The host's page sends each tile's address and record CID; every page shows it here, after checking for
// itself, in this order:
//   1. Would Raku refuse it (the hide list, Bluesky's moderation)? Then "This tile isn't shown here."
//   2. Its record, read from its author's server: if the CID isn't the one sent, the tile changed since it
//      was opened, and it isn't shown (everyone runs the same version, or nobody does).
//   3. The tile itself, through the page's tile loader (`tileHost`), every file checked against the record.
// Each person plays with their own copy, independently; nothing they do in it is sent anywhere by the room.
// "Hide for me" takes it off your own strip; the host's "Close for everyone" takes it off everyone's.
import { parseTileUri } from './tile-records.js';

export const MAX_TILES = 6;

export function createTileStrip({ mount, records, hide, tileHost = null, h, nameOf = () => 'Someone', isHost = () => false,
  onCloseForEveryone = () => {}, onNote = () => {} }) {
  const entries = new Map();      // uri → { uri, cid, by, el, body, title, state, attempt }
  const dismissed = new Set();    // `${uri} ${cid}` this person hid

  const setState = (e, state, text) => {
    e.state = state;
    e.el.dataset.state = state;
    if (text !== undefined) e.status.textContent = text;
    e.status.hidden = state === 'open';
  };

  function card(t) {
    const title = h('span', { class: 'rl-tile-name' }, 'A tile');
    const by = h('span', { class: 'rl-tile-by' }, `opened by ${nameOf(t.by)}`);
    const status = h('p', { class: 'rl-tile-status', role: 'status' }, 'Checking the tile…');
    const body = h('div', { class: 'rl-tile-body' });
    const close = h('button', { type: 'button', class: 'rl-tile-close rl-danger', hidden: !isHost(), onclick: () => onCloseForEveryone(t.uri) }, 'Close for everyone');
    const hideBtn = h('button', { type: 'button', class: 'rl-tile-hide', onclick: () => { dismissed.add(`${t.uri} ${t.cid}`); remove(t.uri); } }, 'Hide for me');
    const el = h('li', { class: 'rl-tile', 'data-uri': t.uri },
      h('div', { class: 'rl-tile-head' }, title, by, h('span', { class: 'rl-tile-actions' }, hideBtn, close)),
      status, body);
    return { el, title, by, status, body, close };
  }

  async function open(e) {
    const mine = ++e.attempt;
    const alive = () => entries.get(e.uri) === e && e.attempt === mine;
    const at = parseTileUri(e.uri);
    if (!at) return setState(e, 'failed', 'That isn’t a tile address.');
    setState(e, 'checking', 'Checking the tile…');
    let hidden = false;
    try { hidden = await hide.isHidden(at.did, at.rkey); } catch { hidden = false; }
    if (!alive()) return;
    if (hidden) { e.title.textContent = 'A tile'; return setState(e, 'hidden', 'This tile isn’t shown here.'); }
    const rec = await records.read(e.uri);
    if (!alive()) return;
    if (!rec.ok) return setState(e, 'failed', rec.why);
    e.title.textContent = rec.name;
    if (rec.cid !== e.cid) {
      onNote(`"${rec.name}" changed since it was opened for everyone: not shown`);
      return setState(e, 'changed', 'This tile has changed since it was opened for everyone, so it isn’t shown here (everyone runs the same version).');
    }
    if (!tileHost) return setState(e, 'no-loader', 'This page can’t open tiles (it has no tile loader).');
    setState(e, 'loading', 'Opening the tile…');
    const loader = records.pathLoader({
      pds: rec.pds, did: rec.did, manifest: rec.manifest,
      onFile: (path, ok) => {
        if (!alive() || (path !== '/' && path !== '/index.html')) return;
        if (ok) { if (e.state === 'loading') setState(e, 'open'); }
        else { setState(e, 'failed', 'The tile’s page couldn’t be loaded (or wasn’t the version opened for everyone).'); e.body.replaceChildren(); }
      },
    });
    const height = Math.max(200, Math.min(700, rec.sizing?.height || 480));
    let frame = null;
    try { frame = await tileHost.render({ uri: rec.uri, manifest: rec.manifest, loader, height, name: rec.name }); } catch { frame = null; }
    if (!alive()) { frame?.remove?.(); return; }
    if (!frame) return setState(e, 'failed', 'The tile couldn’t be opened.');
    if (e.state === 'failed') { frame.remove?.(); return; }          // its page was refused while it was opening
    frame.classList.add('rl-tile-frame');
    frame.style.height = `${height}px`;
    frame.title = rec.name;
    e.body.replaceChildren(frame);
  }

  function show(t) {
    if (dismissed.has(`${t.uri} ${t.cid}`)) return;
    const had = entries.get(t.uri);
    if (had && had.cid === t.cid) return;
    if (had) remove(t.uri);
    const parts = card(t);
    const e = { uri: t.uri, cid: t.cid, by: t.by, ...parts, state: 'new', attempt: 0 };
    entries.set(t.uri, e);
    mount.prepend(e.el);                 // newest first
    open(e);
  }

  function remove(uri) {
    const e = entries.get(uri);
    if (!e) return;
    entries.delete(uri);
    e.attempt++;
    e.el.remove();
  }

  return {
    show, remove,
    /** The host's Close buttons follow who's host. */
    refresh() { for (const e of entries.values()) e.close.hidden = !isHost(); },
    has: (uri) => entries.has(uri),
    state: (uri) => entries.get(uri)?.state ?? null,
    get size() { return entries.size; },
    clear() { for (const uri of [...entries.keys()]) remove(uri); },
  };
}
