// typeahead.js: handle suggestions in the sign-in box (build step 9, owner Oct 25). An adapted COPY of Raku's
// src/typeahead.js (itself a copy of the site's src/daisy/typeahead.js, Seven-Up's, the Foundry's): only the
// class names (rl-ta-…) and the client label differ. Fix a bug in one, look at the others.
//
// Only the sign-in box gets suggestions, never the typed-name box: a suggested real handle there would look
// like choosing an account, and blur "@handle ✓" (checked through sign-in) with "Name (unverified)".
//
// Once what's typed looks like the start of a handle, suggestions come from typeahead.waow.tech (searchActors,
// up to 6), 150 ms after typing stops, from 2 characters. Trade-off (as in the Foundry, Daisy and Raku): those
// letters go to that service. Choosing a suggestion fills the box (onChoose).
//
// Keyboard: ↓ ↑ move, Enter chooses (without a highlighted suggestion the box submits as usual), Escape
// closes. Everything from the network goes in with textContent; avatars only from Bluesky's picture server.

export const TYPEAHEAD_URL = 'https://typeahead.waow.tech';
export const CLIENT_LABEL = 'thunderbird.cafe';
export const AVATAR_PREFIX = 'https://cdn.bsky.app/';
const LIMIT = 6, WAIT = 150, MIN = 2;

/** Does what's typed look like the start of a handle (and nothing else)? */
export function looksLikeHandle(text) {
  const t = String(text || '').trim();
  if (!t || /\s/.test(t)) return false;
  if (/^(at|tile|raku|https?):/i.test(t) || t.includes('/') || /^@?did:/i.test(t)) return false;
  return /^@?[a-z0-9][a-z0-9.-]*$/i.test(t) && t.replace(/^@/, '').length >= MIN;
}

export async function searchActors(text, fetchImpl = fetch, signal) {
  const q = String(text || '').trim().replace(/^@/, '');
  if (q.length < MIN) return [];
  try {
    const res = await fetchImpl(`${TYPEAHEAD_URL}/xrpc/tech.waow.typeahead.searchActors?q=${encodeURIComponent(q)}&limit=${LIMIT}`,
      { headers: { 'X-Client': CLIENT_LABEL }, signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) return [];
    const body = await res.json();
    return (Array.isArray(body.actors) ? body.actors : [])
      .filter((a) => a && typeof a.handle === 'string' && a.handle && a.handle !== 'handle.invalid')
      .slice(0, LIMIT);
  } catch {
    return [];
  }
}

/** Adds suggestions under `input`, in `holder` (a positioned element around it). onChoose(handle). */
export function attachTypeahead(input, holder, { onChoose, fetchImpl = fetch, id = 'rl-ta-list' } = {}) {
  const list = document.createElement('ul');
  list.className = 'rl-ta-list';
  list.id = id;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Accounts');
  list.hidden = true;
  holder.append(list);
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-controls', id);
  input.setAttribute('aria-expanded', 'false');

  let actors = [], active = -1, timer = null, asked = 0, ac = null;

  const close = () => {
    actors = []; active = -1; list.hidden = true; list.textContent = '';
    input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
  };
  const choose = (i) => {
    const a = actors[i];
    if (!a) return;
    close();
    clearTimeout(timer);
    onChoose?.(a.handle);
  };
  const mark = () => {
    [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    if (active >= 0) input.setAttribute('aria-activedescendant', `${id}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const draw = () => {
    list.textContent = '';
    actors.forEach((a, i) => {
      const li = document.createElement('li');
      li.id = `${id}-${i}`;
      li.setAttribute('role', 'option');
      li.className = 'rl-ta-item';
      const pic = document.createElement('span');
      pic.className = 'rl-ta-pic';
      if (typeof a.avatar === 'string' && a.avatar.startsWith(AVATAR_PREFIX)) {
        const img = document.createElement('img');
        img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.src = a.avatar;
        pic.append(img);
      }
      const words = document.createElement('span');
      words.className = 'rl-ta-words';
      const h = document.createElement('span'); h.className = 'rl-ta-handle'; h.textContent = '@' + a.handle;
      words.append(h);
      if (typeof a.displayName === 'string' && a.displayName.trim()) {
        const d = document.createElement('span'); d.className = 'rl-ta-name'; d.textContent = a.displayName.trim().slice(0, 80);
        words.append(d);
      }
      li.append(pic, words);
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(i); });   // before the box loses focus
      list.append(li);
    });
    list.hidden = !actors.length;
    input.setAttribute('aria-expanded', String(!!actors.length));
    mark();
  };

  input.addEventListener('input', (e) => {
    if (!e.isTrusted) return;
    clearTimeout(timer);
    const text = input.value;
    if (!looksLikeHandle(text)) { asked++; close(); return; }
    timer = setTimeout(async () => {
      const mine = ++asked;              // a slow earlier answer never replaces a newer one
      if (ac) ac.abort();
      ac = new AbortController();
      const found = await searchActors(text, fetchImpl, ac.signal);
      if (mine !== asked || document.activeElement !== input) return;
      actors = found; active = -1; draw();
    }, WAIT);
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden || !actors.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % actors.length; mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = active <= 0 ? actors.length - 1 : active - 1; mark(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  input.addEventListener('blur', () => { asked++; close(); });
  return { close };
}
