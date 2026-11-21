/* remini cloud: pure logic (no DOM, no network). Tested on its own by tests/web/logic_test.js. */

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DIRECT_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const BIG_PHOTO_BYTES = 10 * 1024 * 1024;
const GB = 1024 ** 3;
const DRIVE_ID = /^[A-Za-z0-9_-]{1,200}$/;

// ---------- small formatting helpers ----------
export const pad2 = n => String(n).padStart(2, '0');
export const fmtNum = n => Number(n || 0).toLocaleString('en-US');
export const plural = (n, one, many) => `${fmtNum(n)} ${n === 1 ? one : many}`;
export const itemsWord = n => (n === 1 ? '1 photo or video' : `${fmtNum(n)} photos and videos`);

export function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

/** "Saturday 24 December 2020", plus ", 11:31" when withTime. Uses the phone's own time zone. */
export function dateWords(d, withTime) {
  const s = `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return withTime ? `${s}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : s;
}
export const shortDate = d => `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;

export function timeAgo(d, now = Date.now()) {
  const mins = Math.floor((now - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return plural(mins, 'minute ago', 'minutes ago');
  const hours = Math.floor(mins / 60);
  if (hours < 24) return plural(hours, 'hour ago', 'hours ago');
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 45) return `${days} days ago`;
  return `on ${shortDate(d)}`;
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(x)}` : `${m}:${pad2(x)}`;
}
export function fmtSize(bytes) {
  if (bytes == null || !isFinite(bytes)) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < GB) return `${(bytes / 1048576).toFixed(1)} MB`;
  return fmtGB(bytes);
}
export function fmtGB(bytes) {
  const b = Number(bytes) || 0;
  if (b < GB) return `${Math.round(b / 1048576)} MB`;
  const v = b / GB;
  return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} GB`;
}

// ---------- links ----------
export function osmUrl(lat, lon) {
  const a = Number(lat), b = Number(lon);
  if (lat == null || lon == null || !isFinite(a) || !isFinite(b)) return null;
  if (Math.abs(a) > 90 || Math.abs(b) > 180 || (a === 0 && b === 0)) return null;
  const la = a.toFixed(5), lo = b.toFixed(5);
  return `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=16/${la}/${lo}`;
}
export function driveViewUrl(fileId) {
  return fileId && DRIVE_ID.test(fileId) ? `https://drive.google.com/file/d/${fileId}/view` : null;
}
export const isDriveId = id => typeof id === 'string' && DRIVE_ID.test(id);

// ---------- the catalog ----------
const fold = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const str = v => (typeof v === 'string' ? v : v == null ? '' : String(v));
const numOrNull = v => (v == null || v === '' || !isFinite(Number(v)) ? null : Number(v));
const idOrNull = v => (isDriveId(v) ? v : null);

/** Checks and tidies a downloaded remini-catalog.json (v1). Throws on anything unusable. */
export function prepareCatalog(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || !Array.isArray(raw.items)) {
    throw new Error('This photo list is in a format remini does not understand.');
  }
  const events = new Map();
  for (const e of Array.isArray(raw.events) ? raw.events : []) {
    if (e && e.id != null) events.set(String(e.id), { id: String(e.id), name: str(e.name), approved: !!e.approved });
  }
  const items = [];
  const seen = new Set();
  for (const r of raw.items) {
    if (!r || typeof r !== 'object' || r.id == null) continue;
    const id = str(r.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const d = parseDate(r.t);
    let y = numOrNull(r.y), m = numOrNull(r.m);
    if (y == null && d) { y = d.getUTCFullYear(); m = d.getUTCMonth() + 1; }
    if (m != null && (m < 1 || m > 12)) m = null;
    const ev = r.ev != null && events.has(String(r.ev)) ? events.get(String(r.ev)) : null;
    const tags = Array.isArray(r.tags) ? r.tags.map(str).filter(Boolean) : [];
    const item = {
      id, n: str(r.n) || 'Untitled', t: d ? str(r.t) : null, ts: d ? d.getTime() : null, y, m,
      k: r.k === 'v' ? 'v' : 'p', dur: numOrNull(r.dur), lat: numOrNull(r.lat), lon: numOrNull(r.lon),
      s: numOrNull(r.s), mime: fold(r.mime), acct: str(r.acct) || null,
      f: idOrNull(r.f), th: idOrNull(r.th), pv: idOrNull(r.pv), tags,
      ev: ev && ev.approved ? ev.id : null,
    };
    // What a search looks through: file name, year, month name, tags, (approved) event name.
    item.hay = fold([item.n, y != null ? y : '', m != null ? MONTHS[m - 1] : '', ...tags,
      ev && ev.approved ? ev.name : ''].join('\n'));
    items.push(item);
  }
  items.sort(newestFirst);
  const accounts = (Array.isArray(raw.accounts) ? raw.accounts : []).filter(a => a && a.email).map(a => ({
    email: str(a.email), remote: str(a.remote), total: numOrNull(a.total), used: numOrNull(a.used), free: numOrNull(a.free),
  }));
  return { generated: str(raw.generated_utc) || null, home: str(raw.home) || null, accounts, items, events,
    byId: new Map(items.map((it, i) => [it.id, i])) };
}

/** Newest first; items without a date go last; ties keep a stable order by name then id. */
export function newestFirst(a, b) {
  if (a.ts !== b.ts) {
    if (a.ts == null) return 1;
    if (b.ts == null) return -1;
    return b.ts - a.ts;
  }
  return a.n < b.n ? -1 : a.n > b.n ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export const searchTokens = q => fold(q).split(/\s+/).filter(Boolean);

/** Every word typed must appear somewhere in the item's name, year, month, tags or event. */
export function matchesSearch(item, tokens) {
  for (const t of tokens) if (!item.hay.includes(t)) return false;
  return true;
}

export const FILTER_KEYS = ['year', 'month', 'type', 'account', 'notbacked', 'event', 'q'];

/** f: { year, month, type: 'photo'|'video', account, notbacked: '1', event, q } (strings, as in the URL). */
export function filterItems(items, f) {
  const year = f.year ? Number(f.year) : null;
  const month = year != null && f.month ? Number(f.month) : null;
  const kind = f.type === 'photo' ? 'p' : f.type === 'video' ? 'v' : null;
  const account = f.account || null;
  const notBacked = f.notbacked === '1';
  const event = f.event || null;
  const tokens = f.q ? searchTokens(f.q) : [];
  return items.filter(it => (year == null || it.y === year)
    && (month == null || it.m === month)
    && (kind == null || it.k === kind)
    && (account == null || it.acct === account)
    && (!notBacked || !it.f)
    && (event == null || it.ev === event)
    && (!tokens.length || matchesSearch(it, tokens)));
}

/** Years newest first, months January to December, with counts; plus how many have no date. */
export function groupTimeline(items) {
  const years = new Map();
  let undated = 0;
  for (const it of items) {
    if (it.y == null) { undated++; continue; }
    if (!years.has(it.y)) years.set(it.y, { year: it.y, count: 0, months: new Map(), nomonth: 0 });
    const y = years.get(it.y);
    y.count++;
    if (it.m == null) y.nomonth++;
    else y.months.set(it.m, (y.months.get(it.m) || 0) + 1);
  }
  return {
    years: [...years.values()].sort((a, b) => b.year - a.year).map(y => ({
      year: y.year, count: y.count, nomonth: y.nomonth,
      months: [...y.months.entries()].sort((a, b) => a[0] - b[0]).map(([month, count]) => ({ month, count })),
    })),
    undated,
  };
}

export function yearsOf(items) {
  return [...new Set(items.map(i => i.y).filter(y => y != null))].sort((a, b) => b - a);
}

/** Accounts from the catalog, plus any account an item mentions, with how many items each holds. */
export function accountRows(cat) {
  const counts = new Map();
  for (const it of cat.items) if (it.f && it.acct) counts.set(it.acct, (counts.get(it.acct) || 0) + 1);
  const rows = cat.accounts.map(a => ({ ...a, count: counts.get(a.email) || 0, home: a.email === cat.home }));
  for (const [email, count] of counts) {
    if (!rows.some(r => r.email === email)) rows.push({ email, remote: '', total: null, used: null, free: null, count, home: email === cat.home });
  }
  return rows;
}

export function storageNumbers(a) {
  if (!a.total) return null;
  const used = a.used != null ? a.used : (a.free != null ? a.total - a.free : null);
  const free = a.free != null ? a.free : (used != null ? a.total - used : null);
  const pct = used != null ? Math.min(100, Math.max(0, (used / a.total) * 100)) : null;
  return { total: a.total, used, free, pct };
}

// ---------- what to show in the photo view ----------
/** kind: 'video' | 'full' (the original from Drive) | 'preview' | 'thumb' | 'none'. */
export function viewSource(item) {
  if (item.k === 'v') return { kind: 'video', id: item.f };
  if (item.f && DIRECT_IMAGE_MIMES.includes(item.mime)) return { kind: 'full', id: item.f };
  if (item.pv) return { kind: 'preview', id: item.pv };
  if (item.th) return { kind: 'thumb', id: item.th };
  return { kind: 'none', id: null };
}

export function isMobileData(conn) {
  return !!conn && (conn.type === 'cellular' || conn.saveData === true);
}
/** Ask first before pulling a big original over mobile data. */
export function needsDataWarning(item, source, conn) {
  return source.kind === 'full' && (item.s || 0) > BIG_PHOTO_BYTES && isMobileData(conn);
}

// ---------- grid layout ----------
export function gridColumns(width) {
  if (width < 600) return 3;
  return Math.max(4, Math.floor((width + 8) / 168));
}
/** Which rows to draw for a grid whose top edge is `top` px from the top of the window. */
export function visibleRows(top, viewportH, rowH, rowCount, overscan = 3) {
  if (rowCount <= 0 || rowH <= 0) return { first: 0, last: -1 };
  const first = Math.min(rowCount, Math.max(0, Math.floor(-top / rowH) - overscan));
  const last = Math.min(rowCount - 1, Math.ceil((viewportH - top) / rowH) + overscan);
  return { first, last: Math.max(first - 1, last) };
}

// ---------- thumbnail cache ----------
/** Oldest-used first, until the total is at or under `target` bytes. entries: [{key, size, used}]. */
export function pickEvictions(entries, total, target) {
  const out = [];
  if (total <= target) return out;
  const sorted = entries.slice().sort((a, b) => a.used - b.used);
  for (const e of sorted) {
    if (total <= target) break;
    out.push(e.key);
    total -= e.size || 0;
  }
  return out;
}

// ---------- routes ----------
export function parseRoute(hash) {
  const raw = String(hash || '').replace(/^#/, '') || '/library';
  const qi = raw.indexOf('?');
  const parts = (qi >= 0 ? raw.slice(0, qi) : raw).split('/').filter(Boolean);
  let arg = null;
  try { arg = parts[1] ? decodeURIComponent(parts[1]) : null; } catch (e) { arg = parts[1]; }
  return { page: parts[0] || 'library', arg, params: new URLSearchParams(qi >= 0 ? raw.slice(qi + 1) : ''), key: raw };
}
export function libHash(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj || {})) if (v != null && v !== '') p.set(k, String(v));
  const qs = p.toString();
  return `#/library${qs ? `?${qs}` : ''}`;
}
