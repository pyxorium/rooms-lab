// tiles.mjs: what goes into the Rooms lab's own tiles (modelled on daisy-tiles/scripts/tiles.mjs), for
// publish.mjs (the published records; Raku pins the house, ROOMS.house in its src/config.js):
//   house   the room's rules, hidden on the host's page
//   poll    the live poll (live tiles): a demo tile opened for everyone by its address, then shared live.
//           It names no address (it also shows up in Raku and the galleries, where it's a poll for one).
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ROOM_URL = 'https://thunderbird.cafe/webtiles/rooms-lab/';

export const TILES = {
  house: {
    name: 'Rooms lab house',
    description: "The house for a Rooms lab room: it holds the room's rules (who may ask to see someone's screen, who may present, who may open a tile for everyone). The person sharing always decides. It runs hidden on the host's page at thunderbird.cafe/webtiles/rooms-lab/, so on its own there is little to see.",
    sizing: { width: 420, height: 240 },
    files: ['index.html', 'house.css', 'house.js', 'rules.js', 'talk.js'],
  },
  poll: {
    name: 'Live poll',
    description: 'Ask a question with up to six answers; everyone votes, and the results update as they come in. Shared live in a room, everyone in it votes in the same poll; on its own it’s a poll for one. Its live-talk.js shows how a tile talks to the other copies of itself.',
    sizing: { width: 480, height: 440 },
    files: ['index.html', 'poll.css', 'poll.js', 'poll-state.js', 'live-talk.js', 'ready.js'],
  },
};
// Card pictures, made by scripts/make-card-art.py.
export const CARD_FILES = ['icon.png', 'banner.png'];

// The Foundry's one fixed type per kind of file (web-tile-foundry/src/core/fileset.js CONTENT_TYPES).
export const PUBLISH_TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

// The tile's own security policy, from its page's <meta> tag (it also goes in the record, as the Foundry does).
export function cspOf(html) {
  const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i.exec(html);
  if (!m) throw new Error('The tile page has no security policy.');
  return m[1];
}

// A tile's files for publishing: [{ path, bytes, contentType }], "/" being its page.
export function publishFiles(id) {
  const t = TILES[id];
  const out = [];
  for (const f of [...t.files, ...CARD_FILES]) {
    const file = join(ROOT, 'tiles', id, f);
    if (!existsSync(file)) throw new Error(`Missing tiles/${id}/${f}${CARD_FILES.includes(f) ? ' (run: python3 scripts/make-card-art.py)' : ''}`);
    const path = f === 'index.html' ? '/' : `/${f}`;
    out.push({ path, bytes: new Uint8Array(readFileSync(file)), contentType: PUBLISH_TYPES[extname(f)] });
  }
  return out;
}

// A short fingerprint of a tile's own files (not the card pictures): names an unpublished copy's version.
export function fingerprint(id) {
  const h = createHash('sha256');
  for (const f of TILES[id].files) { h.update(f); h.update('\0'); h.update(readFileSync(join(ROOT, 'tiles', id, f))); h.update('\0'); }
  return 'memory:' + h.digest('hex').slice(0, 24);
}
