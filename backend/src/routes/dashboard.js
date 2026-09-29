const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { countUniqueFuzzyPartners } = require('../utils/partnerMerge');
const { getPartnerCountForRange } = require('../utils/partnerCountCache');
const { getCached, setCached } = require('../utils/endpointCache');
const { resolveMonthlyTargets, sumMonthly } = require('../utils/targetCalculator');

// --- Helpers for target proration (same logic as alerts.js) ---
function toDateStr(val) {
  if (!val) return null;
  if (typeof val === 'string') return val.substring(0, 10);
  const d = new Date(val);
  return d.toLocaleDateString('en-CA');
}

function getMonthsInRange(startDate, endDate) {
  const months = [];
  const startParts = startDate.split('-');
  const endParts = endDate.split('-');
  let y = parseInt(startParts[0]);
  let m = parseInt(startParts[1]);
  const endY = parseInt(endParts[0]);
  const endM = parseInt(endParts[1]);
  while (y < endY || (y === endY && m <= endM)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return months;
}

function getMonthsInPeriod(periodType) {
  switch (periodType) {
    case 'monthly': return 1;
    case 'quarterly': return 3;
    case 'yearly': return 12;
    default: return 1;
  }
}

/**
 * Calculate the prorated target for a service over a filtered date range.
 * Mode-aware: targets in 'manual' allocation mode contribute their admin-set
 * monthly allocations; 'automatic' targets keep the legacy behaviour of
 * dividing the amount by the months in the filtered overlap. Multiple
 * overlapping targets for the same service are summed.
 */
async function getProratedTargets(start_date, end_date) {
  let targetQuery = `
    SELECT rt.*, COALESCE(vs.name, rt.service_name) as service_name
    FROM revenue_targets rt
    LEFT JOIN vas_services vs ON rt.service_id = vs.id
    WHERE rt.target_start_date IS NOT NULL AND rt.target_end_date IS NOT NULL
      AND rt.target_start_date > '1000-01-01' AND rt.target_end_date > '1000-01-01'
      AND DATE(rt.target_start_date) > '1970-01-01'
      AND (rt.service_id IS NULL OR vs.status = 'active')
  `;
  const targetParams = [];
  if (start_date) { targetQuery += ' AND rt.target_end_date >= ?'; targetParams.push(start_date); }
  if (end_date) { targetQuery += ' AND rt.target_start_date <= ?'; targetParams.push(end_date); }
  targetQuery += ' ORDER BY rt.target_start_date ASC';
  const [targets] = await pool.execute(targetQuery, targetParams);

  const monthly = await resolveMonthlyTargets(targets, {
    startMonth: start_date ? start_date.substring(0, 7) : null,
    endMonth: end_date ? end_date.substring(0, 7) : null,
  });
  return sumMonthly(monthly); // { service_name: proratedTarget }
}

// Build date filter from start_date/end_date or period_value
function buildRevenueFilter(start_date, end_date, period_value) {
  let filter = '';
  const params = [];
  if (start_date && end_date) {
    const startMonth = start_date.substring(0, 7);
    const endMonth = end_date.substring(0, 7);
    filter = 'WHERE revenue_month >= ? AND revenue_month <= ?';
    params.push(startMonth, endMonth);
  } else if (period_value) {
    filter = 'WHERE revenue_month = ?';
    params.push(period_value);
  }
  // Also build a filter for actual_revenue table (alias ar)
  let arFilter = '';
  if (start_date && end_date) {
    const startMonth = start_date.substring(0, 7);
    const endMonth = end_date.substring(0, 7);
    arFilter = 'WHERE ar.revenue_month >= ? AND ar.revenue_month <= ?';
  } else if (period_value) {
    arFilter = 'WHERE ar.revenue_month = ?';
  }
  return { filter, arFilter, params };
}

// Build target filter from start_date/end_date or period_value
function buildTargetFilter(start_date, end_date, period_value, period_type) {
  let filter = '';
  const params = [];
  if (start_date && end_date) {
    filter = 'WHERE (target_end_date >= ? OR target_end_date IS NULL) AND (target_start_date <= ? OR target_start_date IS NULL)';
    params.push(start_date, end_date);
  } else if (period_value) {
    filter = 'WHERE period_type = ? AND period_value = ?';
    params.push(period_type, period_value);
  }
  return { filter, params };
}

// GET overall KPIs - uses partner_revenue table for actual data with date range
router.get('/kpis', async (req, res) => {
  try {
    // Check cache first
    const cached = getCached('/dashboard/kpis', req.query);
    if (cached) return res.json(cached);

    const { start_date, end_date, period_type = 'monthly', period_value = '2026-05', fiscal_year = 2026 } = req.query;

    const { filter: actualFilter, arFilter, params: actualParams } = buildRevenueFilter(start_date, end_date, period_value);

    // Use prorated targets (same logic as alerts.js)
    const proratedTargets = await getProratedTargets(start_date, end_date);
    const totalTargetAmount = Object.values(proratedTargets).reduce((s, v) => s + v, 0);

    // Combined revenue from both partner_revenue and actual_revenue
    // Run all queries in parallel for speed
    const [
      [totalActual],
      [totalEthio],
      [serviceCount],
      [topServices],
      [topPartners],
    ] = await Promise.all([
      pool.execute(
        `SELECT COALESCE(SUM(total), 0) as total FROM (
          SELECT total_revenue as total FROM partner_revenue ${actualFilter}
          UNION ALL
          SELECT ar.amount as total FROM actual_revenue ar ${arFilter}
        ) combined`,
        [...actualParams, ...actualParams]
      ),
      pool.execute(
        `SELECT COALESCE(SUM(ethio_share), 0) as total FROM partner_revenue ${actualFilter}`,
        actualParams
      ),
      pool.execute(
        `SELECT COUNT(DISTINCT service_name) as count FROM (
          SELECT service_name FROM partner_revenue ${actualFilter ? actualFilter + ' AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'}
          UNION ALL
          SELECT vs.name as service_name FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arFilter ? arFilter + ' AND vs.status = \'active\'' : 'WHERE vs.status = \'active\''}
        ) combined`,
        [...actualParams, ...actualParams]
      ),
      pool.execute(
        `SELECT service_name as name, SUM(total) as revenue FROM (
          SELECT service_name, total_revenue as total FROM partner_revenue ${actualFilter ? actualFilter + ' AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'}
          UNION ALL
          SELECT vs.name as service_name, ar.amount as total FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arFilter ? arFilter + ' AND vs.status = \'active\'' : 'WHERE vs.status = \'active\''}
        ) combined
         GROUP BY service_name
         ORDER BY revenue DESC
         LIMIT 5`,
        [...actualParams, ...actualParams]
      ),
      pool.execute(
        `SELECT partner_name, GROUP_CONCAT(DISTINCT service_name ORDER BY service_name SEPARATOR ', ') as services, SUM(total_revenue) as total_revenue FROM partner_revenue ${actualFilter ? actualFilter + ' AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'} GROUP BY partner_name ORDER BY total_revenue DESC LIMIT 5`,
        actualParams
      ),
    ]);

    // Use shared partner count cache (avoids re-running fuzzy merge)
    const startMonth = actualParams[0] || null;
    const endMonth = actualParams[actualParams.length - 1] || null;
    const partnerCountFuzzy = await getPartnerCountForRange(startMonth, endMonth);

    // Build underperforming services from prorated targets
    const [actualByService] = await pool.execute(
      `SELECT service_name, SUM(total) as actual_revenue FROM (
        SELECT service_name, total_revenue as total FROM partner_revenue ${actualFilter ? actualFilter + ' AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'}
        UNION ALL
        SELECT vs.name as service_name, ar.amount as total FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arFilter ? arFilter + ' AND vs.status = \'active\'' : 'WHERE vs.status = \'active\''}
      ) combined GROUP BY service_name`,
      [...actualParams, ...actualParams]
    );
    const underperforming = actualByService
      .map(r => ({
        name: r.service_name,
        actual_revenue: parseFloat(r.actual_revenue),
        target_amount: proratedTargets[r.service_name] || 0,
        achievement_pct: (proratedTargets[r.service_name] || 0) > 0
          ? parseFloat(((parseFloat(r.actual_revenue) / proratedTargets[r.service_name]) * 100).toFixed(2))
          : 0,
      }))
      .filter(s => s.achievement_pct < 50 && s.achievement_pct > 0 && s.target_amount > 0)
      .sort((a, b) => a.achievement_pct - b.achievement_pct);

    const target = totalTargetAmount;
    const actual = parseFloat(totalActual[0].total);
    const achievement = target > 0 ? ((actual / target) * 100).toFixed(2) : 0;
    const remaining = Math.max(0, target - actual);

    // Build period label
    let periodLabel = period_value;
    if (start_date && end_date) {
      periodLabel = `${start_date} to ${end_date}`;
    }

    const result = {
      total_target: target,
      total_actual: actual,
      total_ethio: parseFloat(totalEthio[0].total),
      achievement_pct: parseFloat(achievement),
      remaining,
      partner_count: partnerCountFuzzy,
      top_partners: (topPartners || []).map(p => ({
        partner_name: p.partner_name,
        services: p.services,
        total_revenue: parseFloat(p.total_revenue)
      })),
      active_services: serviceCount[0].count,
      top_services: topServices,
      underperforming_services: underperforming,
      period: { type: period_type, value: periodLabel, start_date, end_date, year: fiscal_year }
    };
    setCached('/dashboard/kpis', req.query, result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET per-service achievement with date range (prorated targets)
router.get('/service-achievements', async (req, res) => {
  try {
    const { start_date, end_date, period_type = 'monthly', period_value = '2026-05' } = req.query;

    const { filter: actualFilter, arFilter, params: actualParams } = buildRevenueFilter(start_date, end_date, period_value);

    // Use prorated targets (same logic as alerts.js)
    const proratedTargets = await getProratedTargets(start_date, end_date);

    const [rows] = await pool.execute(
      `SELECT 
        cr.service_name,
        COALESCE(SUM(cr.total), 0) as actual_amount,
        COALESCE(SUM(cr.ethio_share), 0) as ethio_share,
        COUNT(DISTINCT CASE WHEN cr.partner_name != 'Manual' THEN cr.partner_name END) as partner_count
       FROM (
        SELECT service_name, total_revenue as total, ethio_share, partner_name, revenue_month FROM partner_revenue ${actualFilter ? actualFilter + ' AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'}
        UNION ALL
        SELECT vs.name as service_name, ar.amount as total, 0 as ethio_share, COALESCE(ar.partner_name, 'Manual') as partner_name, ar.revenue_month FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arFilter ? arFilter + ' AND vs.status = \'active\'' : 'WHERE vs.status = \'active\''}
       ) cr
       GROUP BY cr.service_name
       ORDER BY actual_amount DESC`,
      [...actualParams, ...actualParams]
    );

    // Every ACTIVE service must appear — including those with no revenue in
    // the selected window (shown with 0 actual). Inactive services stay out.
    const [activeServices] = await pool.execute("SELECT name FROM vas_services WHERE status = 'active'");
    const activeNames = new Set(activeServices.map((s) => s.name));

    // Attach prorated targets and calculate achievement
    const result = [];
    const seen = new Set();
    for (const r of rows) {
      if (!activeNames.has(r.service_name)) continue; // safety net
      const target = proratedTargets[r.service_name] || 0;
      const actual = parseFloat(r.actual_amount) || 0;
      seen.add(r.service_name);
      result.push({
        service_name: r.service_name,
        actual_amount: actual,
        ethio_share: parseFloat(r.ethio_share) || 0,
        partner_count: r.partner_count,
        target_amount: target,
        achievement_pct: target > 0 ? parseFloat(((actual / target) * 100).toFixed(2)) : 0,
        remaining: target > actual ? target - actual : 0,
      });
    }
    // Active services with no revenue rows in the window
    for (const s of activeServices) {
      if (seen.has(s.name)) continue;
      const target = proratedTargets[s.name] || 0;
      result.push({
        service_name: s.name,
        actual_amount: 0,
        ethio_share: 0,
        partner_count: 0,
        target_amount: target,
        achievement_pct: 0,
        remaining: target,
      });
    }
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET revenue by category with date range
router.get('/category-breakdown', async (req, res) => {
  try {
    const { start_date, end_date, period_value = '2026-05' } = req.query;
    const { filter, arFilter, params } = buildRevenueFilter(start_date, end_date, period_value);

    const [rows] = await pool.execute(
      `SELECT 
        service_name as category,
        SUM(total) as total_revenue,
        SUM(ethio_share) as total_ethio,
        COUNT(DISTINCT partner_name) as partner_count
       FROM (
        SELECT service_name, total_revenue as total, ethio_share, partner_name FROM partner_revenue ${filter ? filter + ' AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'}
        UNION ALL
        SELECT vs.name as service_name, ar.amount as total, 0 as ethio_share, COALESCE(ar.partner_name, 'Manual') as partner_name FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arFilter ? arFilter + ' AND vs.status = \'active\'' : 'WHERE vs.status = \'active\''}
       ) combined
       GROUP BY service_name
       ORDER BY total_revenue DESC`,
      [...params, ...params]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET month-over-month growth per service
router.get('/mom-growth', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let filter = '';
    let arFilter = '';
    const params = [];
    if (start_date && end_date) {
      const startMonth = start_date.substring(0, 7);
      const endMonth = end_date.substring(0, 7);
      filter = 'WHERE revenue_month >= ? AND revenue_month <= ?';
      arFilter = 'WHERE ar.revenue_month >= ? AND ar.revenue_month <= ?';
      params.push(startMonth, endMonth);
    }

    // Get monthly revenue per service
    const [monthlyData] = await pool.execute(
      `SELECT 
        service_name, revenue_month,
        SUM(total) as total_revenue
       FROM (
        SELECT service_name, total_revenue as total, revenue_month FROM partner_revenue ${filter ? filter + ' AND revenue_month IS NOT NULL AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE revenue_month IS NOT NULL AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'}
        UNION ALL
        SELECT vs.name as service_name, ar.amount as total, ar.revenue_month FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arFilter ? arFilter + ' AND ar.revenue_month IS NOT NULL AND vs.status = \'active\'' : 'WHERE ar.revenue_month IS NOT NULL AND vs.status = \'active\''}
       ) combined
       GROUP BY service_name, revenue_month
       ORDER BY service_name, revenue_month`,
      [...params, ...params]
    );

    // Calculate MoM growth for each service
    const serviceMap = {};
    monthlyData.forEach(row => {
      if (!serviceMap[row.service_name]) serviceMap[row.service_name] = [];
      serviceMap[row.service_name].push({ month: row.revenue_month, revenue: parseFloat(row.total_revenue) });
    });

    const growthData = [];
    Object.entries(serviceMap).forEach(([serviceName, months]) => {
      months.sort((a, b) => a.month.localeCompare(b.month));
      for (let i = 1; i < months.length; i++) {
        const prev = months[i - 1].revenue;
        const curr = months[i].revenue;
        const growth = prev > 0 ? ((curr - prev) / prev * 100) : (curr > 0 ? 100 : 0);
        growthData.push({
          service_name: serviceName,
          month: months[i].month,
          prev_month: months[i - 1].month,
          current_revenue: curr,
          previous_revenue: prev,
          growth_pct: parseFloat(growth.toFixed(2)),
        });
      }
    });

    res.json(growthData);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
