// page-csp.js: the Rooms lab page's security policy, a <meta> tag on the built page only (GitHub Pages
// can't send headers; Astro's dev server adds inline scripts of its own). As Daisy's page:
//   connections: the relay (wss://relay.rooms.thunderbird.cafe/), and lookups over https (plc.directory,
//     each tile author's own server, Bluesky's public API, the hide list at lexicographer.space);
//   frames: only the tile loading server (each tile on its own random name under it);
//   media: voice and screens arrive as streams (no addresses to allow); nothing else is loaded.
// The page passes the site's loading server (src/lib/tile-load-domain.js), so this file stands alone.
export function pageCsp(loadDomain) {
  const base = loadDomain.replace(/^load\./, '');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob:",
    "connect-src 'self' https: wss:",
    `frame-src https://${loadDomain} https://*.${base}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
}
