/**
 * Simple in-memory endpoint response cache.
 * Caches the entire JSON response for a given key + params combination.
 *
 * In cluster mode every worker keeps its own Map, so invalidation cannot be a
 * local delete: the key carries a generation that only changes when the route
 * is invalidated. Bumping the generation (utils/sharedState.js) makes the entry
 * unreachable in this worker and, via the cluster primary, in every other one —
 * an import therefore stops the second worker from serving stale reports for
 * the rest of the TTL.
 */

const { generation, bumpGeneration, onGenerationChange } = require('./sharedState');

const _cache = new Map();
const DEFAULT_TTL = 15 * 60 * 1000; // 15 minutes

function cacheKey(route, params) {
  const sorted = Object.keys(params || {}).sort().map(k => `${k}=${params[k]}`).join('&');
  return `${route}#${generation(route)}?${sorted}`;
}

function getCached(route, params) {
  const key = cacheKey(route, params);
  const entry = _cache.get(key);
  if (entry && (Date.now() - entry.ts) < (entry.ttl || DEFAULT_TTL)) {
    return entry.data;
  }
  _cache.delete(key);
  return null;
}

function setCached(route, params, data, ttlMs) {
  const key = cacheKey(route, params);
  _cache.set(key, { data, ts: Date.now(), ttl: ttlMs || DEFAULT_TTL });
  // Evict stale entries
  if (_cache.size > 100) {
    for (const [k, v] of _cache) {
      if (Date.now() - v.ts > (v.ttl || DEFAULT_TTL)) _cache.delete(k);
    }
  }
}

function invalidate(route) {
  // Bump instead of delete: the generation change also reaches the other
  // workers (see above), and the listener below drops this worker's entries.
  bumpGeneration(route || '');
}

// Local purge whenever a generation changes, whether this worker caused it or
// another one did. Also keeps the Map from accumulating dead generations.
onGenerationChange((route) => {
  for (const key of _cache.keys()) {
    if (!route || key.startsWith(route)) _cache.delete(key);
  }
});

module.exports = { getCached, setCached, invalidate };
