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
//
// Live (live.js): a tile that speaks the live protocol gets, on the host's card, "Share live with the room"
// (and "Stop sharing live" once it is); on a guest's card, "Ask to share live". Every card of a live tile
// says "Shared live with the room". The strip tells the room page which frame is which tile (frameOf,
// uriOfSource) and when a copy is gone (onRemoved).
//
// The stage (step 9): one shared tile at a time can be on the stage. Its card is never moved either: the room
// page lays it over the stage's box (`elementOf`), and a slim line keeps its place in the list ("Tile Poll: on
// the stage ↑"). On the stage the card shows the page's own "Tile" badge, the host's "Take off stage" (or "Back
// to screen" while someone shares a screen) and "Full screen"; off it, the host's "Put on stage".
import { parseTileUri } from './tile-records.js';

export const MAX_TILES = 6;
const PREVIEW_NOTE = 'Only you can see this (unless you’re sharing your whole screen).';

export const sizeText = (n) => (!(n > 0) ? '' : n < 1024 ? `${n} bytes` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);

const NO_LIVE = { info: () => ({ spoke: false, live: false, asking: false, joining: false }), share: () => {}, stop: () => {}, ask: () => {} };
const NO_STAGE = { put: () => {}, off: () => {}, offLabel: () => 'Take off stage', full: null };

export function createTileStrip({ mount, records, hide, tileHost = null, h, nameOf = () => 'Someone', isHost = () => false,
  onCloseForEveryone = () => {}, onNote = () => {}, live = NO_LIVE, onRemoved = () => {}, stage = NO_STAGE, onUpdate = () => {} }) {
  const entries = new Map();      // uri → { uri, cid, by, private, el, … }
  const dismissed = new Set();    // `${uri} ${cid}` this person hid
  let staged = null;              // the tile on the stage (its address), or null

  const setState = (e, state, text) => {
    e.state = state;
    e.el.dataset.state = state;
    if (text !== undefined) e.status.textContent = text;
    e.status.hidden = state === 'open';
    paintButtons(e);
    onUpdate(e.uri);
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
    const liveBadge = h('p', { class: 'rl-tile-live', hidden: true }, 'Shared live with the room');
    // Step 9b: this copy is live but the host's page hasn't counted it yet (the page keeps asking).
    const joinNote = h('p', { class: 'rl-tile-joining', role: 'status', hidden: true }, 'Joining the live room\u2026');
    // The page's own label while the card is on the stage: a tile can't change it (it's outside the tile's frame).
    const stageBadge = h('span', { class: 'rl-stage-badge rl-stage-badge-tile', hidden: true }, 'Tile');
    const el = h('li', { class: 'rl-tile', 'data-uri': t.uri },
      h('div', { class: 'rl-tile-head' }, h('span', { class: 'rl-tile-who' }, stageBadge, title, author, size, byEl), actions),
      liveBadge, joinNote, notice, desc, status, note, body);
    return { el, title, author, size, desc, byEl, status, body, actions, notice, note, liveBadge, joinNote, stageBadge };
  }

  // The buttons on a card: a preview's come from the room page; a shared tile's are Hide for me and the
  // host's Close for everyone. A preview's buttons marked `needsOpen` wait until the tile is running.
  function sharedButtons(e) {
    const info = () => live.info(e.uri);
    const on = () => staged === e.uri;
    return [
      { text: 'Put on stage', cls: 'rl-primary rl-tile-stage-on', hidden: () => !isHost() || on(), onclick: () => stage.put(e.uri) },
      { text: 'Take off stage', label: () => stage.offLabel(), cls: 'rl-tile-stage-off', hidden: () => !isHost() || !on(), onclick: () => stage.off() },
      // Full screen; where the browser has none (an iPhone), "fill the window" instead (step 9b).
      { text: 'Full screen', label: () => (isFull(e) ? 'Exit full screen' : 'Full screen'), cls: 'rl-tile-full',
        hidden: () => !on(), onclick: () => toggleFull(e) },
      { text: 'Share live with the room', cls: 'rl-primary rl-tile-live-on', hidden: () => !isHost() || !info().spoke || info().live,
        disabled: () => info().asking, onclick: () => live.share(e.uri) },
      { text: 'Ask to share live', cls: 'rl-tile-live-ask', hidden: () => isHost() || !info().spoke || info().live,
        disabled: () => info().asking, onclick: () => live.ask(e.uri) },
      { text: 'Stop sharing live', cls: 'rl-tile-live-off', hidden: () => !isHost() || !info().live, onclick: () => live.stop(e.uri) },
      // The host takes a tile off the stage instead (hiding it would leave them nothing to take off).
      { text: 'Hide for me', cls: 'rl-tile-hide', hidden: () => isHost() && on(), onclick: () => { dismissed.add(`${e.uri} ${e.cid}`); remove(e.uri); } },
      { text: 'Close for everyone', cls: 'rl-tile-close rl-danger', hidden: () => !isHost(), onclick: () => onCloseForEveryone(e.uri) },
    ];
  }
  const fullNow = () => (typeof document === 'undefined' ? null : document.fullscreenElement || document.webkitFullscreenElement || null);
  const isFull = (e) => fullNow() === e.el || e.el.classList.contains('rl-tile-fill');
  function setFill(e, on) {
    if (e.el.classList.contains('rl-tile-fill') === on) return;
    e.el.classList.toggle('rl-tile-fill', on);
    paintButtons(e);
    onUpdate(e.uri);
  }
  function toggleFull(e) {
    if (fullNow() === e.el) { try { (document.exitFullscreen || document.webkitExitFullscreen)?.call(document); } catch { /* fine */ } return; }
    if (e.el.classList.contains('rl-tile-fill')) { setFill(e, false); return; }
    const go = stage.full?.(e.el);
    if (go) Promise.resolve().then(go).catch(() => setFill(e, true));
    else setFill(e, true);                // no full screen here: the card covers the window instead
  }
  // Escape leaves "fill the window" too (real full screen handles it itself).
  globalThis.document?.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    for (const e of entries.values()) setFill(e, false);
  });
  function setButtons(e, list) {
    e.buttons = list.map((b) => ({ ...b, el: h('button', { type: 'button', class: b.cls || '', onclick: () => b.onclick(e) }, b.text) }));
    e.actions.replaceChildren(...e.buttons.map((b) => b.el));
    paintButtons(e);
  }
  function paintButtons(e) {
    e.liveBadge.hidden = e.private || !live.info(e.uri).live;
    e.joinNote.hidden = e.private || !live.info(e.uri).joining;
    e.el.classList.toggle('rl-tile-is-live', !e.liveBadge.hidden);
    for (const b of e.buttons || []) {
      b.el.hidden = !!b.hidden?.();
      if (b.label) b.el.textContent = b.label();
      b.el.disabled = (b.needsOpen && e.state !== 'open') || !!b.disabled?.();
    }
  }

  function describe(e, rec) {
    e.title.textContent = rec.name;
    if (e.placeholder) e.placeholder.replaceChildren(...placeholderWords(rec.name));
    onUpdate(e.uri);
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
        else { setState(e, 'failed', 'The tile’s page couldn’t be loaded (or wasn’t the version opened for everyone).'); e.body.replaceChildren(); e.frame = null; }
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
    e.frame = frame;
    e.body.replaceChildren(frame);
  }

  function add(t) {
    const parts = card(t);
    const e = { uri: t.uri, cid: t.cid || null, by: t.by || null, private: !!t.private, ...parts, state: 'new', attempt: 0, rec: null, frame: null };
    entries.set(t.uri, e);
    e.el.classList.toggle('rl-tile-preview', e.private);
    e.notice.hidden = !e.private;
    setButtons(e, e.private ? t.buttons : sharedButtons(e));
    mount.prepend(e.el);                 // newest first
    if (!e.private && e.uri === staged) setStaged(staged);
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
    setStaged(staged);
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

  // The slim line that keeps a staged card's place in the list (inserted next to it: the card itself never moves).
  const placeholderWords = (name) => [h('span', { class: 'rl-stage-badge rl-stage-badge-tile' }, 'Tile'), ' ', h('span', { class: 'rl-tile-name' }, name || 'A tile'), ': on the stage \u2191'];
  function setStaged(uri) {
    staged = uri || null;
    for (const e of entries.values()) {
      const on = !e.private && e.uri === staged;
      e.el.classList.toggle('rl-tile-on-stage', on);
      e.stageBadge.hidden = !on;
      if (on && !e.placeholder) {
        e.placeholder = h('li', { class: 'rl-tile-placeholder', 'data-uri': e.uri }, ...placeholderWords(e.rec?.name));
        e.el.before(e.placeholder);
      } else if (!on && e.placeholder) { e.placeholder.remove(); e.placeholder = null; }
      if (!on) { for (const k of ['position', 'top', 'left', 'width', 'height']) e.el.style.removeProperty(k); e.el.classList.remove('rl-tile-fill'); }
      paintButtons(e);
    }
  }

  function remove(uri) {
    const e = entries.get(uri);
    if (!e) return;
    entries.delete(uri);
    e.attempt++;
    e.placeholder?.remove();
    e.placeholder = null;
    e.el.remove();
    e.frame = null;
    onRemoved(uri);
  }

  return {
    show, preview, remove, setStaged,
    /** The card's element (the room page lays the staged one over the stage), or null. */
    elementOf: (uri) => entries.get(uri)?.el ?? null,
    /** Did this person hide that tile ("Hide for me")? */
    wasHidden: (uri) => [...dismissed].some((k) => k.startsWith(`${uri} `)),
    by: (uri) => entries.get(uri)?.by ?? null,
    /** The tile's declared size ({ width, height } from its record), or null. */
    sizing: (uri) => entries.get(uri)?.rec?.sizing ?? null,
    /** The buttons follow who's host, who's asking, and whether the tile is running. */
    refresh() { for (const e of entries.values()) paintButtons(e); },
    /** A line under a preview's status ("Asked the host…"). */
    noteOn(uri, text) { const e = entries.get(uri); if (e?.private) e.note.textContent = text; },
    previewOf(uri) { const e = entries.get(uri); return e?.private ? { cid: e.cid, state: e.state, rec: e.rec } : null; },
    removePreview(uri) { if (entries.get(uri)?.private) remove(uri); },
    has: (uri) => entries.has(uri),
    /** The running frame of a tile on this page (a preview's too), or null. */
    frameOf: (uri) => (entries.get(uri)?.state === 'open' ? entries.get(uri).frame : null),
    /** Which tile a message came from (its frame's window), or null. */
    uriOfSource(src) {
      if (!src) return null;
      for (const e of entries.values()) if (e.frame && e.state === 'open' && e.frame.contentWindow === src) return e.uri;
      return null;
    },
    name: (uri) => entries.get(uri)?.rec?.name ?? null,
    isShared: (uri) => !!entries.get(uri) && !entries.get(uri).private,
    state: (uri) => entries.get(uri)?.state ?? null,
    get size() { return [...entries.values()].filter((e) => !e.private).length; },
    clear() { for (const uri of [...entries.keys()]) remove(uri); },
  };
}
