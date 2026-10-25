// main.js: the Rooms lab page on thunderbird.cafe (build step 5), https://thunderbird.cafe/webtiles/rooms-lab/.
// It lives in C:\thunderbird-cafe\rooms-lab\site\ and copy-to-site.mjs copies it, with the page modules, into
// the site's src\rooms-lab\ (the site's Astro page src\pages\webtiles\rooms-lab\index.astro imports it).
//
// It gives the room page (room-page.js) the site's tile loader, as Daisy does: one TileMothership for the
// whole page (several would trip over each other's tiles), on the site's loading server
// (src/lib/tile-load-domain.js: a fresh random name per tile, each tile on its own origin).
//   - The house tile: the published house, pinned (published.generated.js: its address and record CID).
//     Its record is read from thunderbird.cafe's server and refused if it isn't the pinned version; every
//     file is checked against its content address (tile-records.js). Without it (not published, changed,
//     or unreachable) the room falls back to "the host approves each request" and says so.
//   - Tiles opened for everyone: the same loader, with the page's own pinned file loader.
// And optional sign-in (step 8, signin.js): the site's @atproto/oauth-client-browser (0.5.8), with this page's
// own sign-in description (public/webtiles/rooms-lab/oauth.json; on 127.0.0.1 a loopback one). In the small
// sign-in window the page only finishes the sign-in and says so.
import { TileMothership, Tile } from '@dasl/tile-loader';
import { BrowserOAuthClient, LoginContinuedInParentWindowError } from '@atproto/oauth-client-browser';
import { TILE_LOAD_DOMAIN } from '../lib/tile-load-domain.js';
import { mountRoomPage } from './room-page.js';
import { createTileRecords } from './tile-records.js';
import { createSignIn } from './signin.js';
import { PUBLISHED } from './published.generated.js';

const HOUSE_HEIGHT = 240;
const isHere = (loc) => ['127.0.0.1', 'localhost'].includes(loc.hostname);

// For checks on this computer only: another loading server (?loader=…), as Daisy's and Seven-Up's.
function loadSourceOverride(loc = globalThis.location) {
  if (!isHere(loc)) return null;
  const v = new URLSearchParams(loc.search).get('loader');
  return v && /^https?:\/\/[a-z0-9.-]+(:\d+)?\/\.well-known\/web-tiles\/$/i.test(v) ? v : null;
}

let ship = null;
function mothership() {
  if (!ship) {
    ship = new TileMothership({ loadDomain: TILE_LOAD_DOMAIN });
    const override = loadSourceOverride();
    if (override) ship.getLoadSource = () => override;
    ship.init();
  }
  return ship;
}

const records = createTileRecords();

// The house's frame, for the host's page (house-bridge.js mounts it, hidden). null: no house.
async function loadHouse() {
  const pin = PUBLISHED && PUBLISHED.house;
  if (!pin) { console.warn('[rooms-lab] the house tile isn\u2019t published yet: the host approves each request'); return null; }
  const rec = await records.read(pin.uri);
  if (!rec.ok) { console.warn('[rooms-lab] the house tile couldn\u2019t be read:', rec.why); return null; }
  if (rec.cid !== pin.cid) { console.warn(`[rooms-lab] the house tile has changed (record ${rec.cid}, pinned ${pin.cid}): not used`); return null; }
  const loader = records.pathLoader({ pds: rec.pds, did: rec.did, manifest: rec.manifest });
  const frame = new Tile(mothership(), rec.uri, rec.manifest, loader).renderContent(HOUSE_HEIGHT);
  frame.title = 'The house (the room\u2019s rules)';
  return frame;
}

// Tiles opened for everyone (and previews): the site's loader, fed by the page's pinned file loader.
const tileHost = {
  render({ uri, manifest, loader, height }) {
    const frame = new Tile(mothership(), uri, manifest, loader).renderContent(height);
    frame.removeAttribute('style');
    frame.setAttribute('allow', '');                    // no camera, microphone, location… for tiles (as Raku)
    frame.setAttribute('referrerpolicy', 'no-referrer');
    return frame;
  },
};

// (In a function, not top-level await: as Daisy's and Seven-Up's entry points, for the site's build target.)
async function start() {
  const root = document.getElementById('room');
  const signIn = createSignIn({ BrowserOAuthClient, LoginContinuedInParentWindowError });
  const started = await signIn.start();
  if (started.finishedInWindow) {
    root.textContent = 'Signed in. You can close this window.';
  } else if (!started.moving) {
    // For the console: window.__roomsLab.room is what the page knows right now.
    window.__roomsLab = mountRoomPage(root, { loadHouse, tileHost, records, signIn: signIn.ready() ? signIn : null });
  }
}
start();
