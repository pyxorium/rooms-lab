// oauth-standin.mjs: a do-nothing stand-in for @atproto/oauth-client-browser, for check_site.mjs only (the site
// check is about the tile loader and the pinned house; sign-in is checked in check_signin.mjs, with a fuller
// stand-in). It loads, finds nobody signed in, and signs nobody in.
export class LoginContinuedInParentWindowError extends Error {}
export class BrowserOAuthClient {
  static async load() { return new BrowserOAuthClient(); }
  async init() { return {}; }
  addEventListener() {}
  async restore() { throw new Error('nobody is signed in here'); }
  async revoke() {}
  async signInPopup() { throw new Error('no sign-in in this check'); }
}
