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
   picker. Not published yet (step 5).
4. Open a tile for everyone (next).
5. Live: the house tile published, the relay deployed, the page on thunderbird.cafe.

## Try it on this computer

In `C:\thunderbird-cafe\rooms-lab` (after `npm install` once in `relay\`):

```
npm run dev
```

Then open http://127.0.0.1:5190/ in two windows (or two browsers), type a name in each, make a room in one
and open its invite link in the other. This runs the real relay code on this computer
(`ws://127.0.0.1:8787/`), letting in this page only. The host's page holds the house tile from
`tiles\house\` in a sealed frame; add `?house=off` to the host's address to try a room without one (the host
then approves each request). Three windows show the house best: a guest asking to see another guest's
screen goes to the host for approval.

On one computer both windows hear the same microphone, so expect echo: mute one, or use headphones.

## What's in it

- `src/room-page.js`: the page. The lobby (your name, New room / Join room / Rejoin as host), the stage
  (the presenter's screen), Unmute and Share my screen, who's here (host, presenting, talking, each direct
  connection), "Ask to see screen", the host's approval cards (Allow / Deny), the sharer's prompt
  ("Choose what to share…" / Not now), the host's Remove and End room, and the room's messages (wishes,
  the house's decisions, answers).
- `src/house-bridge.js`: the host's page holding the house tile: fixed rules for what passes between them,
  and the fallback ("the host approves each request") when there's no house or it doesn't answer.
- `tiles/house/`: the house tile (`rules.js` holds the room's rules: "the host approves"). It runs only on
  the host's page, hidden. Opened on its own it shows its card. `scripts/make-card-art.py` draws its
  pictures; `scripts/publish.mjs` publishes it from thunderbird.cafe (step 5; it asks for the app password
  itself, hidden; `--dry-run`, `--again`) and writes `published.json`.
- `src/room-link.js`: the connection to the relay (joining, reconnecting, the host key, a relay restart).
- `src/mesh.js`: the direct connections between the computers (WebRTC), one to each other person.
- `src/levels.js`: who's talking (measured on each computer; nothing sent).
- `src/presenting.js`: one presenter at a time, worked out the same way on every page.
- `src/messages.js`: what the pages say to each other, checked on arrival.
- `src/formats.js`, `src/config.js`: room codes, links, the relay address, STUN servers, timings.
- `src/room.css`: the look (Raku's palette), scoped to `.rl`.
- `dev/`: the dev page and `serve.mjs` (`npm run dev`).
- `test/`: `npm test` (the page's pieces, its relay connection against the real relay, the house's
  rules, the bridge, publishing to a stand-in server). The browser
  check, `test/browser/check_room.mjs`, runs three Chromium pages with a fake mic and screen; it needs
  Playwright, which this folder doesn't install (it runs in the chat sandbox).

## Consent and privacy

- A screen is only ever captured from a click by the person sharing ("Choose what to share…" in their own
  prompt, or the host's own "Share my screen"). Then the browser's own picker; its "Stop sharing" bar stays
  up while sharing. There's no message that makes another page share.
- The house only decides whether a request may go on to the person it's about. It can't start a share,
  and the page keeps the powers no house can override: the prompts, the picker, the call, ending the
  room, removing someone, stopping your own share. A page takes "someone asks to see your screen" and
  "you may present" only from the host's page.
- Microphones start off. The browser asks the first time you unmute.
- Nothing is recorded or stored. Names are typed and not checked.
- Voice and screens go directly between the computers, encrypted by the browsers. Each computer asks a
  public STUN server (Google's or Cloudflare's) for its own address. No TURN server yet: networks that
  block direct connections can't join the call.
