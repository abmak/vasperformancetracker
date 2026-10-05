/**
 * Node.js cluster bootstrap.
 *
 * Every pm2 process on this box ran in fork mode with a single instance, so the
 * whole API was pinned to one core — including CPU-bound work such as bcrypt
 * password checks, report aggregation and Excel parsing. In production this
 * module forks one worker per CPU core and supervises them, so HTTP work and
 * CPU work spread across every core while the primary process only supervises.
 *
 * src/server.js calls bootstrapCluster() first: when it returns true this
 * process is the primary and must not build the Express app; the workers
 * re-run the same file, get false, and serve HTTP exactly as before.
 *
 * Worker count: CLUSTER_WORKERS (or WEB_CONCURRENCY) overrides it, 1 disables
 * clustering, and the default is one per core in production — and a single
 * process everywhere else, so `npm run dev` behaves as before.
 */

const cluster = require('cluster');
const os = require('os');

const { startPrimaryStore } = require('./utils/sharedState');

const MAX_WORKERS = 4;          // more workers than this only adds RAM pressure
const RESTART_DELAY_MS = 1000;
const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 10;         // give up (and let pm2 report the failure)
const SHUTDOWN_GRACE_MS = 3000;

function workerCount() {
  const raw = process.env.CLUSTER_WORKERS ?? process.env.WEB_CONCURRENCY;
  if (raw !== undefined && raw !== '') {
    const requested = Number(raw);
    if (Number.isFinite(requested) && requested >= 0) return Math.floor(requested);
  }
  if (process.env.NODE_ENV !== 'production') return 1;
  return Math.max(1, Math.min(os.cpus().length, MAX_WORKERS));
}

let decided = false;

/**
 * @returns {boolean} true when this process started (and is supervising) the
 *          worker pool and therefore should not run the app itself.
 */
function bootstrapCluster() {
  if (decided) return false;
  decided = true;

  if (!cluster.isPrimary) {
    // Workers must never outlive the primary: pm2 kills only the process it
    // started, so a worker left behind would still hold the port and the next
    // boot would fail with EADDRINUSE.
    process.on('disconnect', () => process.exit(0));
    console.log(`[cluster] worker ${process.env.NODE_APP_INSTANCE ?? '?'} up (pid ${process.pid})`);
    return false;
  }

  const count = workerCount();
  if (count <= 1) {
    console.log('[cluster] single-process mode');
    return false;
  }

  startPrimary(count);
  console.log(`[cluster] primary ${process.pid} supervising ${count} workers (${os.cpus().length} vCPU)`);
  return true;
}

function startPrimary(count) {
  startPrimaryStore();

  // Round-robin across workers (the default on Linux, but stated explicitly
  // because it must be set before the first worker is forked). Windows cannot
  // pass listening handles, so there a single process is used anyway.
  cluster.schedulingPolicy = cluster.SCHED_RR;

  const slots = new Map(); // worker.id -> slot index (for NODE_APP_INSTANCE)
  let nextSlot = 0;
  let shuttingDown = false;
  let restarts = [];

  const fork = (slot) => {
    const worker = cluster.fork({
      NODE_APP_INSTANCE: String(slot),
      VAS_CLUSTER_WORKER: '1',
    });
    slots.set(worker.id, slot);
    return worker;
  };

  for (let i = 0; i < count; i++) fork(nextSlot++ % count);

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) return;

    const now = Date.now();
    restarts = restarts.filter((ts) => now - ts < CRASH_WINDOW_MS);
    restarts.push(now);
    if (restarts.length > CRASH_LIMIT) {
      console.error(`[cluster] workers keep dying (${restarts.length} in ${CRASH_WINDOW_MS / 1000}s) — stopping`);
      process.exit(1);
    }

    const slot = slots.has(worker.id) ? slots.get(worker.id) : nextSlot++ % count;
    slots.delete(worker.id);
    console.error(`[cluster] worker ${worker.process.pid} exited (${signal || code}) — restarting in ${RESTART_DELAY_MS}ms`);
    setTimeout(() => fork(slot), RESTART_DELAY_MS).unref();
  });

  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const workers = Object.values(cluster.workers || {}).filter(Boolean);
    console.log(`[cluster] ${signal} received — stopping ${workers.length} worker(s)`);

    const deadline = setTimeout(() => {
      for (const worker of workers) {
        try { worker.process.kill('SIGKILL'); } catch {}
      }
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);

    let remaining = workers.length;
    const finish = () => {
      if (--remaining > 0) return;
      clearTimeout(deadline);
      process.exit(0);
    };
    for (const worker of workers) {
      worker.once('exit', finish);
      try { worker.process.kill('SIGTERM'); } catch { finish(); }
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(signal));
}

function isClusterWorker() {
  return !!process.env.VAS_CLUSTER_WORKER;
}

/** Short label for responses/logs — which process answered a request. */
function workerLabel() {
  return isClusterWorker() ? `w${process.env.NODE_APP_INSTANCE}` : 'solo';
}

module.exports = { bootstrapCluster, workerCount, isClusterWorker, workerLabel };
