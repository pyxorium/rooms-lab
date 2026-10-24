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
//
// Previews (step 4b): before a tile goes to everyone, whoever opens it (or asks to, or approves it) runs it
// here first, privately ("Only you can see this"), after the same checks. Its buttons come from the room
// page (Open for everyone / Ask… / Allow, Deny; Cancel). When the tile is then opened for everyone at the
// same version, the preview card becomes that person's ordinary card *in place*: the frame is never moved
// (a browser reloads a frame that moves), so the tile keeps running and nothing loads twice.
import { parseTileUri } from './tile-records.js';

export const MAX_TILES = 6;
const PREVIEW_NOTE = 'Only you can see this (unless you’re sharing your whole screen).';

export const sizeText = (n) => (!(n > 0) ? '' : n < 1024 ? `${n} bytes` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function createTileStrip({ mount, records, hide, tileHost = null, h, nameOf = () => 'Someone', isHost = () => false,
  onCloseForEveryone = () => {}, onNote = () => {} }) {
  const entries = new Map();      // uri → { uri, cid, by, private, el, … }
  const dismissed = new Set();    // `${uri} ${cid}` this person hid

  const setState = (e, state, text) => {
    e.state = state;
    e.el.dataset.state = state;
    if (text !== undefined) e.status.textContent = text;
    e.status.hidden = state === 'open';
    paintButtons(e);
  };

  function card(t) {
    const title = h('span', { class: 'rl-tile-name' }, 'A tile');
    const author = h('span', { class: 'rl-tile-author' });
    const size = h('span', { class: 'rl-tile-size' });
    const desc = h('p', { class: 'rl-tile-desc' });
    const byEl = h('span', { class: 'rl-tile-by' }, t.private ? '' : `opened by ${nameOf(t.by)}`);
    const status = h('p', { class: 'rl-tile-status', role: 'status' }, 'Checking the tile…');
    const body = h('div', { class: 'rl-tile-body' });
    const actions = h('span', { class: 'rl-tile-actions' });
    const notice = h('p', { class: 'rl-tile-private' }, PREVIEW_NOTE);
    const note = h('p', { class: 'rl-tile-note', role: 'status' });
    const el = h('li', { class: 'rl-tile', 'data-uri': t.uri },
      h('div', { class: 'rl-tile-head' }, h('span', { class: 'rl-tile-who' }, title, author, size, byEl), actions),
      notice, desc, status, note, body);
    return { el, title, author, size, desc, byEl, status, body, actions, notice, note };
  }

  // The buttons on a card: a preview's come from the room page; a shared tile's are Hide for me and the
  // host's Close for everyone. A preview's buttons marked `needsOpen` wait until the tile is running.
  function sharedButtons(e) {
    return [
      { text: 'Hide for me', cls: 'rl-tile-hide', onclick: () => { dismissed.add(`${e.uri} ${e.cid}`); remove(e.uri); } },
      { text: 'Close for everyone', cls: 'rl-tile-close rl-danger', hidden: () => !isHost(), onclick: () => onCloseForEveryone(e.uri) },
    ];
  }
  function setButtons(e, list) {
    e.buttons = list.map((b) => ({ ...b, el: h('button', { type: 'button', class: b.cls || '', onclick: () => b.onclick(e) }, b.text) }));
    e.actions.replaceChildren(...e.buttons.map((b) => b.el));
    paintButtons(e);
  }
  function paintButtons(e) {
    for (const b of e.buttons || []) {
      b.el.hidden = !!b.hidden?.();
      b.el.disabled = (b.needsOpen && e.state !== 'open') || !!b.disabled?.();
    }
  }

  function describe(e, rec) {
    e.title.textContent = rec.name;
    e.author.textContent = `by ${rec.did}`;
    e.author.title = rec.did;
    records.checkedHandle?.(rec.did).then((handle) => { if (handle && entries.get(e.uri) === e) e.author.textContent = `by @${handle}`; });
    if (e.private) { e.size.textContent = sizeText(rec.declaredBytes); e.desc.textContent = rec.description; }
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
    describe(e, rec);
    if (e.cid && rec.cid !== e.cid) {
      onNote(`"${rec.name}" changed since it was ${e.private ? 'asked for' : 'opened for everyone'}: not shown`);
      return setState(e, 'changed', e.private
        ? 'This tile has changed since it was asked for, so it isn’t shown (ask again for the new version).'
        : 'This tile has changed since it was opened for everyone, so it isn’t shown here (everyone runs the same version).');
    }
    e.cid = rec.cid;                      // a preview pins the version it read: that's what gets sent
    e.rec = rec;
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

  function add(t) {
    const parts = card(t);
    const e = { uri: t.uri, cid: t.cid || null, by: t.by || null, private: !!t.private, ...parts, state: 'new', attempt: 0, rec: null };
    entries.set(t.uri, e);
    e.el.classList.toggle('rl-tile-preview', e.private);
    e.notice.hidden = !e.private;
    setButtons(e, e.private ? t.buttons : sharedButtons(e));
    mount.prepend(e.el);                 // newest first
    open(e);
    return e;
  }

  // A preview becomes an ordinary card, in place: the same element, the same frame, still running.
  function promote(e, t) {
    e.private = false;
    e.by = t.by;
    e.el.classList.remove('rl-tile-preview');
    e.notice.hidden = true;
    e.note.textContent = '';
    e.size.textContent = '';
    e.desc.textContent = '';
    e.byEl.textContent = `opened by ${nameOf(t.by)}`;
    setButtons(e, sharedButtons(e));
  }

  function show(t) {
    if (dismissed.has(`${t.uri} ${t.cid}`)) return;
    const had = entries.get(t.uri);
    if (had && had.private && had.cid === t.cid && had.state !== 'changed') return promote(had, t);
    if (had && !had.private && had.cid === t.cid) return;
    if (had) remove(t.uri);
    add(t);
  }

  /** A private preview: the same checks, the tile running only here. `buttons`: [{ text, cls, onclick(e),
   *  needsOpen?, disabled?(), hidden?() }]. `cid`: the version it must be (when approving someone's request). */
  function preview(uri, { buttons = [], cid = null } = {}) {
    for (const e of [...entries.values()]) if (e.private) remove(e.uri);       // one preview at a time
    if (entries.has(uri)) return null;                                          // already open for everyone
    return add({ uri, cid, private: true, buttons });
  }

  function remove(uri) {
    const e = entries.get(uri);
    if (!e) return;
    entries.delete(uri);
    e.attempt++;
    e.el.remove();
  }

  return {
    show, preview, remove,
    /** The buttons follow who's host, who's asking, and whether the tile is running. */
    refresh() { for (const e of entries.values()) paintButtons(e); },
    /** A line under a preview's status ("Asked the host…"). */
    noteOn(uri, text) { const e = entries.get(uri); if (e?.private) e.note.textContent = text; },
    previewOf(uri) { const e = entries.get(uri); return e?.private ? { cid: e.cid, state: e.state, rec: e.rec } : null; },
    removePreview(uri) { if (entries.get(uri)?.private) remove(uri); },
    has: (uri) => entries.has(uri),
    isShared: (uri) => !!entries.get(uri) && !entries.get(uri).private,
    state: (uri) => entries.get(uri)?.state ?? null,
    get size() { return [...entries.values()].filter((e) => !e.private).length; },
    clear() { for (const uri of [...entries.keys()]) remove(uri); },
  };
}
