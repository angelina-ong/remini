/* remini cloud: loads thumbnails at most `max` at a time.
 * Order of looking: memory (object URL) -> IndexedDB on this phone -> Google Drive.
 * Requests for tiles that scrolled away are dropped. Object URLs are revoked once nothing uses them. */
import { AuthNeeded, NotFound } from './drive.js';

export function createThumbLoader({ api, store, max = 6, memCap = 400 }) {
  const mem = new Map();      // th -> { url, refs } (Map order = least recently used first)
  const queue = [];           // jobs waiting for a slot
  const waiting = new Set();  // jobs waiting for sign-in
  const missing = new Set();  // th known to be absent on Drive
  let active = 0, maxActive = 0;

  function trimMem() {
    if (mem.size <= memCap) return;
    for (const [th, e] of mem) {
      if (mem.size <= memCap) break;
      if (e.refs <= 0) { URL.revokeObjectURL(e.url); mem.delete(th); }
    }
  }
  function useMem(th) {
    const e = mem.get(th);
    if (!e) return null;
    mem.delete(th); mem.set(th, e); // most recently used goes last
    e.refs++;
    return e.url;
  }
  function addMem(th, blob) {
    let e = mem.get(th);
    if (!e) { e = { url: URL.createObjectURL(blob), refs: 0 }; mem.set(th, e); }
    e.refs++;
    trimMem();
    return e.url;
  }

  function pump() {
    while (active < max && queue.length) {
      const job = queue.shift();
      if (job.cancelled) continue;
      active++;
      if (active > maxActive) maxActive = active;
      run(job).finally(() => { active--; pump(); });
    }
  }

  async function run(job) {
    const { th } = job;
    const again = useMem(th);
    if (again) { deliver(job, again); return; }
    const cached = await store.thumbGet(th);
    if (job.cancelled) return;
    if (cached) { deliver(job, addMem(th, cached)); return; }
    if (!api.ready()) { waiting.add(job); return; }
    job.ctrl = new AbortController();
    try {
      const blob = await api.fileBlob(th, job.ctrl.signal);
      if (!blob || !blob.size) throw new NotFound();
      store.thumbPut(th, blob); // kept in the background
      if (job.cancelled) return;
      deliver(job, addMem(th, blob));
    } catch (e) {
      if (job.cancelled || (e && e.name === 'AbortError')) return;
      if (e instanceof AuthNeeded) { waiting.add(job); return; }
      if (e instanceof NotFound) missing.add(th);
      job.done = true;
      job.cb(null);
    }
  }

  function deliver(job, url) {
    if (job.cancelled) { release(job.th); return; }
    job.done = true;
    job.delivered = true;
    job.cb(url);
  }

  function release(th) {
    const e = mem.get(th);
    if (e) { e.refs = Math.max(0, e.refs - 1); trimMem(); }
  }

  return {
    /** Asks for a thumbnail; cb(url or null). Returns a handle: cancel() when the tile goes away. */
    request(th, cb) {
      const job = { th, cb, cancelled: false, done: false, delivered: false, ctrl: null };
      if (!th || missing.has(th)) { job.done = true; queueMicrotask(() => cb(null)); }
      else {
        const url = useMem(th);
        // The reference is taken now; cancel() gives it back, whether or not cb has run yet.
        if (url) { job.done = true; job.delivered = true; queueMicrotask(() => { if (!job.cancelled) cb(url); }); }
        else { queue.push(job); pump(); }
      }
      return {
        cancel() {
          if (job.cancelled) return;
          job.cancelled = true;
          waiting.delete(job);
          if (job.ctrl) job.ctrl.abort();
          if (job.delivered) release(th);
        },
      };
    },
    /** Signed in again: send the parked requests off. */
    resume() {
      const jobs = [...waiting];
      waiting.clear();
      for (const j of jobs) if (!j.cancelled) queue.push(j);
      pump();
    },
    stats: () => ({ mem: mem.size, queued: queue.length, waiting: waiting.size, active, maxActive }),
  };
}
