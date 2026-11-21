/* remini cloud: the phone app. Plain JavaScript modules, no libraries.
 * Everything from the catalog is put on the page with textContent / createElement, never as HTML. */
import { CLIENT_ID, SCOPE, HOME_ACCOUNT_NAME, CATALOG_NAME, THUMB_CACHE_BYTES } from '../config.js';
import * as L from './logic.js';
import { openStore } from './store.js';
import { createAuth, driveApi, demoApi, AuthNeeded, NotFound, Offline } from './drive.js';
import { createThumbLoader } from './thumbs.js';

const DEMO = new URLSearchParams(location.search).get('demo') === '1';
const DEMO_MANY = DEMO && new URLSearchParams(location.search).get('many') === '1';
const BASE = new URL('./', document.baseURI).href; // .../remini/
const CATALOG_KEY = 'remini:catalog';
const META_KEY = 'remini:catalogMeta';
const LS_SIGNED_IN = 'remini:signedInBefore';
const enc = encodeURIComponent;

const $ = id => document.getElementById(id);
const $topbar = $('topbar'), $view = $('view'), $viewer = $('viewer'), $banners = $('banners');
const $summary = $('summary'), $welcome = $('welcome'), $searchForm = $('search-form'), $searchInput = $('search-input');

const state = {
  cat: null,          // prepared catalog
  meta: null,         // { id, modifiedTime } of the cached catalog
  page: null, key: null, renderId: 0,
  lib: null,          // the library grid currently drawn
  list: null,         // items the photo view swipes through
  viewer: { open: false, id: null, token: 0, chrome: null, ctrl: null, canGoBack: false, thumbHandle: null, fullUrl: null },
  filtersOpen: false,
  refreshing: false, refreshNote: '', problem: null, stale: false,
};

let store, api, auth, thumbs;

// ---------- small helpers ----------
function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = String(v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled') n[k] = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
}
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } };
const loadingEl = () => el('p', { class: 'muted loading', text: 'Loading…' });
function section(title, ...content) {
  return el('section', { class: 'v-sec' }, el('h3', { text: title }), ...content);
}
function selectField(labelText, id, options, current, onChange) {
  const select = el('select', { id, onchange: () => onChange(select.value) },
    options.map(([value, label]) => el('option', { value, text: label })));
  select.value = current || '';
  return el('div', { class: 'field' }, el('label', { for: id, text: labelText }), select);
}
const externalLink = (href, text, cls) => el('a', { href, text, class: cls, target: '_blank', rel: 'noopener noreferrer' });
function itemDate(it) { const d = L.parseDate(it.t); return d ? L.dateWords(d, true) : 'Date unknown'; }

// ---------- banners (sign-in again, demo, problems) ----------
function drawBanners() {
  const out = [];
  if (DEMO) {
    out.push(el('div', { class: 'banner banner-info' },
      el('p', { text: 'This is a demo with made-up photos.' }), el('a', { href: './', text: 'Leave the demo' })));
  }
  if (!DEMO && state.cat) {
    const st = auth.status;
    if (st === 'expired' || st === 'signed-out' || st === 'loading') {
      const msg = st === 'loading' ? 'Getting ready…'
        : state.refreshNote === 'never' ? 'Tap to continue, and remini will load your newest photos.'
          : 'Google asks remini to check in now and then. Tap to continue to see the newest photos.';
      const btn = el('button', { type: 'button', class: 'primary', text: 'Tap to continue', disabled: st === 'loading',
        onclick: () => { if (!auth.request()) toast('Just a moment, and then try again.'); } });
      out.push(el('div', { class: 'banner', id: 'continue-banner' }, el('p', { text: msg }), btn));
    }
    if (auth.error === 'closed' || auth.error === 'failed' || auth.error === 'refused') {
      out.push(el('div', { class: 'banner banner-error' },
        el('p', { text: auth.error === 'refused' ? "Google didn't give permission. Please tap again and choose Allow."
          : "That didn't finish. Please tap “Tap to continue” again." })));
    }
    if (auth.error === 'scope') {
      out.push(el('div', { class: 'banner banner-error' },
        el('p', { text: 'remini needs permission to see your Drive files. Please tap again and tick the box to allow it.' })));
    }
  }
  if (state.problem) out.push(state.problem);
  $banners.replaceChildren(...out);
}
function setProblem(node) { state.problem = node; drawBanners(); }

let toastTimer = null;
function toast(text) {
  let t = document.querySelector('.toast');
  if (!t) { t = el('div', { class: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

function wrongAccountProblem() {
  return el('div', { class: 'banner banner-error' },
    el('p', { text: `remini couldn't find your photo list in this Google account. Please sign in with ${HOME_ACCOUNT_NAME}.` }),
    el('button', { type: 'button', text: 'Use a different account', onclick: () => auth.request({ chooseAccount: true }) }));
}

// ---------- sign-in screen ----------
function showWelcome(on) {
  document.body.classList.toggle('signed-out', on);
  $welcome.hidden = !on;
  $view.hidden = on;
  $topbar.querySelector('.nav').hidden = on;
  $searchForm.hidden = on;
  if (on) $summary.textContent = '';
}

function drawSignin() {
  const btn = $('signin-btn'), status = $('signin-status');
  const st = auth ? auth.status : 'loading';
  btn.disabled = st === 'loading' || st === 'unavailable';
  btn.textContent = st === 'loading' ? 'Getting ready…' : 'Sign in with Google';
  const why = auth && auth.error;
  status.textContent = st === 'unavailable'
    ? (why === 'no-client-id' ? "remini isn't set up yet, so signing in isn't possible."
      : "Google's sign-in couldn't be reached. Please check your internet connection and reload the page.")
    : why === 'closed' ? 'The Google window was closed before you finished. Please tap Sign in again.'
      : why === 'refused' ? "Google didn't give permission. Please tap Sign in again and choose Allow."
        : why === 'scope' ? 'Please tap Sign in again and tick the box that lets remini see your Drive files.'
          : why === 'failed' ? "That didn't work. Please tap Sign in again." : '';
}

// ---------- catalog: cached copy first, then a check for a newer one ----------
async function loadCached() {
  const [raw, meta] = await Promise.all([store.kvGet(CATALOG_KEY), store.kvGet(META_KEY)]);
  if (!raw) return false;
  try { useCatalog(raw, meta); return true; } catch (e) { return false; }
}

function useCatalog(raw, meta) {
  state.cat = L.prepareCatalog(raw);
  state.meta = meta || null;
  if (auth && state.cat.home && state.cat.home.includes('@')) auth.setHint(state.cat.home);
}

async function refreshCatalog() {
  if (state.refreshing || !api.ready()) return;
  state.refreshing = true;
  try {
    const meta = await api.findCatalog();
    if (!meta) { setProblem(wrongAccountProblem()); return; }
    if (state.cat && state.meta && state.meta.id === meta.id && state.meta.modifiedTime === meta.modifiedTime) {
      setProblem(null);
      return; // already up to date
    }
    const raw = await api.downloadCatalog(meta.id);
    const first = !state.cat;
    useCatalog(raw, meta);
    lsSet(LS_SIGNED_IN, '1');
    store.kvSet(CATALOG_KEY, raw).then(() => store.kvSet(META_KEY, meta)).catch(() => {});
    setProblem(null);
    state.refreshNote = 'done';
    if (first) { showWelcome(false); refreshSummary(); onRoute(); } else redrawKeepingScroll();
  } catch (e) {
    if (e instanceof AuthNeeded) { drawBanners(); return; }
    const msg = e instanceof Offline
      ? (state.cat ? "Couldn't reach Google right now. Showing the photos remini saved on this phone." : "Couldn't reach Google right now. Please check your internet connection.")
      : e instanceof NotFound ? "remini couldn't open your photo list. Please try again later."
        : (e && e.message && /format/.test(e.message) ? e.message : 'Something went wrong while loading your photo list.');
    setProblem(el('div', { class: 'banner banner-error' }, el('p', { text: msg }),
      el('button', { type: 'button', text: 'Try again', onclick: () => { setProblem(null); refreshCatalog(); } })));
  } finally {
    state.refreshing = false;
  }
}

function redrawKeepingScroll() {
  refreshSummary();
  if (state.viewer.open) { state.stale = true; return; } // the page behind is redrawn when the photo closes
  const y = window.scrollY;
  renderPage(L.parseRoute(location.hash));
  window.scrollTo(0, y);
}

function refreshSummary() {
  if (!state.cat) { $summary.textContent = ''; return; }
  const items = state.cat.items;
  const notBacked = items.filter(i => !i.f).length;
  $summary.replaceChildren(L.itemsWord(items.length));
  if (notBacked) $summary.append(' · ', el('a', { href: L.libHash({ notbacked: 1 }), text: `${L.fmtNum(notBacked)} not backed up yet` }));
}

// ---------- library ----------
const hasFilters = p => L.FILTER_KEYS.some(k => p.get(k));
const paramsObj = p => Object.fromEntries(L.FILTER_KEYS.map(k => [k, p.get(k) || '']));

function renderLibrary(r) {
  const p = r.params;
  const list = L.filterItems(state.cat.items, paramsObj(p));
  state.list = list;
  const nActive = ['year', 'month', 'type', 'account', 'notbacked'].filter(k => p.get(k)).length;
  const filtersBox = el('div', { class: `filters${state.filtersOpen ? ' is-open' : ''}`, id: 'filters-box' });
  const toggle = el('button', { type: 'button', class: 'filters-toggle', 'aria-controls': 'filters-box',
    'aria-expanded': String(state.filtersOpen), text: nActive ? `Filters (${nActive})` : 'Filters',
    onclick: () => {
      state.filtersOpen = !state.filtersOpen;
      filtersBox.classList.toggle('is-open', state.filtersOpen);
      toggle.setAttribute('aria-expanded', String(state.filtersOpen));
      if (state.lib) state.lib.grid.relayout();
    } });
  buildFilterBar(filtersBox, p);
  const n = list.length, type = p.get('type');
  const countLine = el('p', { class: 'count', id: 'count', text: type === 'photo' ? L.plural(n, 'photo', 'photos')
    : type === 'video' ? L.plural(n, 'video', 'videos') : L.itemsWord(n) });
  const gridBox = el('div', { class: 'vgrid', id: 'grid' });
  $view.append(el('div', { class: 'page-head' }, el('h1', { text: 'Library' }), toggle),
    filtersBox, activeNotes(p), countLine, gridBox);
  if (!n) {
    gridBox.replaceWith(hasFilters(p)
      ? el('div', { class: 'empty' }, el('p', { text: 'No matches. Try other words, or clear the filters.' }),
        el('a', { href: '#/library', text: 'Show everything' }))
      : el('div', { class: 'empty' }, el('p', { text: 'Nothing here yet.' }),
        el('p', { class: 'muted', text: 'Once your computer has backed up some photos, they will show up here.' })));
    return;
  }
  state.lib = { key: r.key, grid: createGrid(gridBox, list) };
}

function buildFilterBar(box, p) {
  const go = changes => {
    const np = new URLSearchParams(p);
    for (const [k, v] of Object.entries(changes)) { if (v) np.set(k, v); else np.delete(k); }
    const qs = np.toString();
    location.hash = `#/library${qs ? `?${qs}` : ''}`;
  };
  const year = p.get('year') || '';
  const monthField = selectField('Month', 'f-month', [['', 'Any month'], ...L.MONTHS.map((m, i) => [String(i + 1), m])],
    p.get('month'), v => go({ month: v }));
  monthField.querySelector('select').disabled = !year;
  const accounts = L.accountRows(state.cat).map(a => a.email);
  const notBacked = el('input', { type: 'checkbox', id: 'f-notbacked', checked: p.get('notbacked') === '1',
    onchange: () => go({ notbacked: notBacked.checked ? '1' : '' }) });
  box.replaceChildren(
    selectField('Year', 'f-year', [['', 'Any year'], ...L.yearsOf(state.cat.items).map(y => [String(y), String(y)])],
      year, v => go({ year: v, month: v ? p.get('month') : '' })),
    monthField,
    selectField('Show', 'f-type', [['', 'Photos and videos'], ['photo', 'Photos only'], ['video', 'Videos only']],
      p.get('type'), v => go({ type: v })),
    selectField('Account', 'f-account', [['', 'Any account'], ...accounts.map(a => [a, a])], p.get('account'), v => go({ account: v })),
    el('div', { class: 'field field-check' }, notBacked, el('label', { for: 'f-notbacked', text: 'Not backed up yet' })),
    hasFilters(p) && el('a', { class: 'clear-link', href: '#/library', text: 'Clear filters' }));
}

function activeNotes(p) {
  const without = key => { const np = new URLSearchParams(p); np.delete(key); const qs = np.toString(); return `#/library${qs ? `?${qs}` : ''}`; };
  const notes = [];
  if (p.get('q')) notes.push([`Showing results for “${p.get('q')}”`, without('q')]);
  if (p.get('event')) {
    const ev = state.cat.events.get(p.get('event'));
    notes.push([ev ? `Showing the event “${ev.name}”` : 'Showing one event', without('event')]);
  }
  return el('div', { class: 'active-filters' }, notes.map(([text, href]) =>
    el('p', { class: 'note' }, el('span', { text }), ' ', el('a', { href, text: 'Show everything instead' }))));
}

/* A windowed grid: only the rows near the screen exist in the page, so 6,000+ items stay smooth. */
function createGrid(box, list) {
  const mounted = new Map(); // index -> { node, handle }
  let cols = 3, gap = 3, tileW = 100, rowH = 103, rows = 0, raf = 0, alive = true;
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const rec = mounted.get(Number(e.target.dataset.index));
      if (!rec) continue;
      if (e.isIntersecting && !rec.handle && !rec.loaded) {
        rec.handle = thumbs.request(rec.item.th, url => {
          rec.loaded = true;
          const img = rec.node.querySelector('img');
          if (url) { img.src = url; img.addEventListener('load', () => img.classList.add('is-loaded'), { once: true }); }
          else rec.node.classList.add('no-thumb');
        });
      } else if (!e.isIntersecting && rec.handle && !rec.loaded) {
        rec.handle.cancel();
        rec.handle = null;
      }
    }
  }, { rootMargin: '300px 0px' });

  function layout() {
    const w = box.clientWidth || document.documentElement.clientWidth;
    cols = L.gridColumns(w);
    gap = w < 600 ? 3 : 8;
    tileW = (w - gap * (cols - 1)) / cols;
    rowH = tileW + gap;
    rows = Math.ceil(list.length / cols);
    box.style.height = `${Math.max(0, rows * rowH - gap)}px`;
    for (const [i, rec] of mounted) place(rec.node, i);
  }
  function place(node, i) {
    const r = Math.floor(i / cols), c = i % cols;
    node.style.width = node.style.height = `${tileW}px`;
    node.style.transform = `translate(${Math.round(c * (tileW + gap))}px, ${Math.round(r * rowH)}px)`;
  }
  function unmount(i) {
    const rec = mounted.get(i);
    if (!rec) return;
    io.unobserve(rec.node);
    if (rec.handle) rec.handle.cancel();
    rec.node.remove();
    mounted.delete(i);
  }
  function update() {
    raf = 0;
    if (!alive) return;
    const top = box.getBoundingClientRect().top;
    const { first, last } = L.visibleRows(top, window.innerHeight, rowH, rows, 4);
    const from = first * cols, to = Math.min(list.length - 1, (last + 1) * cols - 1);
    for (const i of [...mounted.keys()]) if (i < from || i > to) unmount(i);
    const frag = document.createDocumentFragment();
    for (let i = from; i <= to; i++) {
      if (mounted.has(i)) continue;
      const item = list[i];
      const node = tileNode(item, i);
      place(node, i);
      mounted.set(i, { node, item, handle: null, loaded: false });
      frag.append(node);
      io.observe(node);
    }
    box.append(frag);
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(update); };
  const onResize = () => { layout(); schedule(); };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', onResize);
  layout();
  update(); // the first screenful straight away

  return {
    relayout: onResize,
    scrollToItem(id) {
      const i = list.findIndex(it => it.id === id);
      if (i < 0) return;
      const top = box.getBoundingClientRect().top + window.scrollY + Math.floor(i / cols) * rowH;
      if (top < window.scrollY + 80 || top > window.scrollY + window.innerHeight - rowH) window.scrollTo(0, Math.max(0, top - 120));
      update();
    },
    focusItem(id) {
      const i = list.findIndex(it => it.id === id);
      const rec = mounted.get(i);
      if (rec) rec.node.focus({ preventScroll: true });
    },
    destroy() {
      alive = false;
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', onResize);
      for (const i of [...mounted.keys()]) unmount(i);
      io.disconnect();
      if (raf) cancelAnimationFrame(raf);
    },
  };
}

function tileNode(item, index) {
  const video = item.k === 'v';
  const drive = video ? L.driveViewUrl(item.f) : null;
  const label = `${video ? 'Video' : 'Photo'}, ${itemDate(item)}${!item.f ? ', not backed up yet' : ''}${drive ? ', plays in Google Drive' : ''}`;
  // A video tile is a plain link to Google Drive, which plays it (or the Drive app does).
  const a = drive
    ? el('a', { class: 'tile tile-video', href: drive, target: '_blank', rel: 'noopener noreferrer', 'data-id': item.id,
      'data-index': index, 'aria-label': label })
    : el('a', { class: `tile${video ? ' tile-video' : ''}`, href: `#/photo/${enc(item.id)}`, 'data-id': item.id,
      'data-index': index, 'aria-label': label });
  a.append(el('img', { alt: '', decoding: 'async', draggable: 'false' }));
  if (video) {
    a.append(el('span', { class: 'badge-video', 'aria-hidden': 'true',
      text: `▶${item.dur != null ? ` ${L.fmtDuration(item.dur)}` : ''}` }));
  }
  if (!item.f) a.append(el('span', { class: 'dot-unsaved', 'aria-hidden': 'true', title: 'On computer only (not backed up yet)' }));
  return a;
}

// ---------- photo view ----------
function setInert(on) {
  for (const n of [$topbar, $banners, $view]) n.inert = on;
  document.body.classList.toggle('viewer-open', on);
}

function ensureViewerChrome() {
  const v = state.viewer;
  if (v.chrome) return v.chrome;
  const close = el('button', { type: 'button', class: 'v-close', onclick: closeViewer }, '✕ Close');
  const prev = el('button', { type: 'button', class: 'v-nav v-prev', 'aria-label': 'Previous', title: 'Previous', onclick: () => stepViewer(-1) }, '‹');
  const next = el('button', { type: 'button', class: 'v-nav v-next', 'aria-label': 'Next', title: 'Next', onclick: () => stepViewer(1) }, '›');
  const stage = el('div', { class: 'v-stage', id: 'v-stage' });
  const panel = el('div', { class: 'v-panel', id: 'v-panel' });
  const wrap = el('div', { class: 'v-stage-wrap', id: 'v-stage-wrap' }, prev, stage, next);
  $viewer.replaceChildren(el('div', { class: 'v-top' }, close), el('div', { class: 'v-body' }, wrap, panel));
  addSwipe(wrap, stage);
  v.chrome = { close, prev, next, stage, panel };
  return v.chrome;
}

// Swipe left/right for next/previous (touch and pen; a mouse has the arrow buttons).
function addSwipe(area, stage) {
  let start = null;
  let swiped = false; // a swipe that started on the video's play link must not also open it
  const reset = () => {
    start = null;
    stage.classList.remove('is-dragging');
    stage.classList.add('is-settling');
    stage.style.transform = '';
  };
  area.addEventListener('pointerdown', e => {
    if (!e.isPrimary || e.pointerType === 'mouse') return;
    const t = e.target.closest ? e.target : null;
    if (t && t.closest('button, input, a:not(.v-play)')) return;
    swiped = false;
    if (window.visualViewport && window.visualViewport.scale > 1.01) return; // zoomed in: let it pan
    start = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  area.addEventListener('pointermove', e => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
      stage.classList.add('is-dragging');
      stage.classList.remove('is-settling');
      stage.style.transform = `translateX(${Math.round(dx)}px)`;
    }
  });
  area.addEventListener('pointerup', e => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    reset();
    if (Math.abs(dx) >= 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) { swiped = true; stepViewer(dx < 0 ? 1 : -1); }
    else if (Math.abs(dx) > 10) swiped = true; // a half swipe is not a tap either
  });
  area.addEventListener('click', e => {
    if (swiped) { e.preventDefault(); e.stopPropagation(); swiped = false; }
  }, true);
  area.addEventListener('pointercancel', () => { if (start) reset(); });
}

function dropViewerLoads() {
  const v = state.viewer;
  if (v.ctrl) { v.ctrl.abort(); v.ctrl = null; }
  if (v.thumbHandle) { v.thumbHandle.cancel(); v.thumbHandle = null; }
  if (v.fullUrl) { URL.revokeObjectURL(v.fullUrl); v.fullUrl = null; }
}

function openViewer(id) {
  const v = state.viewer;
  const idx = state.cat.byId.get(id);
  if (idx == null) { toast("That photo isn't in your photo list any more."); location.replace('#/library'); return; }
  const item = state.cat.items[idx];
  const firstOpen = !v.open;
  if (firstOpen) { v.open = true; $viewer.hidden = false; setInert(true); }
  const c = ensureViewerChrome();
  if (firstOpen) c.close.focus();
  v.id = id;
  const token = ++v.token;
  dropViewerLoads();
  updateViewerNav();
  $viewer.setAttribute('aria-label', item.k === 'v' ? 'Video' : 'Photo');
  c.panel.replaceChildren(...viewerDetails(item));
  showMedia(c.stage, item, token);
}

function stageImg(cls, kind) {
  return el('img', { class: `v-media ${cls || ''}`, alt: '', decoding: 'async', 'data-kind': kind });
}

function showMedia(stage, item, token) {
  const v = state.viewer;
  const src = L.viewSource(item);
  const live = () => token === v.token;
  const holder = el('div', { class: 'v-frame' });
  const thumbImg = stageImg('v-placeholder', 'thumb');
  holder.append(thumbImg);
  stage.replaceChildren(holder);
  stage.dataset.source = src.kind;
  stage.dataset.id = item.id;

  // The thumbnail first; it is also what shows when there is nothing bigger.
  v.thumbHandle = thumbs.request(item.th, url => {
    if (!live()) return;
    if (url) thumbImg.src = url;
    else if (src.kind === 'thumb' || src.kind === 'none' || src.kind === 'video') {
      thumbImg.replaceWith(el('p', { class: 'v-msg', text: 'No preview of this one yet.' }));
    }
  });

  if (src.kind === 'video') {
    const drive = L.driveViewUrl(item.f);
    if (drive) {
      holder.classList.add('v-video');
      holder.append(externalLink(drive, '', 'v-play'));
      const play = holder.querySelector('.v-play');
      play.setAttribute('aria-label', 'Play this video in Google Drive');
      play.append(el('span', { class: 'v-play-icon', 'aria-hidden': 'true', text: '▶' }),
        el('span', { class: 'v-play-text', text: `Play in Google Drive${item.dur != null ? ` (${L.fmtDuration(item.dur)})` : ''}` }));
    }
    if (!item.f) stage.append(localOnlyBadge());
    return;
  }
  if (!item.f) stage.append(localOnlyBadge());
  if (src.kind === 'thumb' || src.kind === 'none') return;

  const load = () => {
    v.ctrl = new AbortController();
    const ctrl = v.ctrl;
    holder.classList.add('is-loading');
    api.fileBlob(src.id, ctrl.signal).then(blob => {
      if (!live()) return;
      const url = URL.createObjectURL(blob);
      const full = stageImg('', src.kind);
      full.onload = () => {
        if (!live()) { URL.revokeObjectURL(url); return; }
        if (v.fullUrl) URL.revokeObjectURL(v.fullUrl);
        v.fullUrl = url;
        holder.classList.remove('is-loading');
        thumbImg.replaceWith(full);
      };
      full.onerror = () => {
        URL.revokeObjectURL(url);
        if (!live()) return;
        holder.classList.remove('is-loading');
        // e.g. a photo type this browser can't draw: fall back to the preview, if there is one.
        if (src.kind === 'full' && item.pv) { const alt = { kind: 'preview', id: item.pv }; loadOther(alt); return; }
        stage.append(el('p', { class: 'v-msg', text: 'This photo can only be shown small here.' }));
      };
      full.src = url;
    }).catch(e => {
      if (!live() || (e && e.name === 'AbortError')) return;
      holder.classList.remove('is-loading');
      if (e instanceof AuthNeeded) { stage.append(continueAsk('To see this photo in full, Google needs a quick OK from you.')); return; }
      stage.append(el('p', { class: 'v-msg', text: e instanceof Offline
        ? "Couldn't reach Google right now, so this is a smaller copy." : 'The full photo could not be loaded, so this is a smaller copy.' }));
    });
  };
  const loadOther = alt => { src.kind = alt.kind; src.id = alt.id; load(); };

  if (L.needsDataWarning(item, src, navigator.connection)) {
    const ask = el('div', { class: 'v-ask' },
      el('p', { text: `This photo is big (${L.fmtSize(item.s)}), and you're on mobile data. This is a smaller copy.` }),
      el('button', { type: 'button', class: 'primary', text: 'Load it anyway', onclick: () => { ask.remove(); load(); } }));
    stage.append(ask);
    return;
  }
  load();
}

// The banner at the top is hidden behind the photo view, so the photo view has its own button.
function continueAsk(message) {
  return el('div', { class: 'v-ask v-continue' }, el('p', { text: message }),
    el('button', { type: 'button', class: 'primary', text: 'Tap to continue', onclick: () => { if (!auth.request()) toast('Just a moment, and then try again.'); } }));
}

function localOnlyBadge() {
  return el('p', { class: 'badge-local', text: 'On computer only (not backed up yet)' });
}

function viewerDetails(item) {
  const facts = [item.k === 'v' ? (item.dur != null ? `Video, ${L.fmtDuration(item.dur)}` : 'Video') : 'Photo', L.fmtSize(item.s)];
  const out = [
    el('h2', { class: 'v-date', text: itemDate(item) }),
    el('p', { class: 'v-name', text: item.n }),
    el('p', { class: 'muted small', text: facts.filter(Boolean).join(' · ') }),
  ];
  out.push(item.f
    ? el('p', { class: 'v-stored' }, 'Stored in: ', el('span', { class: 'v-acct', text: item.acct || 'Google Drive' }))
    : el('p', { class: 'v-stored warn-text', text: 'On computer only (not backed up yet)' }));
  const map = L.osmUrl(item.lat, item.lon);
  if (map) {
    out.push(section('Where', el('p', {}, externalLink(map, 'See on a map (opens OpenStreetMap)', 'map-link')),
      el('p', { class: 'muted small map-url', text: map })));
  }
  if (item.ev) {
    const ev = state.cat.events.get(item.ev);
    if (ev) out.push(section('Event', el('p', {}, el('a', { href: L.libHash({ event: ev.id }), text: ev.name || 'Untitled event' }))));
  }
  if (item.tags.length) {
    out.push(section('Tags', el('div', { class: 'chips' }, item.tags.map(t =>
      el('a', { class: 'chip', href: L.libHash({ q: t }), text: t, title: 'See everything with this tag' })))));
  }
  return out;
}

function viewerIndex() {
  const items = state.list || state.cat.items;
  return { items, idx: items.findIndex(i => i.id === state.viewer.id) };
}
function updateViewerNav() {
  const c = state.viewer.chrome;
  if (!c) return;
  const { items, idx } = viewerIndex();
  c.prev.hidden = c.next.hidden = idx < 0;
  c.prev.disabled = idx <= 0;
  c.next.disabled = idx >= items.length - 1;
}
function stepViewer(delta) {
  const { items, idx } = viewerIndex();
  if (idx < 0) return;
  const target = items[idx + delta];
  if (target) location.replace(`#/photo/${enc(target.id)}`); // replace: Back still returns to the grid
}
function closeViewer() {
  if (state.viewer.canGoBack) history.back();
  else location.hash = '#/library';
}
function hideViewer() {
  const v = state.viewer;
  v.open = false;
  v.token++;
  dropViewerLoads();
  v.chrome = null;
  $viewer.hidden = true;
  $viewer.replaceChildren();
  setInert(false);
  if (state.lib && v.id) { state.lib.grid.scrollToItem(v.id); state.lib.grid.focusItem(v.id); }
}

// ---------- timeline ----------
function renderTimeline() {
  const tl = L.groupTimeline(state.cat.items);
  const box = el('div', { class: 'timeline', id: 'timeline' });
  $view.append(el('h1', { text: 'Timeline' }),
    el('p', { class: 'muted', text: 'Every year and month that has photos or videos. Pick one to see them.' }), box);
  if (!tl.years.length && !tl.undated) box.append(el('div', { class: 'empty' }, el('p', { text: 'Nothing here yet.' })));
  for (const y of tl.years) {
    box.append(el('section', { class: 'tl-year', 'data-year': y.year },
      el('h2', {}, el('a', { href: L.libHash({ year: y.year }), text: String(y.year) }),
        el('span', { class: 'muted count-tag', 'data-count': y.count, text: L.itemsWord(y.count) })),
      el('ul', { class: 'tl-months' }, y.months.map(m => el('li', {},
        el('a', { class: 'tl-month', href: L.libHash({ year: y.year, month: m.month }), 'data-month': m.month, 'data-count': m.count },
          el('span', { text: L.MONTHS[m.month - 1] }), el('span', { class: 'muted', text: L.fmtNum(m.count) })))))));
  }
  if (tl.undated) box.append(el('p', { class: 'muted', id: 'undated', 'data-count': tl.undated, text: `Without a date: ${L.fmtNum(tl.undated)}` }));
}

// ---------- accounts ----------
function renderAccounts() {
  const cat = state.cat;
  const rows = L.accountRows(cat);
  const gen = L.parseDate(cat.generated);
  $view.append(el('h1', { text: 'Accounts' }),
    el('p', { class: 'muted', text: 'The Google accounts where your photos and videos are kept.' }),
    el('div', { class: 'cards accounts' }, rows.length ? rows.map(accountCard)
      : el('div', { class: 'empty' }, el('p', { text: 'No accounts in the photo list yet.' }))),
    el('p', { class: 'footnote', id: 'catalog-updated', text: gen
      ? `Catalog updated ${L.dateWords(gen, true)} (${L.timeAgo(gen)}).` : 'Catalog update date unknown.' }),
    el('p', { class: 'muted small', text: 'Your computer updates this list when it backs up new photos.' }),
    aboutCard());
}

function accountCard(a) {
  const nums = L.storageNumbers(a);
  let storage;
  if (!nums) storage = el('p', { class: 'muted', text: 'Size unknown' });
  else {
    const fill = el('div', { class: 'bar-fill' });
    fill.style.width = `${nums.pct || 0}%`;
    storage = el('div', { class: 'storage' },
      el('div', { class: `bar${(nums.pct || 0) >= 90 ? ' bar-full' : ''}`, role: 'img',
        'aria-label': `${Math.round(nums.pct || 0)}% of the space is used` }, fill),
      el('p', { text: nums.free != null ? `${L.fmtGB(nums.free)} free of ${L.fmtGB(nums.total)}` : `${L.fmtGB(nums.total)} in total` }));
  }
  return el('article', { class: 'card account' },
    el('h2', { text: a.email }),
    a.home && el('p', { class: 'small' }, el('span', { class: 'badge badge-ok', text: 'Your main account' })),
    storage,
    el('p', { text: a.count ? `${L.itemsWord(a.count)} stored here` : 'Nothing stored here yet' }));
}

function aboutCard() {
  const box = el('section', { class: 'card about' },
    el('h2', { text: 'About remini' }),
    el('p', { text: "remini only reads your Google Drive. It can't change or delete anything." }),
    el('p', {}, el('a', { href: 'privacy.html', text: 'Privacy' })));
  if (DEMO) box.append(el('p', {}, el('a', { href: './', text: 'Leave the demo' })));
  else {
    box.append(el('button', { type: 'button', text: 'Sign out and forget this phone', onclick: async () => {
      if (!confirm('Sign out? remini will forget the photo list and thumbnails it saved on this phone. Nothing in your Google Drive changes.')) return;
      auth.signOut();
      try { localStorage.removeItem(LS_SIGNED_IN); } catch (e) { /* ignore */ }
      await store.clearAll();
      location.replace('./');
    } }));
  }
  return box;
}

// ---------- router ----------
const PAGES = { library: renderLibrary, timeline: renderTimeline, accounts: renderAccounts };

function renderPage(r) {
  state.renderId++;
  state.stale = false;
  if (state.lib) { state.lib.grid.destroy(); state.lib = null; }
  state.page = r.page;
  state.key = r.key;
  if (r.page !== 'library') state.list = null;
  $view.replaceChildren();
  window.scrollTo(0, 0);
  PAGES[r.page](r);
  document.documentElement.dataset.page = r.page;
}

function afterPageChange(r) {
  for (const a of document.querySelectorAll('.nav a[data-page]')) {
    if (a.dataset.page === r.page) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  $searchInput.value = r.page === 'library' ? (r.params.get('q') || '') : '';
}

function onRoute() {
  if (!state.cat) return; // the sign-in screen is showing
  const r = L.parseRoute(location.hash);
  if (r.page === 'photo' && r.arg) {
    const v = state.viewer;
    if (!v.open) {
      v.canGoBack = state.page != null;
      if (!state.page) {
        const lib = L.parseRoute('#/library');
        renderPage(lib);
        afterPageChange(lib);
      }
    }
    openViewer(r.arg);
    document.documentElement.dataset.page = 'photo';
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(PAGES, r.page)) { location.replace('#/library'); return; }
  const wasOpen = state.viewer.open;
  if (wasOpen) hideViewer();
  const keep = r.page === 'library' && state.page === 'library' && state.key === r.key && state.lib && !state.stale;
  if (!keep) renderPage(r); // otherwise the grid (and where you had scrolled to) stays as it was
  else document.documentElement.dataset.page = r.page;
  afterPageChange(r);
}

function onKey(e) {
  if (!state.viewer.open) return;
  if (e.key === 'Escape') { e.preventDefault(); closeViewer(); return; }
  if (e.target && e.target.closest && e.target.closest('input, textarea, select')) return;
  if (e.key === 'ArrowLeft') { e.preventDefault(); stepViewer(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); stepViewer(1); }
}

// ---------- start ----------
function onAuthChange(status) {
  if (status === 'ok') {
    thumbs.resume();
    refreshCatalog();
    if (state.viewer.open && state.viewer.id) openViewer(state.viewer.id); // load the full photo now
  }
  drawSignin();
  drawBanners();
}

async function start() {
  document.documentElement.classList.toggle('demo', DEMO);
  $('signin-text').textContent = `Sign in with ${HOME_ACCOUNT_NAME} to see your photos. remini only reads; it can't change or delete anything.`;
  $('signin-btn').addEventListener('click', () => { if (!auth.request()) drawSignin(); });
  $searchForm.addEventListener('submit', e => {
    e.preventDefault();
    const q = $searchInput.value.trim();
    $searchInput.blur();
    location.hash = q ? L.libHash({ q }) : '#/library';
  });
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', onRoute);

  store = await openStore(DEMO_MANY ? 'remini:demo-many' : DEMO ? 'remini:demo' : 'remini:cache', THUMB_CACHE_BYTES);
  if (DEMO) {
    auth = { status: 'ok', error: null, request: () => false, setHint() {}, signOut() {} };
    api = demoApi(BASE, DEMO_MANY);
  } else {
    auth = createAuth({ clientId: CLIENT_ID, scope: SCOPE, onChange: s => onAuthChange(s) });
    api = driveApi(auth, CATALOG_NAME);
  }
  thumbs = createThumbLoader({ api, store, max: 6 });
  if (DEMO) window.__reminiThumbStats = thumbs.stats; // for the automated checks

  const hadCache = await loadCached();
  if (hadCache) {
    if (!DEMO) { auth.markReturning && auth.markReturning(); state.refreshNote = 'later'; }
    showWelcome(false);
    refreshSummary();
    onRoute();
  } else {
    showWelcome(!DEMO);
    if (!DEMO && lsGet(LS_SIGNED_IN) === '1') state.refreshNote = 'never';
  }
  drawSignin();
  drawBanners();
  if (DEMO) await refreshCatalog();
  else auth.init();
  if (DEMO && !state.cat) showWelcome(false);
  document.documentElement.dataset.ready = '1';
}

// Lets the phone add remini to its home screen. The service worker only keeps the app's own files.
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register(new URL('sw.js', BASE).href, { scope: BASE }).catch(() => { /* optional */ });
}

start().catch(() => {
  $banners.replaceChildren(el('div', { class: 'banner banner-error' },
    el('p', { text: 'remini could not start. Please reload the page.' })));
});
