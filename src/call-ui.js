// call-ui.js: what shows the call away from the room (0.13.0; claude/raku-rooms-step4.md, RR23 to RR32): the call
// bar a host page puts on its other tabs, the marker for the room's tab, and the floating window. All three draw
// from the room's `call` API (room-page.js): call.state, call.subscribe(fn), and its actions. Framework-free.
import {
  POP_OUT, BRING_BACK, BACK_TO_ROOM, POPPED_LINE, SHARING_LINE, STOP, LEAVE, END_ROOM, YES, NO, MORE, FOLD,
  leaveQuestion, LEAVE_ASK_MS, NOTICE_MS, FLOAT_SIZE, FOLD_TITLE, UNFOLD_TITLE,
  markerState, floatLayout, stageLine, shouldReopen, needsYou,
} from './call.js';

const SVG = 'http://www.w3.org/2000/svg';
const PHONE = '(max-width: 640px)';

// A small microphone (crossed when muted), drawn with the page's own elements (no markup strings).
function micIcon(doc, off) {
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'rl-mk-mic');
  const path = (d) => { const p = doc.createElementNS(SVG, 'path'); p.setAttribute('d', d); svg.append(p); return p; };
  path('M8 1.8a2.3 2.3 0 0 0-2.3 2.3v3.6a2.3 2.3 0 0 0 4.6 0V4.1A2.3 2.3 0 0 0 8 1.8z').setAttribute('class', 'rl-mk-body');
  path('M3.9 7.4a4.1 4.1 0 0 0 8.2 0M8 11.6v2.6M5.6 14.2h4.8').setAttribute('class', 'rl-mk-stand');
  if (off) path('M2.6 2.6l10.8 10.8').setAttribute('class', 'rl-mk-cross');
  return svg;
}

/** Draw the marker into `el` (RR28): a mic, a ring while anyone talks, crossed while you're muted, a dot when needed. */
export function drawMarker(el, state) {
  const m = markerState(state);
  const doc = el.ownerDocument;
  el.classList.add('rl-marker');
  el.dataset.mic = m.mic;
  el.classList.toggle('rl-mk-ring', m.ring);
  el.classList.toggle('rl-mk-dot', m.dot);
  if (el.dataset.drawn !== m.mic) { el.replaceChildren(micIcon(doc, m.mic === 'off'), Object.assign(doc.createElement('span'), { className: 'rl-mk-pip' })); el.dataset.drawn = m.mic; }
  el.setAttribute('aria-label', m.label);
  el.title = m.label;
  return m;
}

/** A button that asks in place (RR27): "Leave?" Yes · No for a few seconds, then back to the button. */
export function askInPlace(h, { label, question, onYes, cls = '', ms = LEAVE_ASK_MS }) {
  const el = h('span', { class: `rl-ask-place ${cls}` });
  let timer = null;
  const reset = () => { clearTimeout(timer); timer = null; el.classList.remove('rl-asking'); el.replaceChildren(btn); };
  const btn = h('button', { type: 'button', class: 'rl-cb-leave rl-danger', onclick: () => {
    clearTimeout(timer);
    el.classList.add('rl-asking');
    const no = h('button', { type: 'button', class: 'rl-ask-no', onclick: () => reset() }, NO);
    el.replaceChildren(h('span', { class: 'rl-ask-q' }, question()),
      h('button', { type: 'button', class: 'rl-ask-yes rl-danger', onclick: () => { reset(); onYes(); } }, YES), no);
    no.focus?.({ preventScroll: true });
    timer = setTimeout(reset, ms);
  } }, label());
  el.append(btn);
  return { el, reset, relabel: () => { if (!timer) btn.textContent = label(); }, get asking() { return !!timer; } };
}

// The people: chips (a dot that lights while they talk) when there's room, else "4 here".
function people(h, s, { chips = true } = {}) {
  const list = s.people || [];
  const talking = list.some((p) => p.talking);
  if (chips && list.length <= 4) {
    return h('span', { class: 'rl-cb-chips' }, ...list.map((p) => h('span', { class: `rl-x-chip${p.talking ? ' rl-talking' : ''}`, 'data-peer': p.peer },
      h('span', { class: `rl-dot${p.talking ? ' rl-talking' : ''}` }), h('span', { class: 'rl-x-name' }, p.me ? 'You' : p.name))));
  }
  return h('span', { class: `rl-x-count rl-cb-count${talking ? ' rl-talking' : ''}` }, `${list.length} here`);
}

// What needs you, else what's on: the first approval, the question for you, a notice, your own share, the stage. (The
// one-time hint shows in the room itself, RR26.)
function whatLine(h, s, call) {
  const a = s.approvals?.[0];
  if (a) {
    return h('span', { class: 'rl-cb-need', 'data-need': 'approval' },
      h('span', { class: 'rl-cb-text' }, a.text, s.approvals.length > 1 ? ` (+${s.approvals.length - 1} more)` : ''),
      h('button', { type: 'button', class: 'rl-primary rl-cb-allow', onclick: () => call.allow(a.key) }, 'Allow'),
      h('button', { type: 'button', class: 'rl-cb-deny', onclick: () => call.deny(a.key) }, 'Deny'));
  }
  if (s.prompt) {
    return h('span', { class: 'rl-cb-need', 'data-need': 'prompt' },
      h('span', { class: 'rl-cb-text' }, s.prompt.text),
      h('button', { type: 'button', class: 'rl-primary rl-cb-choose', onclick: () => call.share() }, 'Choose what to share…'),
      h('button', { type: 'button', class: 'rl-cb-notnow', onclick: () => call.notNow() }, 'Not now'));
  }
  if (s.notice && Date.now() - s.notice.at < NOTICE_MS) return h('span', { class: 'rl-cb-what-line rl-cb-notice' }, h('span', { class: 'rl-cb-text' }, s.notice.text));
  if (s.sharing) {
    return h('span', { class: 'rl-cb-what-line rl-cb-sharing' }, h('span', { class: 'rl-cb-text' }, SHARING_LINE),
      h('button', { type: 'button', class: 'rl-cb-stop', onclick: () => call.stopShare() }, STOP));
  }
  const st = s.stage || {};
  return h('span', { class: 'rl-cb-what-line' },
    st.badge ? h('span', { class: `rl-stage-badge rl-stage-badge-${st.badge === 'Tile' ? 'tile' : 'screen'}` }, st.badge) : null,
    h('span', { class: 'rl-cb-text rl-cb-stage' }, stageLine(st)));
}

// Redraw a part only when what it shows changed: the room's state arrives many times a second while people talk,
// and a button replaced under the pointer would lose the click.
function whatKey(s) {
  const a = s.approvals?.[0];
  if (a) return `a ${a.key} ${s.approvals.length}`;
  if (s.prompt) return `p ${s.prompt.id}`;
  if (s.notice && Date.now() - s.notice.at < NOTICE_MS) return `n ${s.notice.at}`;
  if (s.sharing) return 's';
  return `t ${s.stage?.badge || ''} ${stageLine(s.stage)}`;
}
const peopleKey = (s, chips) => `${chips ? 'c' : 'n'} ${(s.people || []).map((p) => `${p.peer}:${p.me ? 1 : 0}${p.talking ? 1 : 0}:${p.name}`).join('|')}`;
function keep(box, key, build) {
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  box.replaceChildren(build());
}

/**
 * The call bar (RR24 to RR29), for a host page's other tabs. The host page places `el` and says when it shows
 * (`show(on)`: in a room, another tab in front). Computer: one slim row; folded, nothing (the room's tab marker opens
 * it). Phone: above the bottom toolbar; folded, a round chip at the right edge. While the floating window is open: one
 * line, "The room is in its own window · Bring it back" (which folds too).
 * @param {{ call, h, onBack: () => void, matchMedia?: (q: string) => { matches: boolean } }} o
 */
export function createCallBar({ call, h, onBack, matchMedia = (q) => globalThis.matchMedia?.(q) }) {
  let folded = false, shown = false, menu = false, last = null, noticeTimer = null, code = null;
  const leave = askInPlace(h, { label: () => (last?.host ? END_ROOM : LEAVE), question: () => leaveQuestion(!!last?.host), onYes: () => call.leave() });
  const phoneLeave = askInPlace(h, { label: () => (last?.host ? END_ROOM : LEAVE), question: () => leaveQuestion(!!last?.host), onYes: () => call.leave(), cls: 'rl-cb-menu-leave' });
  const what = h('span', { class: 'rl-cb-what' });
  const ppl = h('span', { class: 'rl-cb-people' });
  const mic = h('button', { type: 'button', class: 'rl-cb-mic', 'aria-pressed': 'false', onclick: () => call.toggleMic() }, 'Unmute');
  const pop = h('button', { type: 'button', class: 'rl-cb-pop', hidden: true, onclick: () => call.popOut() }, POP_OUT);
  const back = h('button', { type: 'button', class: 'rl-cb-back', onclick: () => onBack?.() }, BACK_TO_ROOM);
  const foldBtn = h('button', { type: 'button', class: 'rl-cb-fold', title: FOLD_TITLE, 'aria-label': FOLD_TITLE, onclick: () => fold(true) }, '⌃');
  const moreBtn = h('button', { type: 'button', class: 'rl-cb-more', title: MORE, 'aria-label': MORE, 'aria-expanded': 'false', onclick: () => { menu = !menu; render(); } }, '⋯');
  const menuEl = h('div', { class: 'rl-cb-menu', role: 'menu', hidden: true },
    h('button', { type: 'button', class: 'rl-cb-menu-fold', role: 'menuitem', onclick: () => { menu = false; fold(true); } }, FOLD), phoneLeave.el);
  const row = h('div', { class: 'rl-cb-row' }, what, ppl, mic, pop, back, leave.el, moreBtn, foldBtn, menuEl);
  const poppedFold = h('button', { type: 'button', class: 'rl-cb-fold', title: FOLD_TITLE, 'aria-label': FOLD_TITLE, onclick: () => fold(true) }, '⌃');
  const popped = h('div', { class: 'rl-cb-popped', hidden: true },
    h('span', { class: 'rl-cb-text' }, POPPED_LINE), h('button', { type: 'button', class: 'rl-cb-bring', onclick: () => call.popIn() }, BRING_BACK), poppedFold);
  const chipMark = h('span', {});
  const chip = h('button', { type: 'button', class: 'rl-cb-chip', title: UNFOLD_TITLE, onclick: () => fold(false) }, chipMark);
  const el = h('div', { class: 'rl rl-callbar', role: 'region', 'aria-label': 'Your call', hidden: true }, row, popped, chip);

  function fold(on) {
    folded = !!on;
    if (folded) { menu = false; leave.reset(); phoneLeave.reset(); }
    render();
  }

  function render() {
    const s = call.state;
    const phone = !!matchMedia?.(PHONE)?.matches;
    if (!s || !s.joined) { el.hidden = true; return; }
    if (s.code !== code) { code = s.code; folded = false; }       // a fold is for this call only (RR24)
    el.hidden = !shown;
    el.classList.toggle('rl-cb-folded', folded);
    el.classList.toggle('rl-cb-phone', phone);
    el.classList.toggle('rl-cb-needs', needsYou(s));
    const isPopped = !!s.popped;
    el.classList.toggle('rl-cb-is-popped', isPopped);
    row.hidden = isPopped || folded;
    popped.hidden = !isPopped || folded;
    chip.hidden = !(folded && phone);
    drawMarker(chipMark, s);
    chip.setAttribute('aria-label', `${UNFOLD_TITLE}: ${markerState(s).label}`);
    if (row.hidden) return;
    keep(what, whatKey(s), () => whatLine(h, s, call));
    keep(ppl, peopleKey(s, !phone), () => people(h, s, { chips: !phone }));
    mic.textContent = s.micOn ? 'Mute' : 'Unmute';
    mic.setAttribute('aria-pressed', String(!!s.micOn));
    pop.hidden = !s.canPopOut || phone;
    leave.relabel(); phoneLeave.relabel();
    leave.el.hidden = phone;
    foldBtn.hidden = phone;
    moreBtn.hidden = !phone;
    menuEl.hidden = !phone || !menu;
    moreBtn.setAttribute('aria-expanded', String(phone && menu));
  }

  call.subscribe((s) => {
    if (shouldReopen(last, s) && folded) folded = false;
    if (s?.notice && s.notice.at !== last?.notice?.at) {
      clearTimeout(noticeTimer);
      noticeTimer = setTimeout(render, NOTICE_MS + 50);
    }
    last = s ? { ...s, approvals: [...(s.approvals || [])] } : null;
    render();
  });
  render();
  return {
    el,
    /** The host page: show it (in a room, another tab in front) or not. */
    show(on) { shown = !!on; if (!on) { menu = false; leave.reset(); phoneLeave.reset(); } render(); },
    fold, toggle: () => fold(!folded),
    get folded() { return folded; },
    get shown() { return shown && !el.hidden; },
    render,
  };
}

/**
 * The floating window (RR30): Document Picture-in-Picture. open() must run inside a click. Its page gets the opener's
 * styles (Raku's and the room's own), so it looks the same.
 * @param {{ call, h, onBack: () => void, onClosed: () => void, win?: Window }} o
 */
export function createFloat({ call, h, onBack, onClosed, win = globalThis }) {
  let pip = null, unsub = null, video = null;
  const leave = askInPlace(h, { label: () => (call.state?.host ? END_ROOM : LEAVE), question: () => leaveQuestion(!!call.state?.host), onYes: () => call.leave() });
  const root = h('div', { class: 'rl rl-float' });
  const mic = h('button', { type: 'button', class: 'rl-fl-mic', 'aria-pressed': 'false', onclick: () => call.toggleMic() }, 'Unmute');
  const back = h('button', { type: 'button', class: 'rl-fl-back', onclick: () => onBack?.() }, BACK_TO_ROOM);

  // The floating window's page gets the opener's styles as a constructed sheet (the rules copied, no markup, so a
  // page policy that allows only its own style files is kept; the window has no address of its own to load them).
  // A sheet that can't be read (another site's) goes over as a link with its full address.
  function copyStyles(w) {
    const doc = w.document;
    const text = [];
    for (const sheet of win.document.styleSheets) {
      try { text.push([...sheet.cssRules].map((r) => r.cssText).join('\n')); } catch {
        if (sheet.href) { const l = doc.createElement('link'); l.rel = 'stylesheet'; l.href = sheet.href; doc.head.append(l); }
      }
    }
    try {
      const sheet = new w.CSSStyleSheet();
      sheet.replaceSync(text.join('\n'));
      doc.adoptedStyleSheets = [sheet];
    } catch (err) { console.warn('[rooms-lab] the floating window\u2019s styles', err); }
  }

  async function open() {
    if (pip) return pip;
    const w = await win.documentPictureInPicture.requestWindow({ ...FLOAT_SIZE });
    pip = w;
    w.document.title = 'Room';
    copyStyles(w);
    w.document.documentElement.classList.add('rl-float-html');
    w.document.body.className = 'rl-float-body';
    w.document.body.append(root);
    w.addEventListener('pagehide', () => { if (pip === w) closed(); });
    w.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && leave.asking) leave.reset(); });
    unsub = call.subscribe(() => render());
    render();
    return w;
  }
  function closed() {
    unsub?.(); unsub = null;
    if (video) { video.srcObject = null; video = null; }
    leave.reset();
    root.remove();
    pip = null;
    onClosed?.();
  }
  function close() { const w = pip; if (!w) return; closed(); try { w.close(); } catch { /* gone */ } }

  // The parts of the window, kept between redraws (only what changed is drawn again).
  const picture = h('div', { class: 'rl-fl-picture' });
  const need = h('div', { class: 'rl-fl-need' });
  const stripPeople = h('span', { class: 'rl-fl-strip-people' });
  const strip = h('div', { class: 'rl-fl-strip' });
  const topPeople = h('div', { class: 'rl-fl-people' });
  const whatBox = h('div', { class: 'rl-fl-what' });
  const buttons = h('div', { class: 'rl-fl-buttons' });
  function render() {
    const s = call.state;
    if (!pip || !s) return;
    if (!s.joined) { close(); return; }
    const layout = floatLayout(s);
    mic.textContent = s.micOn ? 'Mute' : 'Unmute';
    mic.setAttribute('aria-pressed', String(!!s.micOn));
    leave.relabel();
    if (root.dataset.layout !== layout) {
      root.dataset.layout = layout;
      for (const b of [need, stripPeople, topPeople, whatBox]) delete b.dataset.key;
      if (layout === 'picture') {
        if (!video) { video = h('video', { class: 'rl-fl-video', autoplay: true, playsinline: true, muted: true }); video.muted = true; picture.replaceChildren(video); }
        strip.replaceChildren(stripPeople, mic, back, leave.el);
        root.replaceChildren(picture, need, strip);
      } else {
        if (video) { video.srcObject = null; video = null; picture.replaceChildren(); }
        buttons.replaceChildren(mic, back, leave.el);
        root.replaceChildren(topPeople, whatBox, buttons);
      }
    }
    if (layout === 'picture') {
      if (video.srcObject !== s.screen) { video.srcObject = s.screen; video.play?.().catch(() => {}); }
      need.hidden = !needsYou(s);
      keep(need, needsYou(s) ? whatKey(s) : 'none', () => (needsYou(s) ? whatLine(h, s, call) : h('span', {})));
      keep(stripPeople, peopleKey(s, false), () => people(h, s, { chips: false }));
      return;
    }
    keep(topPeople, peopleKey(s, true), () => people(h, s, { chips: true }));
    keep(whatBox, whatKey(s), () => whatLine(h, s, call));
  }
  return { open, close, get isOpen() { return !!pip; }, get window() { return pip; }, render };
}
