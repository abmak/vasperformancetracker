const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { countUniqueFuzzyPartners } = require('../utils/partnerMerge');
const { getPartnerCountForRange } = require('../utils/partnerCountCache');
const { resolveMonthlyTargets, sumMonthly } = require('../utils/targetCalculator');

// Build date filter for revenue_month column
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
  let arFilter = '';
  if (start_date && end_date) {
    arFilter = 'WHERE ar.revenue_month >= ? AND ar.revenue_month <= ?';
  } else if (period_value) {
    arFilter = 'WHERE ar.revenue_month = ?';
  }
  return { filter, arFilter, params };
}

// Build target filter from date range
function buildTargetFilter(start_date, end_date, period_value, period_type) {
  let filter = '';
  const params = [];
  if (start_date && end_date) {
    // Use DATE() to strip timezone offsets from datetime columns
    filter = 'WHERE (DATE_FORMAT(target_end_date, "%Y-%m-%d") >= ? OR target_end_date IS NULL) AND (DATE_FORMAT(target_start_date, "%Y-%m-%d") <= ? OR target_start_date IS NULL)';
    params.push(start_date.substring(0, 10), end_date.substring(0, 10));
  } else if (period_value) {
    filter = 'WHERE period_value = ?';
    params.push(period_value);
  }
  return { filter, params };
}

// GET performance report - uses partner_revenue as primary data source
router.get('/performance', async (req, res) => {
  try {
    const { start_date, end_date, period_type = 'monthly', period_value = '2026-05', fiscal_year = 2026 } = req.query;

    const { filter: actualFilter, arFilter, params: actualParams } = buildRevenueFilter(start_date, end_date, period_value);
    const { filter: targetFilter, params: targetParams } = buildTargetFilter(start_date, end_date, period_value, period_type);

    // Run all queries in parallel
    const partnerFilterWhere = actualFilter ? actualFilter + ' AND' : 'WHERE';
    const arFilterWhere = arFilter ? arFilter + ' AND' : 'WHERE';
    const [
      [partnerRows],
      [partnerNameRows],
      [allTargets],
      [catRows],
    ] = await Promise.all([
      pool.execute(
        `SELECT 
          service_name,
          SUM(total) as actual_amount,
          SUM(ethio_share) as ethio_amount,
          COUNT(DISTINCT partner_name) as partner_count
         FROM (
          SELECT service_name, total_revenue as total, ethio_share, partner_name FROM partner_revenue ${actualFilter}
          UNION ALL
          SELECT vs.name as service_name, ar.amount as total, 0 as ethio_share, 'Manual' as partner_name FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arFilter}
         ) combined
         GROUP BY service_name
         ORDER BY actual_amount DESC`,
        [...actualParams, ...actualParams]
      ),
      pool.execute(
        `SELECT DISTINCT partner_name FROM (
          SELECT partner_name FROM partner_revenue ${partnerFilterWhere} partner_name IS NOT NULL AND partner_name != ''
          UNION ALL
          SELECT COALESCE(ar.partner_name, 'Manual') as partner_name FROM actual_revenue ar ${arFilterWhere} ar.partner_name IS NOT NULL AND ar.partner_name != ''
        ) combined`,
        [...actualParams, ...actualParams]
      ),
      pool.execute(
        `SELECT rt.*, COALESCE(vs.name, rt.service_name) as service_name
         FROM revenue_targets rt
         LEFT JOIN vas_services vs ON rt.service_id = vs.id
         ${targetFilter} GROUP BY rt.id`,
        targetParams
      ),
      pool.execute(
        `SELECT vs.name as service_name, vc.name as category_name, vc.color as category_color
         FROM vas_services vs
         LEFT JOIN vas_categories vc ON vs.category_id = vc.id`
      ).catch(() => [[]]),
    ]);

    // Use shared partner count cache
    const startMonth = actualParams[0] || null;
    const endMonth = actualParams[actualParams.length - 1] || null;
    const totalPartners = await getPartnerCountForRange(startMonth, endMonth);

    // Mode-aware targets: manual-allocation targets contribute their admin-set
    // monthly allocations for the filtered window; automatic targets keep the
    // legacy "sum of overlapping target amounts" behaviour.
    const targetRows = allTargets;
    const targetMonthly = await resolveMonthlyTargets(targetRows, {
      startMonth: start_date ? start_date.substring(0, 7) : (period_value || null),
      endMonth: end_date ? end_date.substring(0, 7) : (period_value || null),
    });
    const targetTotals = sumMonthly(targetMonthly);
    let targetMap = {};
    // Automatic targets: legacy = sum of each overlapping target's full amount.
    // Manual targets: sum of their in-window allocations (already in targetTotals).
    const manualServiceNames = new Set(
      targetRows.filter((t) => t.allocation_mode === 'manual').map((t) => t.service_name)
    );
    for (const t of targetRows) {
      if (t.allocation_mode === 'manual') continue;
      targetMap[t.service_name] = (targetMap[t.service_name] || 0) + parseFloat(t.target_amount);
    }
    for (const [svc, amt] of Object.entries(targetTotals)) {
      if (manualServiceNames.has(svc)) targetMap[svc] = amt;
    }

    let categoryMap = {};
    (catRows || []).forEach(r => { categoryMap[r.service_name] = { name: r.category_name || 'Other', color: r.category_color || '#6B7280' }; });

    // Merge
    const services = partnerRows.map((r, i) => {
      const actual = parseFloat(r.actual_amount);
      const target = targetMap[r.service_name] || 0;
      const pct = target > 0 ? ((actual / target) * 100).toFixed(2) : 0;
      const remaining = target > actual ? target - actual : 0;
      const cat = categoryMap[r.service_name] || { name: 'Other', color: '#6B7280' };
      return {
        id: i + 1,
        name: r.service_name,
        code: r.service_name.substring(0, 8).toUpperCase().replace(/\s/g, ''),
        category: cat.name,
        category_color: cat.color,
        target_amount: target,
        actual_amount: actual,
        ethio_amount: parseFloat(r.ethio_amount),
        achievement_pct: parseFloat(pct),
        remaining,
        partner_count: r.partner_count,
        data_points: r.partner_count,
      };
    });

    // Add services that have targets but no revenue data
    const serviceNames = partnerRows.map(r => r.service_name);
    for (const [svcName, tgt] of Object.entries(targetMap)) {
      if (!serviceNames.includes(svcName)) {
        const cat = categoryMap[svcName] || { name: 'Other', color: '#6B7280' };
        services.push({
          id: services.length + 1,
          name: svcName,
          code: svcName.substring(0, 8).toUpperCase().replace(/\s/g, ''),
          category: cat.name,
          category_color: cat.color,
          target_amount: tgt,
          actual_amount: 0,
          ethio_amount: 0,
          achievement_pct: 0,
          remaining: tgt,
          partner_count: 0,
          data_points: 0,
        });
      }
    }

    services.sort((a, b) => b.actual_amount - a.actual_amount);

    const totalTarget = services.reduce((sum, s) => sum + s.target_amount, 0);
    const totalActual = services.reduce((sum, s) => sum + s.actual_amount, 0);
    const totalEthio = services.reduce((sum, s) => sum + s.ethio_amount, 0);

    let periodLabel = period_value;
    if (start_date && end_date) {
      periodLabel = `${start_date} to ${end_date}`;
    }

    res.json({
      report_type: 'performance',
      period: { type: period_type, value: periodLabel, start_date, end_date, year: fiscal_year },
      generated_at: new Date().toISOString(),
      summary: {
        total_services: services.length,
        total_target: totalTarget,
        total_actual: totalActual,
        total_ethio: totalEthio,
        overall_achievement: totalTarget > 0 ? ((totalActual / totalTarget) * 100).toFixed(2) : 0,
        services_achieved: services.filter(s => s.achievement_pct >= 100).length,
        services_below_50: services.filter(s => s.achievement_pct < 50 && s.target_amount > 0).length,
        total_partners: totalPartners,
      },
      services
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET trend report (monthly comparison from partner_revenue)
router.get('/trend', async (req, res) => {
  try {
    const { start_date, end_date, service_name } = req.query;
    let serviceFilter = '';
    const params = [];

    if (service_name) {
      serviceFilter = 'WHERE service_name = ?';
      params.push(service_name);
    }

    const [rows] = await pool.execute(
      `SELECT 
        revenue_month as month,
        service_name,
        SUM(total_revenue) as total_revenue,
        SUM(ethio_share) as ethio_share,
        COUNT(DISTINCT partner_name) as partner_count
       FROM partner_revenue
       ${serviceFilter}
       GROUP BY revenue_month, service_name
       ORDER BY revenue_month DESC, total_revenue DESC`,
      params
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET monthly trend summary (all months or within date range)
router.get('/monthly-trend', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    let filter = '';
    let arFilter = '';
    const params = [];
    if (start_date && end_date) {
      filter = 'WHERE revenue_month >= ? AND revenue_month <= ?';
      arFilter = 'WHERE ar.revenue_month >= ? AND ar.revenue_month <= ?';
      params.push(start_date.substring(0, 7), end_date.substring(0, 7));
    }

    const [rows] = await pool.execute(
      `SELECT 
        revenue_month,
        SUM(total) as total_revenue,
        SUM(ethio_share) as ethio_share,
        COUNT(DISTINCT partner_name) as partner_count,
        COUNT(DISTINCT service_name) as service_count
       FROM (
        SELECT service_name, total_revenue as total, ethio_share, partner_name, revenue_month FROM partner_revenue ${filter ? filter + ' AND revenue_month IS NOT NULL' : 'WHERE revenue_month IS NOT NULL'}
        UNION ALL
        SELECT vs.name as service_name, ar.amount as total, 0 as ethio_share, 'Manual' as partner_name, ar.revenue_month FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arFilter ? arFilter + ' AND ar.revenue_month IS NOT NULL' : 'WHERE ar.revenue_month IS NOT NULL'}
       ) combined
       GROUP BY revenue_month
       ORDER BY revenue_month ASC`,
      [...params, ...params]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function getServiceCategory(name) {
  const n = name.toLowerCase();
  if (n.includes('crbt') || n.includes('ring') || n.includes('lottery') || n.includes('sms mo')) return 'entertainment';
  if (n.includes('api') || n.includes('enterprise') || n.includes('aggregator')) return 'enterprise';
  if (n.includes('sms') || n.includes('premium')) return 'messaging';
  if (n.includes('data') || n.includes('internet')) return 'data';
  if (n.includes('voice') || n.includes('vtu')) return 'voice';
  return 'other';
}

module.exports = router;
