const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { resolveMonthlyTargets } = require('../utils/targetCalculator');

// Helper: safely convert Date/string to YYYY-MM-DD string
function toDateStr(val) {
  if (!val) return null;
  if (typeof val === 'string') return val.substring(0, 10);
  // Date object from DB - use locale string for reliable local-time conversion
  // toLocaleDateString('en-CA') returns YYYY-MM-DD in local time
  const d = new Date(val);
  return d.toLocaleDateString('en-CA');
}

// Helper: extract YYYY-MM from a date string (timezone-safe)
function toYearMonth(dateStr) {
  return dateStr.substring(0, 7);
}

// Helper: generate months between start and end date (YYYY-MM format)
// Uses string parsing to avoid JavaScript Date timezone issues
function getMonthsInRange(startDate, endDate) {
  const months = [];
  // Extract YYYY-MM directly from date strings (timezone-safe)
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

// Helper: get total months in a period
function getMonthsInPeriod(periodType) {
  switch (periodType) {
    case 'monthly': return 1;
    case 'quarterly': return 3;
    case 'yearly': return 12;
    default: return 1;
  }
}

// Helper: get period label for a month
function getMonthLabel(yyyyMm) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const date = new Date(y, m - 1);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
}

// Helper: get alert level based on achievement percentage
function getAlertLevel(actual, expected) {
  if (expected <= 0) return 'none';
  const pct = (actual / expected) * 100;
  if (pct >= 90) return 'green';   // On track (90%+)
  if (pct >= 70) return 'yellow';  // Slightly behind (70-89%)
  if (pct >= 50) return 'orange';  // Behind (50-69%)
  return 'red';                     // Critical (<50%)
}

// Helper: get alert description
function getAlertDescription(level, actual, expected, serviceName, month) {
  const pct = expected > 0 ? ((actual / expected) * 100).toFixed(1) : 0;
  const gap = Math.max(0, expected - actual);
  switch (level) {
    case 'green':
      return `✅ ${serviceName} — ${month}: On track at ${pct}% (${formatETB(actual)} of ${formatETB(expected)})`;
    case 'yellow':
      return `⚠️ ${serviceName} — ${month}: Slightly behind at ${pct}% (${formatETB(gap)} gap)`;
    case 'orange':
      return `🔶 ${serviceName} — ${month}: Behind target at ${pct}% (${formatETB(gap)} gap)`;
    case 'red':
      return `🔴 ${serviceName} — ${month}: Critical — only ${pct}% achieved (${formatETB(gap)} gap)`;
    default:
      return `— ${serviceName} — ${month}: No target set`;
  }
}

function formatETB(amount) {
  return `ETB ${Number(amount).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

// GET /api/alerts — Full alerting dashboard with monthly breakdown.
// Services are UNIQUE: every revenue target of a service is merged month-by-month
// (equal monthly share per target, summed across targets), so a service with two
// targets appears once with a combined target/actual for the filtered time frame.
router.get('/', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    // Get all targets with service info — inactive services are hidden from
    // every module, so their targets are excluded here too.
    let targetQuery = `
      SELECT rt.*,
        COALESCE(vs.name, rt.service_name) as service_name,
        COALESCE(vs.code, '') as service_code
      FROM revenue_targets rt
      LEFT JOIN vas_services vs ON rt.service_id = vs.id
      WHERE rt.target_start_date IS NOT NULL AND rt.target_end_date IS NOT NULL
        AND rt.target_start_date > '1000-01-01' AND rt.target_end_date > '1000-01-01'
        AND DATE(rt.target_start_date) > '1970-01-01'
        AND (rt.service_id IS NULL OR vs.status = 'active')
    `;
    const targetParams = [];

    if (start_date) {
      targetQuery += ' AND rt.target_end_date >= ?';
      targetParams.push(start_date);
    }
    if (end_date) {
      targetQuery += ' AND rt.target_start_date <= ?';
      targetParams.push(end_date);
    }

    targetQuery += ' ORDER BY rt.target_start_date ASC';
    const [targets] = await pool.execute(targetQuery, targetParams);

    if (targets.length === 0) {
      return res.json({ alerts: [], services: [], summary: { total_alerts: 0, critical: 0, warning: 0, on_track: 0 } });
    }

    // Group ALL targets by service so the list is unique per service
    const byService = {};
    for (const t of targets) {
      const key = t.service_name;
      if (!byService[key]) byService[key] = [];
      byService[key].push(t);
    }

    // Determine the filter month range (YYYY-MM) for limiting breakdown
    const filterStartMonth = start_date ? start_date.substring(0, 7) : null;
    const filterEndMonth = end_date ? end_date.substring(0, 7) : null;

    // Pre-fetch ALL monthly revenue in ONE query (avoid N+1 per-service-per-month)
    const allServiceNames = Object.keys(byService);
    const allMonths = [];
    for (const [, svcTargets] of Object.entries(byService)) {
      for (const target of svcTargets) {
        const fullStartDate = toDateStr(target.target_start_date);
        const fullEndDate = toDateStr(target.target_end_date);
        const clipStart = start_date && start_date > fullStartDate ? start_date.substring(0, 7) : fullStartDate.substring(0, 7);
        const clipEnd = end_date && end_date < fullEndDate ? end_date.substring(0, 7) : fullEndDate.substring(0, 7);
        for (const m of getMonthsInRange(clipStart + '-01', clipEnd + '-28')) {
          if (!allMonths.includes(m)) allMonths.push(m);
        }
      }
    }
    allMonths.sort();

    const revMap = {}; // 'serviceName|YYYY-MM' -> actual amount
    if (allServiceNames.length > 0 && allMonths.length > 0) {
      const placeholders = allServiceNames.map(() => '?').join(',');
      const monthPlaceholders = allMonths.map(() => '?').join(',');
      const [allRevenues] = await pool.execute(
        `SELECT service_name, revenue_month, SUM(total) as actual FROM (
          SELECT service_name, total_revenue as total, revenue_month FROM partner_revenue
          WHERE service_name IN (${placeholders}) AND revenue_month IN (${monthPlaceholders})
            AND service_name IN (SELECT name FROM vas_services WHERE status = 'active')
          UNION ALL
          SELECT vs.name as service_name, ar.amount as total, ar.revenue_month
          FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id
          WHERE vs.name IN (${placeholders}) AND ar.revenue_month IN (${monthPlaceholders})
            AND vs.status = 'active'
        ) combined GROUP BY service_name, revenue_month`,
        [...allServiceNames, ...allMonths, ...allServiceNames, ...allMonths]
      );
      for (const row of allRevenues) {
        revMap[`${row.service_name}|${row.revenue_month}`] = parseFloat(row.actual) || 0;
      }
    }

    const now = new Date();
    const currentYYYYMM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const serviceAlerts = [];

    for (const [serviceName, svcTargets] of Object.entries(byService)) {
      // Mode-aware expected map: targets in 'manual' allocation mode contribute
      // their admin-set monthly allocations; 'automatic' targets keep the legacy
      // equal monthly share (target / its own month count) for each covered month.
      // Months covered by multiple targets get the SUM of their contributions.
      const allMonthly = await resolveMonthlyTargets(svcTargets);
      const shareMap = allMonthly[serviceName] || {};
      let winStart = null, winEnd = null;
      for (const target of svcTargets) {
        const fullStartDate = toDateStr(target.target_start_date);
        const fullEndDate = toDateStr(target.target_end_date);
        if (winStart === null || fullStartDate < winStart) winStart = fullStartDate;
        if (winEnd === null || fullEndDate > winEnd) winEnd = fullEndDate;
      }
      if (!winStart || !winEnd) continue;

      // Clip the service window to the filter range
      const winStartClipped = start_date && start_date > winStart ? start_date : winStart;
      const winEndClipped = end_date && end_date < winEnd ? end_date : winEnd;
      const windowMonths = getMonthsInRange(winStartClipped, winEndClipped);
      if (windowMonths.length === 0) continue;

      // Monthly breakdown for the window months only.
      // Expected revenue for each month = the target revenue configured for
      // that month on the revenue target — the admin's monthly allocation for
      // manual-allocation targets, or the equal monthly share for automatic
      // ones (shareMap already carries both). No carry-forward recalculation:
      // a shortfall in one month no longer reshuffles later months' targets.
      // RAW period target: sum of the configured monthly targets for the
      // clipped window (e.g. CRBT 3B over 12 months).
      const rawPeriodTarget = windowMonths.reduce((s, m) => s + (shareMap[m] || 0), 0);

      const monthlyBreakdown = [];
      let totalActual = 0;
      let totalExpected = 0;
      let alertCounts = { green: 0, yellow: 0, orange: 0, red: 0, none: 0 };
      const nMonths = windowMonths.length;

      for (let mi = 0; mi < nMonths; mi++) {
        const month = windowMonths[mi];
        const actual = revMap[`${serviceName}|${month}`] || 0;
        const isPastMonth = month < currentYYYYMM;
        const isCurrentMonth = month === currentYYYYMM;
        const isFutureMonth = !isPastMonth && !isCurrentMonth;
        // The month's expectation is exactly its configured target.
        const monthExpected = shareMap[month] || 0;
        const alertLevel = isFutureMonth ? 'none' : getAlertLevel(actual, monthExpected);
        const variance = actual - monthExpected;
        const achievementPct = monthExpected > 0 ? ((actual / monthExpected) * 100).toFixed(1) : 0;

        monthlyBreakdown.push({
          month,
          month_label: getMonthLabel(month),
          expected: Math.round(monthExpected),
          actual: Math.round(actual),
          variance: Math.round(variance),
          achievement_pct: parseFloat(achievementPct),
          alert_level: alertLevel,
          is_future: isFutureMonth,
          is_current: isCurrentMonth,
        });

        totalActual += actual;
        totalExpected += monthExpected;
        if (!isFutureMonth) alertCounts[alertLevel]++;
      }

      // Overall achievement for this service (merged targets)
      const overallPct = rawPeriodTarget > 0 ? ((totalActual / rawPeriodTarget) * 100).toFixed(1) : 0;
      const overallVariance = totalActual - rawPeriodTarget;
      const overallLevel = getAlertLevel(totalActual, rawPeriodTarget);

      // Find the most recent month in the breakdown that is <= current month
      const pastMonths = monthlyBreakdown.filter(m => m.month <= currentYYYYMM);
      const currentMonth = pastMonths.length > 0 ? pastMonths[pastMonths.length - 1] : null;

      const currentAlertLevel = currentMonth ? currentMonth.alert_level : 'none';
      const currentAchievementPct = currentMonth ? currentMonth.achievement_pct : 0;
      const currentActual = currentMonth ? currentMonth.actual : 0;
      const currentExpected = currentMonth ? currentMonth.expected : 0;
      const currentMonthLabel = currentMonth ? currentMonth.month_label : 'N/A';
      const currentVariance = currentMonth ? currentMonth.variance : 0;

      const primaryTarget = svcTargets.slice().sort((a, b) => Number(b.target_amount) - Number(a.target_amount))[0];
      serviceAlerts.push({
        target_id: primaryTarget ? primaryTarget.id : svcTargets[0].id,
        service_name: serviceName,
        service_code: primaryTarget ? primaryTarget.service_code : '',
        period_type: primaryTarget ? primaryTarget.period_type : 'yearly',
        total_target: Math.round(rawPeriodTarget),
        total_actual: Math.round(totalActual),
        total_expected: Math.round(totalExpected),
        overall_achievement_pct: parseFloat(overallPct),
        overall_variance: Math.round(overallVariance),
        overall_alert_level: overallLevel,
        // Current period flag (most recent month)
        current_month: currentMonthLabel,
        current_alert_level: currentAlertLevel,
        current_achievement_pct: currentAchievementPct,
        current_actual: currentActual,
        current_expected: currentExpected,
        current_variance: currentVariance,
        months_count: windowMonths.length,
        monthly_expected: Math.round(currentExpected),
        alert_counts: alertCounts,
        monthly_breakdown: monthlyBreakdown,
      });
    }

    // Global summary
    const summary = {
      total_services: serviceAlerts.length,
      total_target: serviceAlerts.reduce((s, a) => s + a.total_target, 0),
      total_actual: serviceAlerts.reduce((s, a) => s + a.total_actual, 0),
      critical: serviceAlerts.filter(a => a.overall_alert_level === 'red').length,
      warning: serviceAlerts.filter(a => a.overall_alert_level === 'orange' || a.overall_alert_level === 'yellow').length,
      on_track: serviceAlerts.filter(a => a.overall_alert_level === 'green').length,
      // Current period counts
      current_critical: serviceAlerts.filter(a => a.current_alert_level === 'red').length,
      current_warning: serviceAlerts.filter(a => a.current_alert_level === 'orange' || a.current_alert_level === 'yellow').length,
      current_on_track: serviceAlerts.filter(a => a.current_alert_level === 'green').length,
    };
    summary.overall_achievement_pct = summary.total_target > 0
      ? ((summary.total_actual / summary.total_target) * 100).toFixed(1) : 0;

    res.json({ services: serviceAlerts, summary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/alerts/active — Only services with alerts (yellow, orange, red)
router.get('/active', async (req, res) => {
  try {
    const [targets] = await pool.execute(`
      SELECT rt.*,
        COALESCE(vs.name, rt.service_name) as service_name
      FROM revenue_targets rt
      LEFT JOIN vas_services vs ON rt.service_id = vs.id
      WHERE rt.target_start_date IS NOT NULL AND rt.target_end_date IS NOT NULL
        AND (rt.service_id IS NULL OR vs.status = 'active')
      ORDER BY rt.target_start_date ASC
    `);

    const alerts = [];

    for (const target of targets) {
      const totalTarget = parseFloat(target.target_amount);

      // Mode-aware monthly expectation: manual targets use their admin-set
      // allocations; automatic targets keep the legacy period-based split.
      const monthlyMap = (await resolveMonthlyTargets([target]))[target.service_name] || {};
      const monthlyExpectedFor = (month) =>
        monthlyMap[month] !== undefined
          ? monthlyMap[month]
          : totalTarget / getMonthsInPeriod(target.period_type);

      const startDate = toDateStr(target.target_start_date);
      const endDate = toDateStr(target.target_end_date);
      const now = new Date();
      const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      // Only check months up to now
      const months = getMonthsInRange(startDate, endDate).filter(m => m <= currentMonth);

      let worstLevel = 'green';
      const monthAlerts = [];

      for (const month of months) {
        const [revenue] = await pool.execute(
          `SELECT COALESCE(SUM(total), 0) as actual FROM (
            SELECT total_revenue as total FROM partner_revenue WHERE service_name = ? AND revenue_month = ?
            UNION ALL
            SELECT ar.amount as total FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id WHERE vs.name = ? AND ar.revenue_month = ?
          ) combined`,
          [target.service_name, month, target.service_name, month]
        );

        const actual = parseFloat(revenue[0].actual);
        const level = getAlertLevel(actual, monthlyExpectedFor(month));

        if (level === 'red') worstLevel = 'red';
        else if (level === 'orange' && worstLevel !== 'red') worstLevel = 'orange';
        else if (level === 'yellow' && worstLevel === 'green') worstLevel = 'yellow';

        if (level !== 'green' && level !== 'none') {
          monthAlerts.push({ month, month_label: getMonthLabel(month), level, actual: Math.round(actual), expected: Math.round(monthlyExpectedFor(month)) });
        }
      }

      if (worstLevel === 'red' || worstLevel === 'orange' || worstLevel === 'yellow') {
        alerts.push({
          service_name: target.service_name,
          period_type: target.period_type,
          total_target: Math.round(totalTarget),
          alert_level: worstLevel,
          month_alerts: monthAlerts,
        });
      }
    }

    res.json(alerts);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
