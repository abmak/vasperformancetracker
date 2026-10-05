/**
 * Cross-worker state for Node cluster mode.
 *
 * Three pieces of coordination state used to live inside whichever process
 * happened to serve the request:
 *   - single-use captcha challenges (a solved puzzle must not be replayed),
 *   - the per-IP captcha rate-limit counter,
 *   - cache generations, which tell a worker that its cached responses for a
 *     route are stale after another worker ran an import or an edit.
 *
 * With one worker per CPU those maps silently fork, so a replay would be
 * accepted once per worker and a second worker would keep serving stale report
 * data for the whole cache TTL. The cluster primary (src/cluster.js) therefore
 * owns the single copy and the workers proxy to it over Node's built-in IPC
 * channel (see startPrimaryStore below).
 *
 * Everything keeps working when the app runs as a single process (local
 * development) or if the IPC channel is unavailable: the same API falls back to
 * local in-process maps, which is exactly the previous behaviour.
 */

const cluster = require('cluster');

const TYPES = {
  request: 'vas-shared-request',
  reply: 'vas-shared-reply',
  generation: 'vas-generation',
};

// A half-second stall on login is worse than a slightly weaker replay guard, so
// an unanswered call falls back to local state instead of waiting forever.
const REMOTE_TIMEOUT_MS = 1000;

let ipcAvailable = !!(cluster.isWorker && typeof process.send === 'function');
let seq = 0;
const pending = new Map(); // reqId -> { resolve, timer }

/* ── Local (single-process) state, also the fallback when IPC is down ─────── */

const localOnce = new Map();   // key -> expiry ms
const localRate = new Map();   // key -> { start, n }
const generations = new Map(); // route prefix -> counter

const listeners = []; // (route) => void, notified on any generation change

if (ipcAvailable) {
  process.on('message', (msg) => {
    if (!msg || typeof msg !== 'object' || !msg.type) return;
    if (msg.type === TYPES.reply) {
      const entry = pending.get(msg.reqId);
      if (entry) {
        pending.delete(msg.reqId);
        clearTimeout(entry.timer);
        entry.resolve(msg.result);
      }
    } else if (msg.type === TYPES.generation) {
      applyGeneration(msg.route, msg.generation);
    }
  });

  // The primary is gone (pm2 restart, crash) — run on local state rather than
  // stalling every login behind a dead channel.
  process.on('disconnect', () => {
    ipcAvailable = false;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    pending.clear();
  });
}

function ask(op, payload) {
  if (!ipcAvailable) return Promise.resolve(null);
  const reqId = `${process.pid}-${++seq}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(reqId);
      ipcAvailable = false;
      resolve(null);
    }, REMOTE_TIMEOUT_MS);
    pending.set(reqId, { resolve, timer });
    try {
      process.send({ type: TYPES.request, reqId, op, payload });
    } catch {
      clearTimeout(timer);
      pending.delete(reqId);
      ipcAvailable = false;
      resolve(null);
    }
  });
}

/* ── Worker-facing API ────────────────────────────────────────────────────── */

/**
 * Claim a short-lived single-use key (captcha challenge signature).
 * @returns {Promise<boolean>} true when the key was already claimed elsewhere —
 *          i.e. this is a replay and the caller must reject it.
 */
async function consumeOnce(key, ttlMs) {
  const remote = await ask('once.consume', { key, ttlMs });
  if (remote === true || remote === false) return remote;

  const now = Date.now();
  const expires = localOnce.get(key);
  if (typeof expires === 'number' && expires > now) return true;
  localOnce.set(key, now + Math.max(1000, Number(ttlMs) || 0));
  return false;
}

/**
 * Count a hit against a fixed window and return the number of hits seen in the
 * current window (the caller compares it against its own limit).
 */
async function rateHit(key, windowMs) {
  const window = Math.max(1000, Number(windowMs) || 60000);
  const remote = await ask('rate.hit', { key, windowMs: window });
  if (typeof remote === 'number') return remote;

  const now = Date.now();
  let bucket = localRate.get(key);
  if (!bucket || now - bucket.start > window) {
    bucket = { start: now, n: 0 };
    localRate.set(key, bucket);
  }
  bucket.n += 1;
  return bucket.n;
}

/** Current generation for a cache key prefix (0 = never invalidated). */
function generation(route) {
  let total = 0;
  for (const [prefix, counter] of generations) {
    if (!prefix || (route && route.startsWith(prefix))) total += counter;
  }
  return total;
}

/**
 * Mark a route's cached responses as stale. Bumps the local counter
 * immediately (so this worker is consistent even without IPC) and asks the
 * primary to bump the shared counter, which broadcasts the new value to every
 * worker — including this one, where it is applied as a max().
 */
function bumpGeneration(route) {
  const prefix = route || '';
  const next = (generations.get(prefix) || 0) + 1;
  generations.set(prefix, next);
  notify(prefix);
  ask('gen.bump', { route: prefix }).then((shared) => {
    if (typeof shared === 'number' && shared > 0) applyGeneration(prefix, shared);
  });
  return next;
}

/** Run fn(route) whenever a generation changes, locally or in another worker. */
function onGenerationChange(fn) {
  listeners.push(fn);
}

/* ── Generation bookkeeping ───────────────────────────────────────────────── */

function applyGeneration(route, value) {
  const prefix = route || '';
  const next = Number(value) || 0;
  if (next <= (generations.get(prefix) || 0)) return;
  generations.set(prefix, next);
  notify(prefix);
}

function notify(route) {
  for (const fn of listeners) {
    try { fn(route); } catch (err) { console.error('[shared-state] listener failed:', err.message); }
  }
}

// Keep the fallback maps from growing without bound.
setInterval(() => {
  const now = Date.now();
  for (const [k, exp] of localOnce) if (exp <= now) localOnce.delete(k);
  for (const [k, b] of localRate) if (now - b.start > 60000) localRate.delete(k);
}, 60_000).unref();

/* ── Primary-side store: the authoritative single copy ────────────────────── */

/**
 * Start the store in the cluster primary and wire it to the workers. Called by
 * src/cluster.js only in the primary process.
 * @returns {{once: Map, rate: Map, generations: Map}} store handles, for tests.
 */
function startPrimaryStore() {
  const once = new Map();        // key -> expiry ms
  const rate = new Map();        // key -> { start, n }
  const state = new Map();       // route prefix -> counter

  setInterval(() => {
    const now = Date.now();
    for (const [k, exp] of once) if (exp <= now) once.delete(k);
    for (const [k, b] of rate) if (now - b.start > 60000) rate.delete(k);
  }, 60_000).unref();

  const handlers = {
    'once.consume': (payload) => {
      const key = String(payload.key || '');
      const now = Date.now();
      const expires = once.get(key);
      const already = typeof expires === 'number' && expires > now;
      once.set(key, now + Math.max(1000, Number(payload.ttlMs) || 0));
      return already;
    },
    'rate.hit': (payload) => {
      const key = String(payload.key || '');
      const window = Math.max(1000, Number(payload.windowMs) || 60000);
      const now = Date.now();
      let bucket = rate.get(key);
      if (!bucket || now - bucket.start > window) {
        bucket = { start: now, n: 0 };
        rate.set(key, bucket);
      }
      bucket.n += 1;
      return bucket.n;
    },
    'gen.bump': (payload) => {
      const prefix = String(payload.route || '');
      const next = (state.get(prefix) || 0) + 1;
      state.set(prefix, next);
      for (const worker of Object.values(cluster.workers || {})) {
        if (!worker) continue;
        try { worker.send({ type: TYPES.generation, route: prefix, generation: next }); } catch {}
      }
      return next;
    },
  };

  cluster.on('message', (worker, msg) => {
    if (!msg || msg.type !== TYPES.request) return;
    const handler = handlers[msg.op];
    let result = null;
    if (handler) {
      try { result = handler(msg.payload || {}); }
      catch (err) { console.error(`[cluster] shared state ${msg.op} failed:`, err.message); }
    }
    try { worker.send({ type: TYPES.reply, reqId: msg.reqId, result }); } catch {}
  });

  return { once, rate, generations: state };
}

module.exports = {
  TYPES,
  consumeOnce,
  rateHit,
  generation,
  bumpGeneration,
  onGenerationChange,
  startPrimaryStore,
};
