// dev/tile-host.js: the tile loader for the lab's dev page, bundled by dev/serve.mjs (esbuild) when
// `npm install` has been run in C:\thunderbird-cafe\rooms-lab (it adds @dasl/tile-loader and esbuild, dev only).
// The same official loader as Raku and the site: each tile runs in a sealed frame on the loading server
// (load.tiles.lexicographer.space, a fresh name per tile). The room page hands it a path loader that only
// serves the record's files, each checked against its content address (src/tile-records.js).
import { TileMothership, Tile } from '@dasl/tile-loader';

export function makeTileHost({ loadDomain = 'load.tiles.lexicographer.space' } = {}) {
  const mothership = new TileMothership({ loadDomain });
  mothership.init();
  return {
    render({ uri, manifest, loader, height }) {
      const frame = new Tile(mothership, uri, manifest, loader).renderContent(height);
      frame.removeAttribute('style');
      frame.setAttribute('allow', '');                    // no camera, microphone, location… for tiles (as Raku)
      frame.setAttribute('referrerpolicy', 'no-referrer');
      return frame;
    },
  };
}
