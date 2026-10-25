# Rooms lab relay

The relay for the **Rooms lab**, the proof of concept at https://thunderbird.cafe/webtiles/rooms-lab/ (a
hidden page): small live rooms where friends talk, one person shares a screen, and a tile is opened for
everyone. The plan is `claude/rooms-lab-plan.md` in the project (build order step 1). It runs on Fly.io as its own small app, `thunderbird-rooms-relay`, at
**`wss://relay.rooms.thunderbird.cafe/`**, modelled on Daisy's relay (`C:\thunderbird-cafe\daisy-relay`),
which stays untouched.

It **introduces the people in a room to each other and passes their messages; it stores nothing**: nothing
on disk, no recording, nothing kept once a room ends. **Voice and screens never pass through it**: they go
directly between the computers (WebRTC, encrypted between the browsers), or, on networks that block that,
through Cloudflare's TURN relay, still encrypted; this relay only carries the setup messages (offers,
answers, network candidates) and the room's own messages (wishes, house decisions, tile shares), and hands
each page its TURN credentials (`turn.js`). While it runs, it knows who is in which room: a random id per
page and a typed name.

There's **no sign-in** in the lab: a room code stands in, and names are typed by people, **not verified**
(the page says so). Sign-in at the relay (an atproto service token, Colibri's pattern) comes later.

## Messages (JSON over WebSocket; `t` is the type)

Page to relay:

- `{ t: "join", room, peer, name, create?: true, hostKey? }`
  - `room`: a code the page makes, 10 to 64 letters, digits, `-` or `_` (random, at least 10).
  - `peer`: a random id per page load, 8 to 64 of the same characters.
  - `name`: typed, 1 to 40 characters, no control characters, not verified.
  - `create: true` makes the room; the maker is the **host** and gets a **host key**.
  - `hostKey`: the host coming back (see below).
- `{ t: "to", peer, data }`: to one person (WebRTC setup; wish prompts).
- `{ t: "all", data }`: to everyone else in the room (house decisions; tile shares).
- `{ t: "remove", peer }`: host only; that person is taken out.
- `{ t: "end" }`: host only; the room ends for everyone.
- `{ t: "ice" }` (exactly that): TURN credentials, for a page in a room (step 7).

Relay to page:

- `{ t: "joined", room, peer, host, hostKey? }` (the key only to the host).
- `{ t: "peers", list: [{ peer, name, host, away? }] }`: to everyone, whenever someone comes or goes
  (everyone sees who's here; no hidden watchers).
- `{ t: "from", peer, data, all? }`: a message, with who sent it (`all: true` if it went to everyone).
- `{ t: "full" }` (6 people already), `{ t: "replaced" }` (closed 4002), `{ t: "removed" }` (closed 4001),
  `{ t: "ended", why: "host" | "host gone" }` (closed 4000).
- `{ t: "ice", servers: [{ urls, username?, credential? }], ttl: 14400 }`: Cloudflare TURN credentials for 4
  hours (port 53 addresses left out), or `{ t: "ice", none: "off" }` (no TURN key here) or
  `{ t: "ice", none: "unavailable" }` (Cloudflare didn't answer, or the relay's cap was reached).
- `{ t: "error", why }`, where `why` is one of: `room`, `peer`, `name`, `host key`, `no room`, `room taken`,
  `peer taken`, `already joined`, `join a room first`, `not here`, `to yourself`, `not yourself`,
  `host only`, `data`, `unknown type`, `not JSON`, `not a message`, `not text`, `too big`, `too many`,
  `ice too soon`.

## The host and the grace period

- The host key is random (32 bytes), made by the relay unless the page brings one, and kept only in the
  host's browser (and its private host link).
- If the host's connection drops, everyone stays and the host shows in the list with `away: true` ("Waiting
  for Nick to come back…"). Joining with the host key within **about a minute** makes that page the host
  again (a reload brings a new peer id; that's fine). Otherwise the room ends: `ended`, why `host gone`.
- During the wait, guests still reach each other (a screen already being shared carries on); the page
  decides no new wishes.
- The host key joining while the host is still connected (another tab, or a connection the relay hasn't
  yet noticed is dead) moves the host there; the older connection hears `replaced`.
- **A relay restart** (a deploy, or waking from sleep) empties every room. The host's page joins again with
  `create: true` and its host key, which makes the room again with the same key; guests' joins meanwhile
  get `no room`, and their pages try again a little later.
- A guest's peer id already in the room is refused (`peer taken`) rather than replacing anyone, since ids
  are visible to everyone in the room. The page picks a new id and joins again.
- Someone removed can join again with the room code (no sign-in, so no bans in the lab): the host can
  remove them again or end the room.

## Files

- `rooms.js`: the rules (rooms, the host and its grace period, passing messages, limits), with no network
  parts, so a stand-in relay for the browser checks (build step 2) can run the same rules.
- `server.js`: the network around it, with the `ws` package: `GET /health`, the origin check, limits
  (connections in all and per address, frame size, joining within 30 s, too many mistakes), a heartbeat that
  finds dead connections (every 20 s), the grace-period sweep (every 5 s), and a clean stop (each page hears
  1012 and reconnects at once).
- `turn.js`: TURN credentials from Cloudflare (`POST https://rtc.live.cloudflare.com/v1/turn/keys/<key
  id>/credentials/generate-ice-servers`, 4 hours), checked and trimmed; null when switched off or failing.
- `fly.toml`, `Dockerfile`, `.dockerignore`: the Fly app.
- `test/rooms.test.mjs` (the rules, with a clock the tests move), `test/server.test.mjs` (the network
  layer over real WebSockets, and the Fly files) and `test/turn.test.mjs` (TURN: Cloudflare's answer, who
  gets credentials, the limits, rooms carrying on without TURN).

## Run the tests

In `C:\thunderbird-cafe\rooms-lab\relay`:

```
npm install
npm test
```

36 tests, a few seconds. Needs Node 22 or later. The first `npm install` may refresh
`package-lock.json` (written by hand in the chat, which has no npm registry); if it changes, it goes into
the next commit. After that, `npm ci`.

## Run it locally

In `C:\thunderbird-cafe\rooms-lab\relay`:

```
npm start
```

It listens on `ws://127.0.0.1:8080/` (pages allowed from `https://thunderbird.cafe` only, unless you set
`ALLOWED_ORIGINS`, e.g. `$env:ALLOWED_ORIGINS = "http://127.0.0.1:4321"` first).

## Settings

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | Listen port |
| `ALLOWED_ORIGINS` | `https://thunderbird.cafe` | Pages allowed to connect, comma-separated (`*` for any). In `fly.toml`: thunderbird.cafe and `http://127.0.0.1:4321` (the site's dev server). Raku's origin is added when rooms move there. A client that isn't a browser sends no origin and is let in: the check is a courtesy, not a lock. |
| `MAX_CONNECTIONS` | 300 | Connections in all |
| `MAX_PER_IP` | 20 | Connections per address (Fly's `fly-client-ip` header) |
| `TURN_KEY_ID` | (none) | Cloudflare TURN key id. **A Fly secret**, never in `fly.toml` |
| `TURN_KEY_API_TOKEN` | (none) | That key's API token. **A Fly secret**, never in `fly.toml` or a commit |

The other limits are `DEFAULTS` in `server.js` and `LIMITS` in `rooms.js`: 64 KB a message; at most 6 people
a room; per connection 200 messages at once, then 50 a second (a new call sends bursts of network
candidates); the host's grace period, 60 seconds. TURN: one ask every 10 minutes per connection, 6 in all,
60 a minute for the whole relay, only from pages in a room. Without both TURN secrets, TURN is off (the
startup line says which).

**Logs:** a startup line, and now and then a counts line (`rooms 1, connections 3`). Never messages, room
codes, names or addresses.

## Deploying (the owner's step, build order step 5)

In `C:\thunderbird-cafe\rooms-lab\relay`, the first time:

```
fly apps create thunderbird-rooms-relay
fly deploy --ha=false
fly status
```

After that, only `fly deploy --ha=false`.

**Always exactly one machine.** The rooms live in one process's memory; with two machines, the people in a
room could land on different machines and never meet. `fly status` must list **one** machine. If it lists
two: `fly scale count 1`.

**It sleeps when idle** (`min_machines_running = 0`; owner, Oct 23). Fly stops the machine only when no
connection is open (an open WebSocket counts), so a room in use keeps it awake; the first page after a
sleep waits a second or two while it starts. Part of the Dec 18 2026 review of the Fly apps.

**The address:** `relay.rooms.thunderbird.cafe`. At Wix, a CNAME record `relay.rooms` pointing to
`thunderbird-rooms-relay.fly.dev` (Wix has no AAAA records), then `fly certs add relay.rooms.thunderbird.cafe`
and `fly certs show relay.rooms.thunderbird.cafe` until it's issued.

**TURN (step 7):** in Cloudflare, make a TURN key (Realtime → TURN), then here:

```
fly secrets set TURN_KEY_ID=<the key id> TURN_KEY_API_TOKEN=<the API token> --stage
fly deploy --ha=false
```

`--stage` keeps the secrets for the next deploy instead of restarting at once. `fly logs` should then show
`TURN on (Cloudflare)` in the startup line. To switch TURN off: `fly secrets unset TURN_KEY_ID`. To change
the key: make a new one in Cloudflare, `fly secrets set` again, then delete the old key there.

**Roll back:** `git revert HEAD`, then `fly deploy --ha=false`.

## Checking it live

- `https://relay.rooms.thunderbird.cafe/health` shows `ok` (the first visit after a sleep takes a moment).
- `fly logs` shows the startup line (with `TURN on (Cloudflare)` once the secrets are set) and counts.
