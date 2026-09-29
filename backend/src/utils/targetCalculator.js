/**
 * Mode-aware revenue target calculator.
 *
 * Each service picks how its revenue_targets rows are spread over the fiscal
 * period:
 *   - 'automatic' (default): the legacy behaviour — a target's amount is split
 *     equally across the months its window covers.
 *   - 'manual': an admin allocates the target month by month in
 *     revenue_target_allocations (service_id, target_id, target_month YYYY-MM,
 *     allocated_amount). Reports then use those allocations instead of the
 *     equal split.
 *
 * The setting is per TARGET (a service can have automatic yearly targets plus
 * one manually allocated fiscal-year target), stored on revenue_targets itself
 * so every existing row keeps working with zero data migration.
 *
 * Consumers call getMonthlyTargetMap() / getPeriodTargetMap() and get the same
 * shape they built inline before — legacy equal-split behaviour is byte-for-byte
 * compatible when every service is in 'automatic' mode.
 */
const pool = require('../config/database');

// ── Schema (self-healing, cheap, run once per process) ────────────────────────
async function ensureTargetAllocationSchema() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS revenue_target_allocations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        target_id INT NOT NULL,
        service_id INT NULL,
        service_name VARCHAR(255) NULL,
        target_month CHAR(7) NOT NULL,
        allocated_amount DECIMAL(15, 2) NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_target_month (target_id, target_month),
        INDEX idx_alloc_service_month (service_name, target_month),
        CONSTRAINT fk_alloc_target FOREIGN KEY (target_id) REFERENCES revenue_targets(id) ON DELETE CASCADE
      )
    `);
  } catch (e) {
    // 1824 = failed to open FK table (revenue_targets missing at cold start) —
    // the table is still usable without the FK; other errors are logged once.
    if (e.code !== 'ER_CANT_CREATE_TABLE' && e.errno !== 1824) {
      console.error('[targetCalculator] allocation table check failed:', e.message);
    }
  }
  try {
    await pool.execute(`ALTER TABLE revenue_targets ADD COLUMN IF NOT EXISTS allocation_mode ENUM('automatic','manual') NOT NULL DEFAULT 'automatic'`);
  } catch (e) {
    // Older MySQL < 8.0.29 lacks IF NOT EXISTS on ADD COLUMN — ignore the
    // duplicate-column error it raises when the column already exists.
    if (e.code !== 'ER_DUP_FIELDNAME') {
      console.error('[targetCalculator] allocation_mode column check failed:', e.message);
    }
  }
}
// Fire and forget at load, and gate the per-call path behind a flag so hot
// request paths (alerts/dashboard per request) don't re-run DDL every time.
let schemaReady = false;
ensureTargetAllocationSchema().then(() => { schemaReady = true; }).catch(() => { schemaReady = true; });

async function ensureReady() {
  if (!schemaReady) {
    await ensureTargetAllocationSchema();
    schemaReady = true;
  }
}

function monthOf(v) {
  if (!v) return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`;
  const s = String(v);
  return s.length >= 7 ? s.substring(0, 7) : null;
}

/**
 * Fetch allocations grouped by target_id: { [target_id]: { 'YYYY-MM': amount } }.
 * When targetIds is empty, returns {} without querying.
 */
async function getAllocationsByTarget(targetIds) {
  if (!targetIds || targetIds.length === 0) return {};
  const ph = targetIds.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT target_id, target_month, allocated_amount FROM revenue_target_allocations WHERE target_id IN (${ph})`,
    targetIds
  );
  const map = {};
  for (const r of rows) {
    if (!map[r.target_id]) map[r.target_id] = {};
    map[r.target_id][r.target_month] = parseFloat(r.allocated_amount) || 0;
  }
  return map;
}

/**
 * Core resolver. Given the (already service-joined) target rows, produce:
 *   monthly: { [service_name]: { 'YYYY-MM': amount } }
 * The mode is read per target row (t.allocation_mode). Manual targets use
 * their allocations clipped to the requested window; automatic targets keep
 * the legacy equal monthly share for every month the target covers.
 */
async function resolveMonthlyTargets(targets, { startMonth, endMonth } = {}) {
  await ensureReady();
  const manualTargets = targets.filter((t) => t.allocation_mode === 'manual');
  const allocByTarget = await getAllocationsByTarget(manualTargets.map((t) => t.id));

  const monthly = {};
  for (const t of targets) {
    const svc = t.service_name;
    if (!svc) continue;
    const start = monthOf(t.target_start_date);
    const end = monthOf(t.target_end_date);
    if (!start || !end) continue;

    if (t.allocation_mode === 'manual') {
      const alloc = allocByTarget[t.id] || {};
      for (const [m, amount] of Object.entries(alloc)) {
        if (startMonth && m < startMonth) continue;
        if (endMonth && m > endMonth) continue;
        if (monthly[svc] === undefined) monthly[svc] = {};
        monthly[svc][m] = (monthly[svc][m] || 0) + amount;
      }
    } else {
      // Legacy: equal share of the target across each month it covers.
      const months = [];
      let y = parseInt(start.substring(0, 4), 10);
      let m = parseInt(start.substring(5, 7), 10);
      const endY = parseInt(end.substring(0, 4), 10);
      const endM = parseInt(end.substring(5, 7), 10);
      while (y < endY || (y === endY && m <= endM)) {
        const key = `${y}-${String(m).padStart(2, '0')}`;
        if ((!startMonth || key >= startMonth) && (!endMonth || key <= endMonth)) {
          if (monthly[svc] === undefined) monthly[svc] = {};
          monthly[svc][key] = (monthly[svc][key] || 0) + 0; // placeholder, replaced below
        }
        months.push(key);
        m++;
        if (m > 12) { m = 1; y++; }
      }
      const n = months.length;
      if (n > 0 && monthly[svc]) {
        const share = (parseFloat(t.target_amount) || 0) / n;
        for (const key of months) {
          if ((!startMonth || key >= startMonth) && (!endMonth || key <= endMonth)) {
            monthly[svc][key] = (monthly[svc][key] || 0) + share;
          }
        }
      }
    }
  }
  return monthly;
}

/** Sum monthly maps into period totals: { [service_name]: number } */
function sumMonthly(monthly) {
  const totals = {};
  for (const [svc, months] of Object.entries(monthly)) {
    totals[svc] = Object.values(months).reduce((s, v) => s + v, 0);
  }
  return totals;
}

/**
 * Convenience wrapper used by alerts/dashboard/reports: fetch the target rows
 * overlapping a window, resolve them, and return both the monthly map and the
 * period totals. `rows` come from the caller's own query so its WHERE-clause
 * semantics stay untouched.
 */
async function monthlyAndTotals(rows, { startMonth, endMonth } = {}) {
  const monthly = await resolveMonthlyTargets(rows, { startMonth, endMonth });
  return { monthly, totals: sumMonthly(monthly) };
}

module.exports = {
  ensureTargetAllocationSchema,
  resolveMonthlyTargets,
  getAllocationsByTarget,
  sumMonthly,
  monthlyAndTotals,
  monthOf,
  ensureReady,
};
