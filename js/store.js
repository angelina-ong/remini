/* remini cloud: what is kept on this phone, in IndexedDB.
 * Database names and catalog keys start with "remini:" because github.io pages share one origin.
 * Kept: the photo list (catalog) and small thumbnails (oldest-used removed beyond the size cap).
 * Never kept: sign-in tokens, full-size photos, videos. */
import { pickEvictions } from './logic.js';

const VERSION = 1;
const KV = 'kv';
const THUMBS = 'thumbs';
const BYTES_KEY = 'remini:thumbBytes';
const TOUCH_MS = 60 * 60 * 1000; // only rewrite "last used" once an hour per thumbnail

const reqP = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const txDone = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction failed'));
});

/** A store that does nothing, for browsers where IndexedDB is unavailable (e.g. some private modes). */
function nullStore(name) {
  return {
    name, ok: false,
    kvGet: async () => null, kvSet: async () => {},
    thumbGet: async () => null, thumbPut: async () => {},
    thumbBytes: () => 0, clearAll: async () => {},
  };
}

export async function openStore(name, capBytes) {
  if (!name.startsWith('remini:')) throw new Error('store names must start with remini:');
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(name, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(KV)) d.createObjectStore(KV);
        if (!d.objectStoreNames.contains(THUMBS)) {
          d.createObjectStore(THUMBS, { keyPath: 'th' }).createIndex('used', 'used');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('blocked'));
    });
  } catch (e) {
    return nullStore(name);
  }
  db.onversionchange = () => db.close();

  let bytes = Number(await reqP(db.transaction(KV).objectStore(KV).get(BYTES_KEY)).catch(() => 0)) || 0;
  let evicting = null;

  async function kvGet(key) {
    try { return await reqP(db.transaction(KV).objectStore(KV).get(key)); } catch (e) { return null; }
  }
  async function kvSet(key, value) {
    const tx = db.transaction(KV, 'readwrite');
    tx.objectStore(KV).put(value, key);
    await txDone(tx);
  }

  async function thumbGet(th) {
    let rec;
    try { rec = await reqP(db.transaction(THUMBS).objectStore(THUMBS).get(th)); } catch (e) { return null; }
    if (!rec || !rec.blob) return null;
    if (Date.now() - (rec.used || 0) > TOUCH_MS) {
      try {
        const tx = db.transaction(THUMBS, 'readwrite');
        tx.objectStore(THUMBS).put({ ...rec, used: Date.now() });
      } catch (e) { /* "last used" is only a hint */ }
    }
    return rec.blob;
  }

  async function thumbPut(th, blob) {
    const size = blob.size || 0;
    try {
      const tx = db.transaction([THUMBS, KV], 'readwrite');
      const st = tx.objectStore(THUMBS);
      const old = await reqP(st.get(th));
      st.put({ th, blob, size, used: Date.now() });
      bytes += size - ((old && old.size) || 0);
      tx.objectStore(KV).put(bytes, BYTES_KEY);
      await txDone(tx);
    } catch (e) { return; } // full disk or similar: the thumbnail still shows, it just isn't kept
    if (bytes > capBytes && !evicting) evicting = evict().finally(() => { evicting = null; });
  }

  // Remove the least recently used thumbnails until we are back under 85% of the cap.
  async function evict() {
    const entries = [];
    await new Promise((resolve, reject) => {
      const req = db.transaction(THUMBS).objectStore(THUMBS).index('used').openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) { resolve(); return; }
        entries.push({ key: c.value.th, size: c.value.size || 0, used: c.value.used || 0 });
        c.continue();
      };
      req.onerror = () => reject(req.error);
    }).catch(() => {});
    bytes = entries.reduce((s, e) => s + e.size, 0); // also corrects any drift
    const drop = pickEvictions(entries, bytes, Math.floor(capBytes * 0.85));
    if (!drop.length) return;
    const tx = db.transaction([THUMBS, KV], 'readwrite');
    const st = tx.objectStore(THUMBS);
    const sizes = new Map(entries.map(e => [e.key, e.size]));
    for (const k of drop) { st.delete(k); bytes -= sizes.get(k) || 0; }
    tx.objectStore(KV).put(bytes, BYTES_KEY);
    await txDone(tx).catch(() => {});
  }

  async function clearAll() {
    db.close();
    await new Promise(resolve => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }

  return { name, ok: true, kvGet, kvSet, thumbGet, thumbPut, thumbBytes: () => bytes, clearAll };
}
