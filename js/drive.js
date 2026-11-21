/* remini cloud: Google sign-in (Google Identity Services, token model) and read-only Drive calls.
 * The access token lives only in memory, never in storage. It lasts about an hour; after that, or after
 * any 401, the app shows "Tap to continue", and only that tap opens Google's window. */

const GIS_SRC = 'https://accounts.google.com/gsi/client';
const API = 'https://www.googleapis.com/drive/v3/files';
const EARLY_MS = 60 * 1000; // treat the token as expired a minute early

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

/** status: 'loading' (Google's sign-in code not ready) | 'signed-out' | 'ok' | 'expired' | 'unavailable' */
export function createAuth({ clientId, scope, onChange }) {
  const s = { status: 'loading', token: null, expiresAt: 0, client: null, timer: null, error: null, hint: '' };
  const emit = () => { try { onChange(s.status, s.error); } catch (e) { /* ignore */ } };
  const set = (status, error = null) => { s.status = status; s.error = error; emit(); };

  function onToken(resp) {
    if (!resp || resp.error || !resp.access_token) {
      set(s.token ? 'ok' : (s.hadToken ? 'expired' : 'signed-out'), resp && resp.error ? 'refused' : 'failed');
      return;
    }
    const g = window.google && window.google.accounts && window.google.accounts.oauth2;
    if (g && g.hasGrantedAllScopes && !g.hasGrantedAllScopes(resp, scope)) {
      set(s.hadToken ? 'expired' : 'signed-out', 'scope');
      return;
    }
    s.token = resp.access_token;
    s.hadToken = true;
    s.expiresAt = Date.now() + Math.max(60, Number(resp.expires_in) || 3600) * 1000 - EARLY_MS;
    clearTimeout(s.timer);
    s.timer = setTimeout(expire, Math.max(1000, s.expiresAt - Date.now()));
    set('ok');
  }
  function onError(err) { // the window was closed, or a popup blocker stepped in
    const type = err && err.type;
    set(s.token ? 'ok' : (s.hadToken ? 'expired' : 'signed-out'), type === 'popup_closed' ? 'closed' : 'failed');
  }
  function expire() {
    if (!s.token) return;
    s.token = null;
    set('expired');
  }

  function init() {
    if (!clientIdLooksSet(clientId)) { set('unavailable', 'no-client-id'); return; }
    const ready = () => {
      try {
        s.client = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId, scope, callback: onToken, error_callback: onError,
        });
        set(s.hadToken ? 'expired' : 'signed-out');
      } catch (e) { set('unavailable', 'gis-failed'); }
    };
    if (window.google && window.google.accounts && window.google.accounts.oauth2) { ready(); return; }
    let script = document.querySelector(`script[src="${GIS_SRC}"]`);
    if (!script) {
      script = document.createElement('script');
      script.src = GIS_SRC;
      script.async = true;
      document.head.append(script);
    }
    script.addEventListener('load', ready, { once: true });
    script.addEventListener('error', () => set('unavailable', 'gis-offline'), { once: true });
  }

  return {
    init,
    get status() { return s.status; },
    get error() { return s.error; },
    /** Call ONLY from a tap (click handler) so the browser allows Google's window. */
    request({ chooseAccount = false } = {}) {
      if (!s.client) return false;
      const opts = { prompt: chooseAccount ? 'select_account' : '' };
      if (s.hint && !chooseAccount) opts.login_hint = s.hint;
      s.client.requestAccessToken(opts);
      return true;
    },
    setHint(email) { s.hint = email || ''; },
    markReturning() { s.hadToken = true; if (s.status === 'signed-out') set('expired'); },
    token() {
      if (s.token && Date.now() < s.expiresAt) return s.token;
      if (s.token) expire();
      return null;
    },
    invalidate() { if (s.token) { s.token = null; clearTimeout(s.timer); set('expired'); } },
    signOut() {
      const t = s.token;
      s.token = null;
      s.hadToken = false;
      clearTimeout(s.timer);
      try { if (t && window.google) window.google.accounts.oauth2.revoke(t, () => {}); } catch (e) { /* ignore */ }
      set(s.client ? 'signed-out' : s.status);
    },
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Read-only Drive calls with the in-memory token. */
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
