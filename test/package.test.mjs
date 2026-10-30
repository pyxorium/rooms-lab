// package.test.mjs: rooms-lab as a package (0.11.0): Raku takes it from GitHub, pinned to a tag
// (claude/raku-rooms-plan.md, RR1), and imports only what `exports` names. npm packs a git dependency with
// the `files` list, so every exported file must be inside it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const inFiles = (path) => pkg.files.some((f) => (f.endsWith('/') ? path.startsWith(f) : path === f)) || path === 'package.json';

test('every exported file exists and is in the files npm packs; the room page, its look, the formats and the house pin are exported', () => {
  assert.ok(pkg.exports && typeof pkg.exports === 'object');
  for (const [name, target] of Object.entries(pkg.exports)) {
    assert.match(target, /^\.\//, name);
    const path = target.slice(2);
    assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), `${name} → ${target} exists`);
    assert.ok(inFiles(path), `${target} is in "files"`);
  }
  for (const name of ['./room-page.js', './room.css', './formats.js', './config.js', './published.json']) assert.ok(pkg.exports[name], name);
  // The relay, the tiles, the scripts and the tests stay out of what Raku downloads.
  for (const path of ['relay/server.js', 'tiles/house/index.html', 'scripts/publish.mjs', 'test/package.test.mjs', 'site/main.js']) assert.ok(!inFiles(path), path);
});

test('the room page imports nothing outside src/ (so the packed copy runs as it is)', () => {
  const src = readFileSync(new URL('../src/room-page.js', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 5);
  for (const i of imports) assert.match(i, /^\.\/[a-z-]+\.js$/, i);
});

test('the hosting hooks are there (Raku): its own join screen, links, no lab chrome, joined / people / over', async () => {
  const page = await import('../src/room-page.js');
  assert.equal(typeof page.mountRoomPage, 'function');
  assert.equal(page.NAME_KEY, 'rooms-lab-name');
  const store = new Map();
  const session = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  page.keepHostKey(session, 'abcdefghijkm', 'k'.repeat(40));
  assert.equal(page.keptHostKey(session, 'abcdefghijkm'), 'k'.repeat(40));
  assert.equal(store.get('rooms-lab-host:abcdefghijkm'), 'k'.repeat(40), 'the same key the room itself keeps');
  page.keepHostKey(session, 'abcdefghijkm', null);
  assert.equal(page.keptHostKey(session, 'abcdefghijkm'), null);
  const src = readFileSync(new URL('../src/room-page.js', import.meta.url), 'utf8');
  for (const hook of ['joinScreen', 'links', 'chrome', 'turnOnly', 'onJoined', 'onPeople', 'onOver']) assert.match(src, new RegExp(`\\b${hook}:`), hook);
  // A host page's address is never read or rewritten by the room.
  assert.match(src, /const ownAddress = !o\.links && !o\.joinScreen;/);
  assert.match(src, /if \(ownAddress\) \{ try \{ o\.history\?\.replaceState/);
});
