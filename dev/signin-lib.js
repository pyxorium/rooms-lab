// dev/signin-lib.js: the sign-in library for the lab's own dev page, bundled by serve.mjs after `npm install`
// in this folder (it adds @atproto/oauth-client-browser 0.5.8, for development only; the site has its own).
export { BrowserOAuthClient, LoginContinuedInParentWindowError } from '@atproto/oauth-client-browser';
