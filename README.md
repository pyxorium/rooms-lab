# Rooms lab

A proof of concept for **rooms**: small live rooms for tile demos among friends. Voice, one shared screen at a
time, a house tile that holds the room's rules, and tiles opened for everyone. The lab page will live at
https://thunderbird.cafe/webtiles/rooms-lab/ (a hidden page). Rooms may move into
[Raku](https://raku.lexicographer.space/) later, so the page code here is plain JavaScript modules with no
framework, which Raku can import as they are.

## Where it's at

1. **The relay** (`relay/`): done. It introduces the people in a room and passes their messages; it stores
   nothing. See `relay/README.md`.
2. **Two pages, voice and screen** (`src/`, `dev/`): done.
3. **The house tile and wishes** (`tiles/house/`, `src/house-bridge.js`): done. Every request ("Ask to see
   screen", "Share my screen") goes to the host's page, which asks the house tile; the house answers allow,
   deny or "ask the host"; then the person sharing still decides, in their own prompt and the browser's
   picker.
4. **Open a tile for everyone** (`src/tile-strip.js`, `src/tile-records.js`, `src/hide-check.js`): done.
   Anyone pastes a tile's address; the host opens it, or the house sends a guest's request to the host
   ("Ask to open for everyone"). The host's page reads the tile's record once and sends its address and
   exact version (record CID) to everyone. Each person's page then checks it for itself (Raku's hide list
   and Bluesky's moderation, then that it's still the same version) and opens its own copy, every file
   checked against the record. Each person plays with their own copy; nothing in it is sent. At most 6
   tiles; the host's "Close for everyone", anyone's "Hide for me". Opening a tile while you present gives
   it the stage (your share stops).
   **4b. Preview first** (`src/tile-strip.js`): the address box only previews. The tile runs on your page
   alone ("Only you can see this"), after the same checks, with its author's handle (checked both ways, as
   Raku does; otherwise the DID) and size; then **Open for everyone** (the host) or **Ask to open for
   everyone** (a guest), or **Cancel**. The host can preview a guest's request from the approval card and
   Allow or Deny from the preview. What's sent is the version previewed (a request carries its CID, and the
   host's page refuses a newer one), and the preview becomes your card in place: the same frame, still
   running, so nothing loads twice and what you did in it stays.
5. **Live** (`site/`, `scripts/copy-to-site.mjs`): the page on thunderbird.cafe, a hidden page at
   https://thunderbird.cafe/webtiles/rooms-lab/, with the published house tile pinned and the relay on
   Fly.io. The steps are below ("Going live").
6. **Live tiles** (`src/live.js`, `tiles/poll/`): a tile opened for everyone can be **shared live with the
   room**: its copies then send each other what people do in them (a vote, a move). It's the "sync between
   tile instances in a chat" that the Web Tiles spec plans, tried early, as a capability the room grants;
   it follows the model webxdc apps use (copies of one app talking inside a chat), not webxdc's format. The
   host turns it on per tile ("Share live with the room"; a guest can "Ask to share live"), the house
   decides as for any request, and every card says "Shared live with the room". The first live tile is a
   **live poll** (`tiles/poll/`). See "Live tiles: how a tile talks to its other copies" below.
7. **TURN** (`relay/turn.js`, `src/mesh.js`): people on networks that block direct connections (many
   offices, some cafés and mobile networks) can now join. The browsers still try a direct connection first;
   when that's blocked they go through **Cloudflare's TURN relay**, which passes the media on still
   encrypted (Cloudflare sees addresses and timing, not what's said or shown). The TURN key stays on the
   relay (Fly secrets); each person who has joined a room gets credentials for 4 hours, and fresh ones
   before they run out. Each person in "Here" shows **direct** or **via relay**. Add **`&turn=only`** to a
   room link to send everything through TURN from that page (a test switch; never in the invite link). If
   TURN isn't available the room works as before, direct only, and the page says so. See "TURN" below.

## Try it on this computer

In `C:\thunderbird-cafe\rooms-lab` (after `npm install` once here, for the tile loader, and once in
`relay\`):

```
npm run dev
```

Then open http://127.0.0.1:5190/ in two windows (or two browsers), type a name in each, make a room in one
and open its invite link in the other. This runs the real relay code on this computer
(`ws://127.0.0.1:8787/`), letting in this page only. The host's page holds the house tile from
`tiles\house\` in a sealed frame; add `?house=off` to the host's address to try a room without one (the host
then approves each request). Three windows show the house best: a guest asking to see another guest's
screen goes to the host for approval.

To open a tile for everyone, paste its address under "Tiles opened for
everyone", click Preview, then Open for everyone in the preview. The box takes the forms Raku takes
(`src/address.js`, a copy of Raku's): `at://` with a handle or a DID (as Raku shows tiles), lexicographer.space
and appmosphe.re links (`/@handle/rkey`), webtil.es links, `tile://…` and `@handle/rkey`. A handle is turned
into its DID on your own page (it must point both ways); the room is only ever sent the DID form. Tiles open through the real tile loader
(`@dasl/tile-loader`, bundled by `serve.mjs`), so they load from `load.tiles.lexicographer.space` as on the
site. Without `npm install` here the page still runs, and says it can't open tiles. (The browser check opens
tiles through a stand-in for the loader, since it can't install it.)

On one computer both windows hear the same microphone, so expect echo: mute one, or use headphones.

TURN on this computer: the local relay has no TURN key, so the page shows "The fallback relay isn't
available right now…" and everyone connects directly (fine on one computer). To try the real Cloudflare TURN
locally, set the key in that PowerShell window first, then `npm run dev`:

```
$env:TURN_KEY_ID = "<the key id>"
$env:TURN_KEY_API_TOKEN = "<the API token>"
npm run dev
```

and add `&turn=only` to one window's room link: its people should show "via relay". (Close the window
afterwards: the key lives only in it.)

## Going live (build step 5)

In this order (as with the site's tables: **publish and pin before pushing**). Make an app password for
thunderbird.cafe first, and delete it after step 2.

1. **Commit this folder** (`commit-rooms-lab-step5.txt`).
2. **Publish the house tile**, in `C:\thunderbird-cafe\rooms-lab`: `node scripts/publish.mjs --dry-run`, then
   `node scripts/publish.mjs` (it asks for the app password itself, hidden). It writes `published.json`;
   commit it (`commit-rooms-lab-published.txt`).
3. **Deploy the relay**, in `C:\thunderbird-cafe\rooms-lab\relay`: see `relay/README.md`, "Deploying" (the
   Fly app, one machine, the Wix CNAME `relay.rooms`, the certificate). `https://relay.rooms.thunderbird.cafe/health`
   should show `ok`.
4. **Copy the page into the site**, in `C:\thunderbird-cafe\rooms-lab`:
   `node scripts/copy-to-site.mjs C:\thunderbird-cafe\pyxorium.github.io`. It stops if the house isn't
   published. It writes the site's `src\rooms-lab\` and `src\pages\webtiles\rooms-lab\index.astro` (edit them
   here, never there).
5. **Try it from the site's dev server**, in `C:\thunderbird-cafe\pyxorium.github.io`: `npm run dev`, then
   http://127.0.0.1:4321/webtiles/rooms-lab/ in two windows. It uses the real relay (127.0.0.1:4321 is let in)
   and the real loading server. Then `npm run build`.
6. **Push the site** (`commit-site-rooms-lab.txt` in the site folder), wait for the deploy, and open
   https://thunderbird.cafe/webtiles/rooms-lab/.
7. **The two-computer test** (plan section 1, "Done when").

After changing the page here: run `copy-to-site.mjs` again and push the site. After changing the house:
`node scripts/publish.mjs --again`, then `copy-to-site.mjs`, then push (the live page loads only the pinned
version; delete the old house record in PDSls once the new page is live).

## TURN (build step 7)

Most of the time voice and screens go directly between the computers. Some networks block that; then the
browsers fall back to a TURN server that passes the media on. The lab uses **Cloudflare's** (its Realtime
TURN service; 1,000 GB free each month, then $0.05 a GB, counting only what Cloudflare sends out).

- **The key stays on the relay** (Fly secrets `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`). A page that has
  joined a room asks the relay (`{ t: "ice" }`); the relay asks Cloudflare for credentials that last **4
  hours** and passes them on. The page asks again after 3 hours (or on its next rejoin), and its
  connections take the fresh ones in place, so nothing drops in a long meetup.
- **Limits** (credentials are worth money): only pages in a room; one ask every 10 minutes per connection,
  6 in all; 60 asks a minute for the whole relay. Set a low billing alert in Cloudflare too.
- **Connections wait** up to 4 seconds for the credentials before they start, so the first ones already
  know the TURN server; if the relay doesn't answer, they start with STUN only.
- **If TURN isn't available** (no secrets, or Cloudflare not answering), rooms work as before, direct
  only, and the page says: "The fallback relay isn't available right now, so people on strict networks may
  not be able to connect."
- **"direct" / "via relay"** next to each person in "Here": read from the browser's own connection
  statistics (the chosen pair of addresses uses a TURN address on either side, or not). Everyone sees it.
- **The test switch:** `&turn=only` at the end of a room link (`…#r=<code>&turn=only`) makes that page
  send everything through TURN, so you can prove TURN works between two ordinary computers. The page says
  it's on; the invite link it shows never carries it; with TURN unavailable it says it can't connect.
- Cloudflare's addresses on port 53 are left out (browsers block that port). TLS on port 443
  (`turns:…:443`) is kept: it's what gets through the strictest networks.

## Live tiles: how a tile talks to its other copies

Any tile can take part; nothing in its record changes. It talks with the page that holds it through
postMessage, under the tiles protocols' names (like `data.js`), version 1:

```
tile → page  { action: "tiles-protocol-up-live-payload",   payload: { v: 1, kind: "hello" } }
             { action: "tiles-protocol-up-live-payload",   payload: { v: 1, kind: "send", data } }
page → tile  { action: "tiles-protocol-down-live-payload", payload: { v: 1, kind: "presence", you, here, joined? } }
             { action: "tiles-protocol-down-live-payload", payload: { v: 1, kind: "message", n, from, data } }
             { action: "tiles-protocol-down-live-payload", payload: { v: 1, kind: "paused" | "resumed" } }
             { action: "tiles-protocol-down-live-payload", payload: { v: 1, kind: "limit", reason } }
```

- **hello**: "I speak live". The page answers with `presence`: your copy's id (`you`), the ids here
  (`here`), and who just came in or back (`joined`). Not shared live, `here` is just you, and your own
  messages come straight back: a room of one. The host's card shows "Share live with the room" only for a
  tile that has said hello.
- **send**: plain JSON, at most 16 KB, at most 10 a second (bursts of 30). Every copy, yours included, gets
  it as a `message`, numbered `n` in the room's one order, with `from` the sender's copy id. Copies that
  apply the same messages in the same order agree.
- **Ids** are random: one per person, per tile, per room. Never a name, handle or DID.
- **Catching up newcomers is the tile's job**: a copy that has been live sends its state when someone joins;
  a copy that just arrived waits a moment for it (the live poll shows one way).
- **paused / resumed**: the host's page is gone for a moment (and back). **limit**: your message didn't go
  out (`size`, `json`, `rate`, `room`, `paused` or `connection`).
- Outside a room (Raku, a gallery, a viewer) nobody answers: `tiles/poll/live-talk.js` plays the room of
  one after a moment, so the same tile works alone. **Copy that file into your tile** to make it live.

How the room carries it (`src/live.js`): only copies of the same pinned tile (address and record CID) talk.
Every message goes to the host's page, which checks it, numbers it and sends it to every copy; each
receiving page checks it again (from the host's page, a live tile, size and rate). Messages travel only over
the direct, encrypted connections between the computers (WebRTC data channels), never through the relay,
and nothing is kept: when the room ends, they're gone.

## What's in it

- `src/room-page.js`: the page. The lobby (your name, New room / Join room / Rejoin as host), the stage
  (the presenter's screen), Unmute and Share my screen, who's here (host, presenting, talking, each direct
  connection), "Ask to see screen", the host's approval cards (Allow / Deny), the sharer's prompt
  ("Choose what to share…" / Not now), the host's Remove and End room, and the room's messages (wishes,
  the house's decisions, answers), and the strip of tiles opened for everyone.
- `src/tile-strip.js`: the strip: each tile checked (hidden? same version?), then opened, newest first;
  and the private preview, which becomes the card in place when the tile is opened for everyone. Live
  tiles: the switch, "Ask to share live", "Stop sharing live" and the "Shared live with the room" badge.
- `src/live.js`: live tiles: the envelope, each copy's id, the hub on the host's page (one order, the
  limits: 16 KB a message, 10 a second per copy, 60 a second and 128 KB a second for the whole room), the
  checks on every receiving page, paused and resumed.
- `src/address.js`: what the address box accepts (a copy of the tile-address part of Raku's `address.js`).
- `src/tile-records.js`: a tile's record from its author's server (did:plc or did:web), a handle turned into
  its DID (both ways), and a file loader
  pinned to that record (every file checked by its content address; at most 50 MB a tile); the author's
  handle, shown only when it points back to the same account.
- `src/hide-check.js`: would Raku refuse it? The coded hide list from lexicographer.space and Bluesky's
  moderation, the same checks as Raku's (it never says which, or why).
- `src/house-bridge.js`: the host's page holding the house tile: fixed rules for what passes between them,
  and the fallback ("the host approves each request") when there's no house or it doesn't answer.
- `tiles/house/`: the house tile (`rules.js` holds the room's rules: "the host approves", now including
  live sharing: the host's own goes ahead, a guest's goes to the host). Its hello lists the requests it
  decides; the page decides any other itself, the same way. It runs only on the host's page, hidden. Opened
  on its own it shows its card.
- `tiles/poll/`: the live poll. Ask a question (or pick a ready-made one, `ready.js`); everyone votes, one
  vote each that you can change; the results update live. The first to ask owns the poll (only they close
  it or start a new one, unless they've left). `poll-state.js` is its logic (tested in Node); `live-talk.js`
  is the part any tile can copy.
- `scripts/make-card-art.py` draws the tiles' card pictures (`python3 scripts/make-card-art.py poll`);
  `scripts/publish.mjs` publishes the tiles from thunderbird.cafe (it asks for the app password itself,
  hidden): `node scripts/publish.mjs` publishes what isn't published yet, `node scripts/publish.mjs poll` only
  that one, `--dry-run` shows what it would do, `--again house` publishes that tile again as a new record.
  It writes `published.json`.
- `src/room-link.js`: the connection to the relay (joining, reconnecting, the host key, a relay restart).
- `src/mesh.js`: the connections between the computers (WebRTC), one to each other person: direct when
  they can be, through TURN otherwise; waits for the relay's TURN credentials; "direct" or "relay" per
  connection.
- `relay/turn.js`: TURN credentials from Cloudflare (on the relay; the key never reaches a page).
- `src/levels.js`: who's talking (measured on each computer; nothing sent).
- `src/presenting.js`: one presenter at a time, worked out the same way on every page.
- `src/messages.js`: what the pages say to each other, checked on arrival.
- `src/formats.js`, `src/config.js`: room codes, links (and the `&turn=only` switch), the relay address,
  STUN servers, timings.
- `src/room.css`: the look (Raku's palette), scoped to `.rl`.
- `dev/`: the dev page, `serve.mjs` (`npm run dev`), and `tile-host.js` (the tile loader, for the dev page).
- `site/`: what only the site's page has: `main.js` (the site's tile loader for the house and for tiles;
  the house pinned and checked), `page-csp.js` (the page's security policy) and `index.astro` (the page).
  `scripts/copy-to-site.mjs` copies them with the page modules into the site.
- `test/`: `npm test` (the page's pieces, its relay connection against the real relay, the house's
  rules, the bridge, publishing to a stand-in server, reading tile records, the hide list). The browser
  check, `test/browser/check_room.mjs`, runs three Chromium pages with a fake mic and screen (and stand-ins
  for the tiles' servers, with the real servers' CORS headers); it needs
  Playwright, which this folder doesn't install (it runs in the chat sandbox). `test/browser/check_site.mjs`
  checks the page the site's way: the house published (to a stand-in server) and pinned by
  `copy-to-site.mjs`, the site's entry point bundled with the real tile loader, the page's security policy,
  and the house and a tile running through a replica of the tile loading server (`test/loader-replica.mjs`),
  including the live poll shared live through the real loader. `test/browser/check_live.mjs` runs live
  tiles across four pages on the dev page (the real poll, every page's relay messages recorded).
  `test/browser/check_turn.mjs` runs TURN with a stand-in for Cloudflare's credentials API and a tiny real
  TURN server (`test/browser/turn-standin.mjs`, for the checks only), so Chromium really sends media through
  TURN with `&turn=only`.

## Consent and privacy

- A screen is only ever captured from a click by the person sharing ("Choose what to share…" in their own
  prompt, or the host's own "Share my screen"). Then the browser's own picker; its "Stop sharing" bar stays
  up while sharing. There's no message that makes another page share.
- The house only decides whether a request may go on to the person it's about. It can't start a share,
  and the page keeps the powers no house can override: the prompts, the picker, the call, ending the
  room, removing someone, stopping your own share. A page takes "someone asks to see your screen" and
  "you may present" only from the host's page.
- A tile opened for everyone runs on each person's own computer, in the tile loader's sealed frame, from
  its author's account. Each page checks it itself first, so nobody's page shows a tile Raku would hide,
  even if another page sends it. What anyone does in their copy stays on their computer, unless the host
  shares that tile live (every card then says "Shared live with the room").
- A tile shared live sends what people do in it to the other copies of the same tile only: through the
  host's page, directly between the computers (encrypted, never through the relay), with random ids
  instead of names, and nothing is kept.
- Microphones start off. The browser asks the first time you unmute.
- Nothing is recorded or stored. Names are typed and not checked.
- Voice and screens go directly between computers when they can. When a network blocks that, they pass
  through Cloudflare's TURN relay, still encrypted; Cloudflare sees addresses and timing, not what's said
  or shown. Each computer also asks a public STUN server (Google's or Cloudflare's) for its own address.
