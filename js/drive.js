/* remini cloud: Google sign-in and read-only Drive calls.
 * Sign-in uses Google's OAuth 2.0 "implicit grant" with a full-page redirect (no pop-up windows, no
 * Google script on the page): the page goes to Google, and Google sends it back to /remini/ with a
 * short-lived access token in the address (#access_token=...). The token is then kept only in
 * sessionStorage (this browser tab/app session), removed from the address straight away, and expires
 * within about an hour. When it runs out, remini first asks Google quietly (prompt=none); if Google
 * needs the user, a "Tap to continue" button does the normal sign-in. */

const API = 'https://www.googleapis.com/drive/v3/files';
export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const EARLY_MS = 60 * 1000;          // treat the token as expired a minute early
const SILENT_GAP_MS = 2 * 60 * 1000; // never try the quiet sign-in more than once every 2 minutes
export const KEYS = {
  token: 'remini:token',             // sessionStorage: { t, exp }
  state: 'remini:oauth_state',       // sessionStorage: the random value we expect back
  silent: 'remini:oauth_silent',     // sessionStorage: { at } of the last quiet attempt
  view: 'remini:return_view',        // sessionStorage: the screen to come back to (#/library?..., #/photo/id)
  email: 'remini:last_email',        // localStorage: the account last used on this device (a hint for Google)
};
const SILENT_ERRORS = new Set(['interaction_required', 'login_required', 'consent_required', 'account_selection_required']);

export class AuthNeeded extends Error {
  constructor() { super('Sign-in needed'); this.name = 'AuthNeeded'; }
}
export class NotFound extends Error {
  constructor() { super('Not found'); this.name = 'NotFound'; }
}
export class Offline extends Error {
  constructor() { super("Couldn't reach Google right now."); this.name = 'Offline'; }
}

export const clientIdLooksSet = id => typeof id === 'string' && /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id);

/** The address of Google's sign-in page. prompt: '' (normal), 'none' (quiet) or 'select_account'. */
export function buildAuthUrl({ clientId, redirectUri, scope, state, loginHint, prompt }) {
  const p = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'token', scope,
    include_granted_scopes: 'true', state,
  });
  if (loginHint) p.set('login_hint', loginHint);
  if (prompt) p.set('prompt', prompt);
  return `${AUTH_URL}?${p}`;
}

/** What Google put after the # when it sent the page back, or null if it is an ordinary address. */
export function parseRedirect(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  if (!/(^|&)(access_token|error)=/.test(raw)) return null;
  const p = new URLSearchParams(raw);
  return {
    token: p.get('access_token'), expiresIn: Number(p.get('expires_in')) || 0, state: p.get('state') || '',
    scope: p.get('scope') || '', error: p.get('error'),
  };
}

function randomState() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function windowEnv() {
  const safe = (store, fn) => { try { return fn(store()); } catch (e) { return null; } };
  const ss = () => window.sessionStorage, ls = () => window.localStorage;
  return {
    hash: () => location.hash,
    base: () => location.pathname + location.search,
    replaceHash: h => history.replaceState(history.state, '', location.pathname + location.search + (h || '')),
    go: url => location.assign(url),
    sGet: k => safe(ss, s => s.getItem(k)), sSet: (k, v) => safe(ss, s => s.setItem(k, v)), sDel: k => safe(ss, s => s.removeItem(k)),
    lGet: k => safe(ls, s => s.getItem(k)), lSet: (k, v) => safe(ls, s => s.setItem(k, v)), lDel: k => safe(ls, s => s.removeItem(k)),
    now: () => Date.now(),
    online: () => navigator.onLine !== false,
    revoke: t => fetch(REVOKE_URL, { method: 'POST', mode: 'no-cors', credentials: 'omit',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${encodeURIComponent(t)}` }).catch(() => {}),
  };
}

/**
 * status: 'signed-out' (never signed in here) | 'ok' | 'expired' (needs "Tap to continue") | 'unavailable'
 * error:  null | 'refused' | 'failed' | 'state' | 'scope' | 'no-client-id'
 */
export function createAuth({ clientId, scope, redirectUri, onChange, env = windowEnv() }) {
  const s = { status: 'signed-out', token: null, expiresAt: 0, timer: null, error: null, returned: false };
  const emit = () => { try { onChange(s.status, s.error); } catch (e) { /* ignore */ } };
  const set = (status, error = null) => { s.status = status; s.error = error; emit(); };
  const known = () => !!env.lGet(KEYS.email);

  function keep(token, expiresAt) {
    s.token = token;
    s.expiresAt = expiresAt;
    env.sSet(KEYS.token, JSON.stringify({ t: token, exp: expiresAt }));
    clearTimeout(s.timer);
    s.timer = setTimeout(expire, Math.max(1000, Math.min(expiresAt - env.now(), 2 ** 31 - 1)));
  }
  function drop() {
    s.token = null;
    s.expiresAt = 0;
    clearTimeout(s.timer);
    env.sDel(KEYS.token);
  }
  function expire() {
    if (!s.token) return;
    drop();
    set('expired');
  }

  /** Reads Google's answer if the page just came back from sign-in, then removes it from the address. */
  function readRedirect() {
    const r = parseRedirect(env.hash());
    if (!r) return false;
    const expected = env.sGet(KEYS.state);
    const view = env.sGet(KEYS.view) || '';
    const silent = (() => { try { return JSON.parse(env.sGet(KEYS.silent) || 'null'); } catch (e) { return null; } })();
    env.sDel(KEYS.state);
    env.sDel(KEYS.view);
    env.replaceHash(/^#\//.test(view) ? view : '#/library'); // the token never stays in the address bar
    s.returned = true;
    if (!expected || r.state !== expected) { s.error = 'state'; return true; }
    if (r.error) {
      if (silent && SILENT_ERRORS.has(r.error)) s.error = null;      // Google needs the user: show "Tap to continue"
      else s.error = r.error === 'access_denied' ? 'refused' : 'failed';
      return true;
    }
    if (!r.token) { s.error = 'failed'; return true; }
    if (r.scope && !r.scope.split(/\s+/).includes(scope)) { s.error = 'scope'; return true; }
    env.sDel(KEYS.silent);
    keep(r.token, env.now() + Math.max(60, r.expiresIn || 3600) * 1000 - EARLY_MS);
    return true;
  }

  function init() {
    if (!clientIdLooksSet(clientId)) { set('unavailable', 'no-client-id'); return; }
    readRedirect();
    if (!s.token) {
      try {
        const saved = JSON.parse(env.sGet(KEYS.token) || 'null');
        if (saved && saved.t && saved.exp > env.now()) keep(saved.t, saved.exp);
        else env.sDel(KEYS.token);
      } catch (e) { env.sDel(KEYS.token); }
    }
    const err = s.error;
    if (s.token) set('ok');
    else set(known() ? 'expired' : 'signed-out', err);
  }

  function go(prompt) {
    const state = randomState();
    env.sSet(KEYS.state, state);
    const h = env.hash();
    env.sSet(KEYS.view, parseRedirect(h) ? '#/library' : (h || '#/library'));
    if (prompt === 'none') env.sSet(KEYS.silent, JSON.stringify({ at: env.now() }));
    else env.sDel(KEYS.silent);
    const hint = prompt === 'select_account' ? '' : (env.lGet(KEYS.email) || '');
    env.go(buildAuthUrl({ clientId, redirectUri, scope, state, loginHint: hint, prompt: prompt || '' }));
    return true;
  }

  return {
    init,
    get status() { return s.status; },
    get error() { return s.error; },
    /** True when this page load is Google sending the user back (successfully or not). */
    get returned() { return s.returned; },
    /** Goes to Google's sign-in page (the whole page; remini comes back to the same screen). */
    request({ chooseAccount = false } = {}) {
      if (s.status === 'unavailable') return false;
      return go(chooseAccount ? 'select_account' : '');
    },
    /** If the sign-in ran out but this device has signed in before, ask Google quietly (no screens).
     *  Returns true when the page is on its way to Google. */
    trySilent() {
      if (s.token || s.status === 'unavailable' || !known() || !env.online() || s.returned) return false;
      try {
        const last = JSON.parse(env.sGet(KEYS.silent) || 'null');
        if (last && env.now() - last.at < SILENT_GAP_MS) return false;
      } catch (e) { /* try again */ }
      return go('none');
    },
    /** Remembers the home account (from the photo list) so Google can skip asking which account. */
    rememberEmail(email) { if (email && email.includes('@')) env.lSet(KEYS.email, email); },
    token() {
      if (s.token && env.now() < s.expiresAt) return s.token;
      if (s.token) expire();
      return null;
    },
    invalidate() { if (s.token) { drop(); set('expired'); } },
    signOut() {
      const t = s.token;
      drop();
      env.lDel(KEYS.email);
      env.sDel(KEYS.silent);
      if (t) env.revoke(t);
      set('signed-out');
    },
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Read-only Drive calls with the current access token. */
export function driveApi(auth, catalogName) {
  async function call(url, { signal, as = 'json' } = {}) {
    for (let attempt = 0; ; attempt++) {
      const token = auth.token();
      if (!token) throw new AuthNeeded();
      let res;
      try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal, cache: 'no-store',
          credentials: 'omit', referrerPolicy: 'no-referrer' });
      } catch (e) {
        if (e && e.name === 'AbortError') throw e;
        throw new Offline();
      }
      if (res.status === 401) { auth.invalidate(); throw new AuthNeeded(); }
      if (res.status === 404) throw new NotFound();
      if ((res.status === 429 || res.status === 403 || res.status >= 500) && attempt < 3) {
        if (res.status === 403) { // only retry Google's "slow down" answers
          const body = await res.clone().json().catch(() => null);
          const reason = body && body.error && body.error.errors && body.error.errors[0] && body.error.errors[0].reason;
          if (!/rateLimitExceeded|userRateLimitExceeded/.test(reason || '')) throw new Error(`Drive said ${res.status}`);
        }
        await sleep(800 * 2 ** attempt + Math.random() * 400);
        continue;
      }
      if (!res.ok) throw new Error(`Drive said ${res.status}`);
      return as === 'blob' ? res.blob() : res.json();
    }
  }
  return {
    demo: false,
    ready: () => !!auth.token(),
    async findCatalog() {
      const q = `name='${catalogName}' and trashed=false`;
      const url = `${API}?q=${encodeURIComponent(q)}&fields=${encodeURIComponent('files(id,modifiedTime)')}`
        + `&orderBy=${encodeURIComponent('modifiedTime desc')}&pageSize=10&spaces=drive`
        + '&includeItemsFromAllDrives=true&supportsAllDrives=true';
      const data = await call(url);
      const files = (data && data.files) || [];
      return files.length ? { id: files[0].id, modifiedTime: files[0].modifiedTime || '' } : null;
    },
    downloadCatalog: id => call(`${API}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`),
    fileBlob: (id, signal) => call(`${API}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { signal, as: 'blob' }),
  };
}

/** ?demo=1: the bundled made-up catalog and pictures. Never talks to Google.
 * With many = true (?demo=1&many=1) the 30 demo items are repeated 200 times, to try out a big library. */
export function demoApi(base, many = false) {
  const fileUrl = id => {
    const m = /^demo-(?:th|pv|f)-(\d+)$/.exec(id || '');
    return m ? new URL(`demo/img/${m[1]}.svg`, base).href : null;
  };
  async function get(url, as, signal) {
    let res;
    try { res = await fetch(url, { signal, cache: 'no-store' }); } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new Offline();
    }
    if (res.status === 404) throw new NotFound();
    if (!res.ok) throw new Error(`demo file ${res.status}`);
    return as === 'blob' ? res.blob() : res.json();
  }
  const catalogUrl = new URL('demo/catalog.json', base).href;
  return {
    demo: true,
    ready: () => true,
    async findCatalog() {
      const c = await get(catalogUrl, 'json');
      return { id: many ? 'demo-catalog-many' : 'demo-catalog', modifiedTime: c.generated_utc || '' };
    },
    async downloadCatalog() {
      const c = await get(catalogUrl, 'json');
      if (many) {
        const base30 = c.items;
        c.items = [];
        for (let k = 0; k < 200; k++) for (const it of base30) c.items.push({ ...it, id: `${it.id}-${k}`, n: `${k}-${it.n}` });
      }
      return c;
    },
    fileBlob(id, signal) {
      const u = fileUrl(id);
      if (!u) return Promise.reject(new NotFound());
      return get(u, 'blob', signal);
    },
  };
}
