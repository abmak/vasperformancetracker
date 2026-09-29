const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { resolveMonthlyTargets } = require('../utils/targetCalculator');

// Create goal_cascades table (keyed by service + period dates, no fiscal-year unique)
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS goal_cascades (
      id INT AUTO_INCREMENT PRIMARY KEY,
      service_id INT NOT NULL,
      service_name VARCHAR(255),
      fiscal_year INT,
      annual_target DECIMAL(15, 2) NOT NULL,
      target_start_date DATE,
      target_end_date DATE,
      cascade_method ENUM('equal', 'weighted', 'custom') DEFAULT 'equal',
      status ENUM('draft', 'active', 'archived') DEFAULT 'active',
      created_by VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (service_id) REFERENCES vas_services(id) ON DELETE CASCADE,
      INDEX idx_cascade_period (service_id, target_start_date, target_end_date)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS goal_cascade_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      cascade_id INT NOT NULL,
      level ENUM('yearly', 'semi_annual', 'quarterly') NOT NULL,
      period_label VARCHAR(50) NOT NULL,
      period_start DATE,
      period_end DATE,
      target_amount DECIMAL(15, 2) NOT NULL,
      actual_revenue DECIMAL(15, 2) DEFAULT 0,
      achievement_pct DECIMAL(7, 2) DEFAULT 0,
      weight DECIMAL(5, 2) DEFAULT 1.0,
      parent_item_id INT,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cascade_id) REFERENCES goal_cascades(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_item_id) REFERENCES goal_cascade_items(id) ON DELETE SET NULL
    )
  `);
}
ensureTable().catch(() => {});

// GET all cascades overlapping a date period.
// The list is driven by the service's REVENUE TARGETS (the source of truth): every
// service with any target overlapping the window appears once, with all its targets
// merged month-by-month — even if its stored cascade row has different dates.
router.get('/', async (req, res) => {
  try {
    const { start_date, end_date, service_id, status } = req.query;
    const fS = ymdStr(start_date);
    const fE = ymdStr(end_date);

    // When a window is selected, build the list from revenue_targets overlap.
    if (fS && fE) {
      const targetParams = [fE, fS];
      let targetQuery = `
        SELECT DISTINCT COALESCE(vs.id, rt.service_id) as service_id,
          COALESCE(vs.name, rt.service_name) as service_name,
          COALESCE(vs.code, '') as service_code
        FROM revenue_targets rt
        LEFT JOIN vas_services vs ON rt.service_id = vs.id
        WHERE rt.target_amount > 0
          AND rt.target_start_date IS NOT NULL AND rt.target_end_date IS NOT NULL
          AND rt.target_start_date > '1000-01-01' AND rt.target_end_date > '1000-01-01'
          AND DATE_FORMAT(rt.target_start_date, '%Y-%m') <= DATE_FORMAT(?, '%Y-%m')
          AND DATE_FORMAT(rt.target_end_date, '%Y-%m') >= DATE_FORMAT(?, '%Y-%m')
          AND (rt.service_id IS NULL OR vs.status = 'active')
      `;
      if (service_id) { targetQuery += ' AND rt.service_id = ?'; targetParams.push(service_id); }
      if (status) { targetQuery += ' AND rt.status = ?'; targetParams.push(status); }
      targetQuery += ' ORDER BY service_name ASC';
      const [svcRows] = await pool.execute(targetQuery, targetParams);

      // Load the stored cascade row (if any) per service to preserve id/method/status
      const svcIds = svcRows.map(r => r.service_id).filter(v => v !== null && v !== undefined);
      const storedBySvc = {};
      if (svcIds.length) {
        const [stored] = await pool.execute(
          `SELECT * FROM goal_cascades WHERE service_id IN (${svcIds.map(() => '?').join(',')})`,
          svcIds
        );
        for (const s of stored) if (!storedBySvc[s.service_id]) storedBySvc[s.service_id] = s;
      }

      const [allT] = await pool.execute(
        `SELECT id, service_id, service_name, target_amount, target_start_date, target_end_date, period_type, allocation_mode
         FROM revenue_targets
         WHERE target_amount > 0
           AND (service_id IS NULL OR service_id IN (SELECT id FROM vas_services WHERE status = 'active'))`
      );

      const cascades = [];
      for (const svc of svcRows) {
        const stored = storedBySvc[svc.service_id];
        const c = stored
          ? { ...stored, service_name: svc.service_name, service_name_fallback: svc.service_name, service_code: svc.service_code }
          : { id: -(svc.service_id || 0), service_id: svc.service_id, service_name: svc.service_name, service_name_fallback: svc.service_name, service_code: svc.service_code, cascade_method: 'equal', status: 'active', annual_target: 0 };
        const svcTargets = targetsWithStr(allT.filter(t => t.service_id === svc.service_id));
        const win = await buildCascadeWindow(svcTargets, fS, fE);
        if (!win) continue;
        c.annual_target = win.target;
        c.target_start_date = win.start;
        c.target_end_date = win.end;
        c.effective_start = win.start;
        c.effective_end = win.end;
        c.effective_target = win.target;
        c.effective_actual = await revenueInWindow(svc.service_name, win.start, win.end);
        c.effective_achievement = win.target > 0 ? Math.round((c.effective_actual / win.target) * 10000) / 100 : 0;
        // Per-period targets for the card pills (real monthly-prorated values)
        const built = buildCascadeItems(svc.service_name, win.start, win.end, win.months);
        c.effective_yearly_target = built.yearly[0] ? built.yearly[0].target_amount : win.target;
        c.effective_semi_target = built.semiAnnual.length ? Math.round((built.semiAnnual.reduce((s, x) => s + Number(x.target_amount || 0), 0) / built.semiAnnual.length) * 100) / 100 : win.target / 2;
        c.effective_quarterly_target = built.quarterly.length ? Math.round((built.quarterly.reduce((s, x) => s + Number(x.target_amount || 0), 0) / built.quarterly.length) * 100) / 100 : win.target / 4;
        cascades.push(c);
      }
      return res.json(cascades);
    }

    // No window: fall back to stored cascades (unchanged behaviour)
    let query = `
      SELECT gc.*, vs.name as service_name_fallback, vs.code as service_code,
        (SELECT SUM(target_amount) FROM goal_cascade_items WHERE cascade_id = gc.id AND level = 'yearly') as total_yearly,
        (SELECT SUM(target_amount) FROM goal_cascade_items WHERE cascade_id = gc.id AND level = 'semi_annual') as total_semi,
        (SELECT SUM(target_amount) FROM goal_cascade_items WHERE cascade_id = gc.id AND level = 'quarterly') as total_quarterly,
        (SELECT SUM(actual_revenue) FROM goal_cascade_items WHERE cascade_id = gc.id AND level = 'yearly') as total_actual,
        (SELECT CASE WHEN SUM(target_amount) > 0 THEN ROUND(SUM(actual_revenue) / SUM(target_amount) * 100, 2) ELSE 0 END FROM goal_cascade_items WHERE cascade_id = gc.id AND level = 'yearly') as overall_achievement
      FROM goal_cascades gc
      LEFT JOIN vas_services vs ON gc.service_id = vs.id
      WHERE 1=1
    `;
    const params = [];
    if (service_id) { query += ' AND gc.service_id = ?'; params.push(service_id); }
    if (status) { query += ' AND gc.status = ?'; params.push(status); }
    if (start_date) { query += ' AND gc.target_end_date >= ?'; params.push(ymdStr(start_date)); }
    if (end_date) { query += ' AND gc.target_start_date <= ?'; params.push(ymdStr(end_date)); }
    query += ' ORDER BY gc.service_name ASC';
    const [rows] = await pool.execute(query, params);
    res.json(rows.map(serCascade));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET single cascade with all items + achievement
router.get('/:id', async (req, res) => {
  try {
    const [cascade] = await pool.execute(
      `SELECT gc.*, vs.name as service_name_fallback FROM goal_cascades gc
       LEFT JOIN vas_services vs ON gc.service_id = vs.id WHERE gc.id = ?`,
      [req.params.id]
    );
    if (cascade.length === 0) return res.status(404).json({ error: 'Cascade not found' });

    const [items] = await pool.execute(
      `SELECT * FROM goal_cascade_items WHERE cascade_id = ? ORDER BY
        FIELD(level, 'yearly', 'semi_annual', 'quarterly'),
        period_start ASC`,
      [req.params.id]
    );

    const c0 = cascade[0];
    const serviceName = c0.service_name;

    // When a reporting window is selected, build the yearly / semi-annual / quarterly
    // periods ON DEMAND from the service's own revenue-target period (the source of
    // truth): periods are anchored at the window/target start (e.g. Jul 1 stays Jul 1)
    // and the target is the FULL target amount — never pro-rated. This guarantees the
    // dates and targets always match the selected filter, regardless of stale stored rows.
    const { start_date, end_date } = req.query;
    if (start_date && end_date) {
      const fS = ymdStr(start_date);
      const fE = ymdStr(end_date);
      const [allT] = await pool.execute(
        `SELECT id, service_id, service_name, target_amount, target_start_date, target_end_date, period_type, allocation_mode
         FROM revenue_targets
         WHERE service_id = ? AND target_amount > 0
           AND (service_id IS NULL OR service_id IN (SELECT id FROM vas_services WHERE status = 'active'))`, [c0.service_id]
      );
      const win = await buildCascadeWindow(targetsWithStr(allT), fS, fE);
      if (win) {
        const built = buildCascadeItems(serviceName, win.start, win.end, win.months);
        await fillCascadeActuals(serviceName, built.all);
        c0.annual_target = win.target;
        c0.target_start_date = win.start;
        c0.target_end_date = win.end;
        res.json({
          ...serCascade(c0),
          yearly: built.yearly,
          semiAnnual: built.semiAnnual,
          quarterly: built.quarterly,
          items: built.all,
        });
        return;
      }
    }

    // Fall back to the stored items when no window was given (or no overlapping target).
    const yearly = items.filter(i => i.level === 'yearly');
    const semiAnnual = items.filter(i => i.level === 'semi_annual');
    const quarterly = items.filter(i => i.level === 'quarterly');

    res.json({ ...serCascade(c0), yearly: serItems(yearly), semiAnnual: serItems(semiAnnual), quarterly: serItems(quarterly), items: serItems(items) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST create cascade manually for a period
router.post('/', async (req, res) => {
  try {
    const { service_id, service_name, annual_target, target_start_date, target_end_date, cascade_method, created_by } = req.body;
    if (!service_id || !annual_target || !target_start_date || !target_end_date) {
      return res.status(400).json({ error: 'Service, annual target, start date and end date are required' });
    }

    let serviceName = service_name;
    if (!serviceName) {
      const [svc] = await pool.execute('SELECT name FROM vas_services WHERE id = ?', [service_id]);
      if (svc.length > 0) serviceName = svc[0].name;
    }

    const start = toDateStr(target_start_date);
    const end = toDateStr(target_end_date);
    const cascadeId = await upsertCascade(service_id, serviceName, parseFloat(annual_target), start, end, cascade_method || 'equal', created_by || 'System');

    const [cascade] = await pool.execute(
      `SELECT gc.*, vs.name as service_name_fallback FROM goal_cascades gc
       LEFT JOIN vas_services vs ON gc.service_id = vs.id WHERE gc.id = ?`,
      [cascadeId]
    );
    const [items] = await pool.execute(
      'SELECT * FROM goal_cascade_items WHERE cascade_id = ? ORDER BY FIELD(level, \'yearly\', \'semi_annual\', \'quarterly\'), period_start ASC',
      [cascadeId]
    );

    res.status(201).json({
      ...serCascade(cascade[0]),
      yearly: serItems(items.filter(i => i.level === 'yearly')),
      semiAnnual: serItems(items.filter(i => i.level === 'semi_annual')),
      quarterly: serItems(items.filter(i => i.level === 'quarterly')),
      items: serItems(items),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT update cascade (period target/dates/method)
router.put('/:id', async (req, res) => {
  try {
    const { annual_target, target_start_date, target_end_date, cascade_method, status } = req.body;
    const [cascade] = await pool.execute('SELECT * FROM goal_cascades WHERE id = ?', [req.params.id]);
    if (cascade.length === 0) return res.status(404).json({ error: 'Cascade not found' });
    const c = cascade[0];

    const start = toDateStr(target_start_date) || c.target_start_date;
    const end = toDateStr(target_end_date) || c.target_end_date;
    const newTarget = parseFloat(annual_target) || parseFloat(c.annual_target);

    // If the period changed, drop the old cascade entirely and recreate (keeps identity by period)
    await pool.execute('DELETE FROM goal_cascade_items WHERE cascade_id = ?', [req.params.id]);
    await pool.execute('DELETE FROM goal_cascades WHERE id = ?', [req.params.id]);

    const cascadeId = await upsertCascade(c.service_id, c.service_name, newTarget, start, end, cascade_method || c.cascade_method || 'equal', c.created_by || 'System');
    const cascadeStatus = status || c.status || 'active';
    if (cascadeStatus !== 'active') {
      await pool.execute('UPDATE goal_cascades SET status = ? WHERE id = ?', [cascadeStatus, cascadeId]);
    }

    const [updated] = await pool.execute(
      `SELECT gc.*, vs.name as service_name_fallback FROM goal_cascades gc
       LEFT JOIN vas_services vs ON gc.service_id = vs.id WHERE gc.id = ?`,
      [cascadeId]
    );
    const [items] = await pool.execute(
      'SELECT * FROM goal_cascade_items WHERE cascade_id = ? ORDER BY FIELD(level, \'yearly\', \'semi_annual\', \'quarterly\'), period_start ASC',
      [cascadeId]
    );

    res.json({
      ...serCascade(updated[0]),
      yearly: serItems(items.filter(i => i.level === 'yearly')),
      semiAnnual: serItems(items.filter(i => i.level === 'semi_annual')),
      quarterly: serItems(items.filter(i => i.level === 'quarterly')),
      items: serItems(items),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE cascade
router.delete('/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM goal_cascades WHERE id = ?', [req.params.id]);
    res.json({ message: 'Cascade deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST auto-generate cascades for ALL services for the given date period.
// The target for each service comes from the revenue_targets record(s) whose
// own date window overlaps the requested period, pro-rated by overlapping months.
router.post('/auto-generate', async (req, res) => {
  try {
    const { start_date, end_date, fiscal_year, created_by } = req.body;
    let periodStart = start_date || (fiscal_year ? `${fiscal_year}-01-01` : null);
    let periodEnd = end_date || (fiscal_year ? `${fiscal_year}-12-31` : null);
    if (!periodStart || !periodEnd) {
      return res.status(400).json({ error: 'Start date and end date are required' });
    }
    periodStart = toDateStr(periodStart);
    periodEnd = toDateStr(periodEnd);

    const [services] = await pool.execute('SELECT * FROM vas_services WHERE status = ?', ['active']);

    // All revenue targets (any period type) carrying their own windows
    const [allTargets] = await pool.execute(
      `SELECT service_id, service_name, target_amount, target_start_date, target_end_date, period_type
       FROM revenue_targets
       WHERE target_amount > 0 AND target_start_date IS NOT NULL AND target_end_date IS NOT NULL`
    );

    const results = [];
    for (const service of services) {
      // Normalize target dates to YYYY-MM-DD strings (mysql2 returns Date objects)
      const targetsWithStr = allTargets
        .filter(t => t.service_id === service.id)
        .map(t => ({
          ...t,
          startStr: toDateStr(t.target_start_date),
          endStr: toDateStr(t.target_end_date),
          startMonth: monthOf(t.target_start_date),
          endMonth: monthOf(t.target_end_date),
        }));

      // Find targets overlapping the period (by month window)
      const pStartMonth = monthOf(periodStart);
      const pEndMonth = monthOf(periodEnd);
      const overlapping = targetsWithStr.filter(t =>
        t.startStr && t.endStr && t.startMonth <= pEndMonth && t.endMonth >= pStartMonth
      );
      if (overlapping.length === 0) continue;

      const yearly = overlapping.find(t => t.period_type === 'yearly');
      const primary = yearly || overlapping[0];

      // Cascade spans the intersection of the requested period and the target window
      const start = laterDate(primary.startStr, toDateStr(periodStart));
      const end = earlierDate(primary.endStr, toDateStr(periodEnd));
      if (start > end) continue;

      // Use the FULL primary target amount (the target's own window defines the
      // amount; no month pro-rating) so e.g. a 10B yearly target stays 10B.
      // Manual-allocation targets: the cascade amount is the sum of the admin-set
      // monthly allocations inside the cascade window, and the items distribute
      // those real month values instead of an equal split.
      const manualSiblings = overlapping.filter(t => t.allocation_mode === 'manual');
      let amount = 0;
      let monthlyMap = null;
      if (manualSiblings.length > 0) {
        const manualMonthly = await resolveMonthlyTargets(manualSiblings);
        monthlyMap = {};
        for (const t of manualSiblings) {
          const m = manualMonthly[t.service_name] || {};
          for (const [k, v] of Object.entries(m)) monthlyMap[k] = (monthlyMap[k] || 0) + v;
        }
        const winStart = monthOf(start), winEnd = monthOf(end);
        amount = Object.entries(monthlyMap)
          .filter(([k]) => (!winStart || k >= winStart) && (!winEnd || k <= winEnd))
          .reduce((s, [, v]) => s + v, 0);
      } else {
        amount = parseFloat(primary.target_amount) || 0;
      }
      if (amount <= 0) continue;

      const cascadeId = await upsertCascade(service.id, service.name, amount, start, end, manualSiblings.length ? 'manual' : 'equal', created_by || 'System', monthlyMap);
      results.push({ service: service.name, annual_target: amount, start, end, cascade_id: cascadeId });
    }

    res.json({ message: `Generated cascades for ${results.length} services`, services: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST refresh achievement data for cascades overlapping a period
router.post('/refresh-achievements', async (req, res) => {
  try {
    const { start_date, end_date, fiscal_year } = req.body;
    let query = 'SELECT id FROM goal_cascades WHERE 1=1';
    const params = [];
    if (start_date && end_date) {
      query += ' AND target_start_date <= ? AND target_end_date >= ?';
      params.push(ymdStr(end_date), ymdStr(start_date));
    } else if (fiscal_year) {
      query += ' AND (target_start_date BETWEEN ? AND ? OR target_end_date BETWEEN ? AND ?)';
      params.push(`${fiscal_year}-01-01`, `${fiscal_year}-12-31`, `${fiscal_year}-01-01`, `${fiscal_year}-12-31`);
    }
    const [cascades] = await pool.execute(query, params);

    for (const c of cascades) {
      await updateCascadeAchievement(c.id);
    }
    res.json({ message: `Refreshed achievements for ${cascades.length} cascades` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/* =========================================================
   CASCADE IDENTITY / UPSERT — one cascade per (service, period)
   ========================================================= */
async function upsertCascade(serviceId, serviceName, amount, start, end, method, createdBy, monthlyMap = null) {
  // A service keeps a single active cascade matching the currently selected
  // period, so clear any previously generated cascades for it before recreating.
  await pool.execute('DELETE FROM goal_cascades WHERE service_id = ?', [serviceId]);

  const fiscalYear = start ? parseInt(start.substring(0, 4), 10) : null;
  const [result] = await pool.execute(
    `INSERT INTO goal_cascades (service_id, service_name, fiscal_year, annual_target, target_start_date, target_end_date, cascade_method, created_by, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [serviceId, serviceName, fiscalYear, amount, start, end, method, createdBy]
  );
  const cascadeId = result.insertId;

  await generateCascadeItems(cascadeId, amount, start, end, monthlyMap);
  await updateCascadeAchievement(cascadeId);
  return cascadeId;
}

// Pro-rate a target amount by the months of its YYYY-MM window that fall within [pStart, pEnd]
function proRateByMonths(amount, tStartMonth, tEndMonth, pStartMonth, pEndMonth) {
  const targetMonths = monthsBetweenStr(tStartMonth, tEndMonth);
  if (targetMonths <= 0) return null;
  const oStart = tStartMonth >= pStartMonth ? tStartMonth : pStartMonth;
  const oEnd = tEndMonth <= pEndMonth ? tEndMonth : pEndMonth;
  if (oStart > oEnd) return null;
  const overlapMonths = monthsBetweenStr(oStart, oEnd);
  if (overlapMonths <= 0) return null;
  return Math.round((parseFloat(amount) * overlapMonths) / targetMonths * 100) / 100;
}

function monthsBetweenStr(a, b) {
  const [y1, m1] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) + 1;
}

/* =========================================================
   GENERATION — builds yearly / semi-annual / quarterly items
   over the exact month span of the period.
   ========================================================= */
async function generateCascadeItems(cascadeId, annualTarget, startDate, endDate, monthlyMap = null) {
  // monthlyMap: optional { 'YYYY-MM': amount } — admin-set allocations. When
  // present, every bucket (year/semi/quarter) sums the actual month values
  // (missing months fall back to the equal share), so a manually allocated
  // fiscal year cascades with the real month-by-month numbers.
  const s = parseYmd(startDate);
  const e = parseYmd(endDate);
  if (!s || !e) throw new Error('Valid start/end dates are required');

  const months = [];
  let y = s.y, m = s.m;
  while (y < e.y || (y === e.y && m <= e.m)) {
    months.push({ y, m });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  const totalMonths = months.length;
  const yearStr = `${s.y}`;
  const equalShare = annualTarget / totalMonths;
  const monthAmt = (key) =>
    monthlyMap && monthlyMap[key] !== undefined ? monthlyMap[key] : equalShare;
  const groupAmt = (group) =>
    monthlyMap
      ? group.reduce((sum, mo) => sum + monthAmt(`${mo.y}-${String(mo.m).padStart(2, '0')}`), 0)
      : annualTarget * (group.length / totalMonths);

  const [yRes] = await pool.execute(
    `INSERT INTO goal_cascade_items (cascade_id, level, period_label, period_start, period_end, target_amount, weight)
     VALUES (?, 'yearly', ?, ?, ?, ?, 1.0)`,
    [cascadeId, `${yearStr} (Year)`, ymd(s.y, s.m, 1), lastDayYmd(e.y, e.m), annualTarget]
  );
  const yearlyItemId = yRes.insertId;

  for (let i = 0; i < months.length; i += 6) {
    const group = months.slice(i, i + 6);
    if (group.length === 0) continue;
    const share = groupAmt(group);
    const label = `H${Math.floor(i / 6) + 1}-${yearStr} (Semi)`;
    const [sRes] = await pool.execute(
      `INSERT INTO goal_cascade_items (cascade_id, level, period_label, period_start, period_end, target_amount, weight, parent_item_id)
       VALUES (?, 'semi_annual', ?, ?, ?, ?, 1.0, ?)`,
      [cascadeId, label, ymd(group[0].y, group[0].m, 1), lastDayYmd(group[group.length - 1].y, group[group.length - 1].m), share, yearlyItemId]
    );
    const semiItemId = sRes.insertId;

    for (let j = 0; j < group.length; j += 3) {
      const qGroup = group.slice(j, j + 3);
      if (qGroup.length === 0) continue;
      const qShare = groupAmt(qGroup);
      const qLabel = `Q${Math.floor(i / 6) * 2 + Math.floor(j / 3) + 1}-${yearStr} (Qtr)`;
      await pool.execute(
        `INSERT INTO goal_cascade_items (cascade_id, level, period_label, period_start, period_end, target_amount, weight, parent_item_id)
         VALUES (?, 'quarterly', ?, ?, ?, ?, 1.0, ?)`,
        [cascadeId, qLabel, ymd(qGroup[0].y, qGroup[0].m, 1), lastDayYmd(qGroup[qGroup.length - 1].y, qGroup[qGroup.length - 1].m), qShare, semiItemId]
      );
    }
  }
}

/* =========================================================
   REVENUE / ACHIEVEMENT helpers
   ========================================================= */
async function revenueInWindow(serviceName, startYmd, endYmd) {
  const startMonth = monthOf(startYmd);
  const endMonth = monthOf(endYmd);
  if (!serviceName || !startMonth || !endMonth || startMonth > endMonth) return 0;
  let total = 0;
  const [pr] = await pool.execute(
    `SELECT COALESCE(SUM(total_revenue), 0) as total
     FROM partner_revenue
     WHERE service_name = ? AND revenue_month IS NOT NULL AND revenue_month >= ? AND revenue_month <= ?`,
    [serviceName, startMonth, endMonth]
  );
  total += parseFloat(pr[0].total) || 0;
  const [ar] = await pool.execute(
    `SELECT COALESCE(SUM(ar.amount), 0) as total
     FROM actual_revenue ar
     WHERE ar.revenue_month IS NOT NULL AND ar.revenue_month >= ? AND ar.revenue_month <= ?
       AND ar.service_id IN (SELECT id FROM vas_services WHERE name = ?)`,
    [startMonth, endMonth, serviceName]
  );
  total += parseFloat(ar[0].total) || 0;
  return total;
}

async function updateCascadeAchievement(cascadeId) {
  const [cascade] = await pool.execute('SELECT * FROM goal_cascades WHERE id = ?', [cascadeId]);
  if (cascade.length === 0) return;
  const c = cascade[0];

  const [items] = await pool.execute('SELECT * FROM goal_cascade_items WHERE cascade_id = ?', [cascadeId]);

  for (const item of items) {
    const actualRevenue = await revenueInWindow(c.service_name, item.period_start, item.period_end);
    const targetAmount = parseFloat(item.target_amount);
    const pct = targetAmount > 0 ? Math.round((actualRevenue / targetAmount) * 10000) / 100 : 0;

    await pool.execute(
      'UPDATE goal_cascade_items SET actual_revenue = ?, achievement_pct = ? WHERE id = ?',
      [actualRevenue, pct, item.id]
    );
  }
}

/* =========================================================
   ON-DEMAND CASCADE COMPUTATION
   Periods and targets are derived from the requested filter
   window plus the service's own revenue-target period (the
   source of truth), so displayed dates/targets always match
   what the user selected — even if stored rows are stale.
   ========================================================= */
function targetsWithStr(rows) {
  return (rows || [])
    .map(t => ({ ...t, startStr: toDateStr(t.target_start_date), endStr: toDateStr(t.target_end_date) }))
    .filter(t => t.startStr && t.endStr);
}

async function buildCascadeWindow(targets, fS, fE) {
  // Merge ALL revenue targets that overlap the filter window (month-wise), so a
  // service with two targets gets BOTH added for the months they each cover.
  const pStart = monthOf(fS);
  const pEnd = monthOf(fE);
  const overlap = (targets || []).filter(t => {
    const ts = monthOf(t.startStr);
    const te = monthOf(t.endStr);
    return ts && te && ts <= pEnd && te >= pStart;
  });
  if (!overlap.length) return null;

  // Window = filter clipped to the UNION of the overlapping target periods, so
  // months covered by any target are included (e.g. targets Jul 2026-Jun 2027 and
  // May 2027-Apr 2028 both contribute inside a Jul 2026-Jun 2027 filter).
  let minStart = null, maxEnd = null;
  for (const t of overlap) {
    if (minStart === null || t.startStr < minStart) minStart = t.startStr;
    if (maxEnd === null || t.endStr > maxEnd) maxEnd = t.endStr;
  }
  const start = laterDate(minStart, fS);
  const end = earlierDate(maxEnd, fE);
  if (start > end) return null;

  // Build a per-month share array. Mode-aware: targets in 'manual' allocation
  // mode contribute their admin-set monthly allocations; 'automatic' targets
  // contribute an equal monthly share (target / its own month count) for each
  // month they cover. Months covered by multiple targets get the SUM.
  const manualOnly = overlap.filter(t => t.allocation_mode === 'manual');
  const allocMonthly = await resolveMonthlyTargets(manualOnly);
  const allocFor = {};
  for (const t of overlap) {
    if (t.allocation_mode === 'manual') continue;
    const ts = monthOf(t.startStr);
    const te = monthOf(t.endStr);
    const tMonths = monthsBetween(t.startStr, t.endStr);
    const share = tMonths > 0 ? (parseFloat(t.target_amount) || 0) / tMonths : 0;
    let y2 = parseInt(ts.substring(0, 4), 10), m2 = parseInt(ts.substring(5, 7), 10);
    const eY2 = parseInt(te.substring(0, 4), 10), eM2 = parseInt(te.substring(5, 7), 10);
    while (y2 < eY2 || (y2 === eY2 && m2 <= eM2)) {
      const key = `${y2}-${String(m2).padStart(2, '0')}`;
      allocFor[key] = (allocFor[key] || 0) + share;
      m2 += 1;
      if (m2 > 12) { m2 = 1; y2 += 1; }
    }
  }
  // resolveMonthlyTargets keys by service_name; manual targets keep the real
  // name from the row (service_id-less rows fall back to it as well).
  const manualMap = {};
  for (const t of manualOnly) {
    const m = allocMonthly[t.service_name] || {};
    for (const [k, v] of Object.entries(m)) {
      manualMap[k] = (manualMap[k] || 0) + v;
    }
  }

  const months = [];
  let y = parseYmd(start).y, m = parseYmd(start).m;
  const eY = parseYmd(end).y, eM = parseYmd(end).m;
  while (y < eY || (y === eY && m <= eM)) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const manualAmt = manualMap[key] !== undefined ? manualMap[key] : 0;
    const autoAmt = allocFor[key] !== undefined ? allocFor[key] : 0;
    const share = manualAmt + autoAmt;
    months.push({ y, m, share });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }

  const target = Math.round(months.reduce((s, mo) => s + mo.share, 0) * 100) / 100;
  return { start, end, target, months };
}

function buildCascadeItems(serviceName, start, end, months) {
  const total = months.reduce((s, mo) => s + mo.share, 0);
  const yearStr = String(months[0].y);
  const yearly = [{
    id: -9001, level: 'yearly', period_label: `${yearStr} (Year)`,
    period_start: start, period_end: end, target_amount: Math.round(total * 100) / 100,
    actual_revenue: 0, achievement_pct: 0, weight: 1, parent_item_id: null,
  }];
  const semiAnnual = [];
  const quarterly = [];
  let semiIdx = 0;
  for (let i = 0; i < months.length; i += 6) {
    const group = months.slice(i, i + 6);
    if (!group.length) continue;
    const sId = -(1000 + semiIdx);
    semiAnnual.push({
      id: sId, parent_item_id: -9001, level: 'semi_annual',
      period_label: `H${semiIdx + 1}-${yearStr} (Semi)`,
      period_start: ymd(group[0].y, group[0].m, 1),
      period_end: lastDayYmd(group[group.length - 1].y, group[group.length - 1].m),
      target_amount: Math.round(group.reduce((s, mo) => s + mo.share, 0) * 100) / 100,
      actual_revenue: 0, achievement_pct: 0, weight: 1,
    });
    let qIdx = 0;
    for (let j = 0; j < group.length; j += 3) {
      const qg = group.slice(j, j + 3);
      if (!qg.length) continue;
      quarterly.push({
        id: -(2000 + quarterly.length), parent_item_id: sId, level: 'quarterly',
        period_label: `Q${semiIdx * 2 + qIdx + 1}-${yearStr} (Qtr)`,
        period_start: ymd(qg[0].y, qg[0].m, 1),
        period_end: lastDayYmd(qg[qg.length - 1].y, qg[qg.length - 1].m),
        target_amount: Math.round(qg.reduce((s, mo) => s + mo.share, 0) * 100) / 100,
        actual_revenue: 0, achievement_pct: 0, weight: 1,
      });
      qIdx += 1;
    }
    semiIdx += 1;
  }
  return { yearly, semiAnnual, quarterly, all: [...yearly, ...semiAnnual, ...quarterly] };
}

async function fillCascadeActuals(serviceName, items) {
  for (const it of items) {
    it.actual_revenue = await revenueInWindow(serviceName, it.period_start, it.period_end);
    it.achievement_pct = it.target_amount > 0 ? Math.round((it.actual_revenue / it.target_amount) * 10000) / 100 : 0;
  }
  return items;
}

/* ---------------- serializers ---------------- */
function ymdStr(v) {
  if (!v) return null;
  if (v instanceof Date) return ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : null;
}

function serItem(row) {
  return { ...row, period_start: ymdStr(row.period_start), period_end: ymdStr(row.period_end) };
}
function serItems(rows) { return (rows || []).map(serItem); }
function serCascade(row) {
  return { ...row, target_start_date: ymdStr(row.target_start_date), target_end_date: ymdStr(row.target_end_date) };
}

/* ---------------- date helpers (string-safe) ---------------- */
function monthOf(v) {
  if (!v) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}`;
  }
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}` : null;
}

function toDateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return ymd(v.getFullYear(), v.getMonth() + 1, v.getDate());
  const s = String(v);
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return s.substring(0, 10);
  const tIdx = s.indexOf('T');
  if (tIdx > 0) return s.substring(0, 10);
  return null;
}

function parseYmd(str) {
  const d = toDateStr(str);
  if (!d) return null;
  const [y, m] = d.split('-').map(Number);
  if (!y || !m) return null;
  return { y, m };
}

function ymd(y, m, day) {
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function lastDayYmd(y, m) {
  return ymd(y, m, new Date(y, m, 0).getDate());
}

function laterDate(a, b) {
  return (a >= b ? a : b);
}
function earlierDate(a, b) {
  return (a <= b ? a : b);
}

function monthsBetween(a, b) {
  const [y1, m1] = a.split('-').map(Number);
  const [y2, m2] = b.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1) + 1;
}

module.exports = router;
