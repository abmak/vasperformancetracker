const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { getCached, setCached, invalidate } = require('../utils/endpointCache');

// Helper: convert YYYY-MM-DD date to YYYY-MM for comparison
function toMonth(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// Helper: build WHERE clause for date range or single month
// revenue_month is stored as 'YYYY-MM' format
function buildDateFilter(start_date, end_date, revenue_month) {
  const conditions = [];
  const params = [];

  if (revenue_month) {
    conditions.push('revenue_month = ?');
    params.push(revenue_month);
  } else if (start_date || end_date) {
    if (start_date) {
      const startMonth = toMonth(start_date);
      conditions.push('revenue_month >= ?');
      params.push(startMonth);
    }
    if (end_date) {
      const endMonth = toMonth(end_date);
      conditions.push('revenue_month <= ?');
      params.push(endMonth);
    }
  }

  return {
    where: conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '',
    params
  };
}

// ---------------------------------------------------------------------------
// Fuzzy partner-name matching for ranking.
// Partner names that differ only by wording/casing/generic suffixes (e.g.
// "Digital Virgo Technology Solution PLC" vs "Digital Virgo (Youscribe)")
// belong to the same partner, so their revenue is combined when ranking.
// ---------------------------------------------------------------------------
const { partnerNamesMatch, partnerTokens, partnerSigTokens, tokenDice, charBigramDice, PARTNER_STOP, countUniqueFuzzyPartners } = require('../utils/partnerMerge');
const { getPartnerCountForRange } = require('../utils/partnerCountCache');

// Merge per-name aggregated rows (from SQL) into canonical partner clusters
function mergePartnerNames(rows) {
  const clusters = [];
  for (const row of rows) {
    const c = clusters.find((cl) => partnerNamesMatch(row.partner_name, cl.canonical));
    if (!c) {
      clusters.push({ canonical: row.partner_name, parts: [row] });
    } else {
      c.parts.push(row);
      // Canonical name = the variant with the most revenue (keeps the official name)
      const cur = c.parts.find((p) => p.partner_name === c.canonical);
      if (parseFloat(row.total_revenue) > parseFloat(cur.total_revenue)) {
        c.canonical = row.partner_name;
      }
    }
  }
  return clusters.map((c) => {
    const services = new Set();
    let entryCount = 0;
    let totalRev = 0;
    let ethioShare = 0;
    const aliases = [];
    c.parts.forEach((p) => {
      String(p.services || '').split(',').forEach((s) => { const t = s.trim(); if (t) services.add(t); });
      entryCount += parseInt(p.entry_count || 0, 10);
      totalRev += parseFloat(p.total_revenue || 0);
      ethioShare += parseFloat(p.ethio_share || 0);
      if (p.partner_name !== c.canonical) aliases.push(p.partner_name);
    });
    return {
      partner_name: c.canonical,
      aliases,
      services: [...services].sort().join(', '),
      service_count: services.size,
      entry_count: entryCount,
      total_revenue: Math.round(totalRev * 100) / 100,
      ethio_share: Math.round(ethioShare * 100) / 100,
    };
  });
}

// GET dashboard KPIs — includes both partner_revenue AND actual_revenue
router.get('/dashboard-kpis', async (req, res) => {
  try {
    const { revenue_month, start_date, end_date } = req.query;

    // Check cache first
    const cached = getCached('/partners/dashboard-kpis', req.query);
    if (cached) return res.json(cached);

    const { where, params } = buildDateFilter(start_date, end_date, revenue_month);
    let arWhere = '';
    const arParams = [];
    if (revenue_month) {
      arWhere = 'WHERE ar.revenue_month = ?';
      arParams.push(revenue_month);
    } else if (start_date || end_date) {
      const conditions = [];
      if (start_date) { conditions.push('ar.revenue_month >= ?'); arParams.push(toMonth(start_date)); }
      if (end_date) { conditions.push('ar.revenue_month <= ?'); arParams.push(toMonth(end_date)); }
      arWhere = 'WHERE ' + conditions.join(' AND ');
    }
    const srcLabel = `(
      SELECT partner_name, service_name, total_revenue, ethio_share FROM partner_revenue ${where ? where + ' AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'}
      UNION ALL
      SELECT COALESCE(ar.partner_name, 'Manual') as partner_name, vs.name as service_name, ar.amount as total_revenue, 0 as ethio_share
      FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arWhere ? arWhere + ' AND vs.status = \'active\'' : 'WHERE vs.status = \'active\''}
    )`;
    const combinedParams = [...params, ...arParams];

    // Run ALL queries in parallel
    const [
      [totals],
      [partnerRows],
      [topServices],
      [topPartnersRaw],
      [categoryBreakdown],
    ] = await Promise.all([
      pool.execute(
        `SELECT SUM(total_revenue) as grand_total, SUM(ethio_share) as total_ethio, COUNT(DISTINCT service_name) as total_services
         FROM ${srcLabel} combined`,
        combinedParams
      ),
      pool.execute(
        `SELECT DISTINCT partner_name FROM ${srcLabel} combined WHERE partner_name IS NOT NULL AND partner_name != ''`,
        combinedParams
      ),
      pool.execute(
        `SELECT service_name, SUM(total_revenue) as total_revenue, COUNT(*) as partner_count
         FROM ${srcLabel} combined GROUP BY service_name ORDER BY total_revenue DESC LIMIT 10`,
        combinedParams
      ),
      pool.execute(
        `SELECT partner_name, GROUP_CONCAT(DISTINCT service_name ORDER BY service_name SEPARATOR ', ') as services,
          SUM(total_revenue) as total_revenue, COUNT(DISTINCT service_name) as service_count, COUNT(*) as entry_count
         FROM ${srcLabel} combined
         WHERE partner_name IS NOT NULL AND partner_name != '' AND partner_name != 'Manual'
         GROUP BY partner_name ORDER BY total_revenue DESC`,
        combinedParams
      ),
      pool.execute(
        `SELECT service_name, SUM(total_revenue) as total_revenue, SUM(ethio_share) as total_ethio
         FROM ${srcLabel} combined GROUP BY service_name ORDER BY total_revenue DESC`,
        combinedParams
      ),
    ]);

    // Use shared partner count cache (avoids re-running fuzzy merge)
    const startMonth = combinedParams[0] || null;
    const endMonth = combinedParams[1] || null;
    const totalPartnersFuzzy = await getPartnerCountForRange(startMonth, endMonth);
    const topPartners = mergePartnerNames(topPartnersRaw)
      .filter((r) => r.partner_name !== 'Unknown Partner')
      .sort((a, b) => parseFloat(b.total_revenue) - parseFloat(a.total_revenue))
      .slice(0, 10); // Return top 10 so frontend doesn't need a separate /top-partners call

    const result = {
      grand_total: totals[0]?.grand_total || 0,
      total_ethio: totals[0]?.total_ethio || 0,
      total_partners: totalPartnersFuzzy || 0,
      total_services: totals[0]?.total_services || 0,
      top_services: topServices,
      top_partners: topPartners,
      category_breakdown: categoryBreakdown,
    };

    setCached('/partners/dashboard-kpis', req.query, result);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET service summary — includes both tables
router.get('/summary', async (req, res) => {
  try {
    const { revenue_month, start_date, end_date } = req.query;

    // Cache — summary data is stable for the session
    const cached = getCached('/partners/summary', req.query);
    if (cached) return res.json(cached);

    const { where, params } = buildDateFilter(start_date, end_date, revenue_month);
    let arWhere = '';
    const arParams = [];
    if (revenue_month) { arWhere = 'WHERE ar.revenue_month = ?'; arParams.push(revenue_month); }
    else if (start_date || end_date) {
      const c = [];
      if (start_date) { c.push('ar.revenue_month >= ?'); arParams.push(toMonth(start_date)); }
      if (end_date) { c.push('ar.revenue_month <= ?'); arParams.push(toMonth(end_date)); }
      arWhere = 'WHERE ' + c.join(' AND ');
    }
    const [rows] = await pool.execute(
      `SELECT service_name, SUM(total_revenue) as total_revenue, SUM(ethio_share) as total_ethio, COUNT(*) as partner_count
       FROM (
        SELECT partner_name, service_name, total_revenue, ethio_share FROM partner_revenue ${where ? where + ' AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'}
        UNION ALL
        SELECT COALESCE(ar.partner_name, 'Manual') as partner_name, vs.name as service_name, ar.amount as total_revenue, 0 as ethio_share
        FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arWhere ? arWhere + ' AND vs.status = \'active\'' : 'WHERE vs.status = \'active\''}
       ) combined
       GROUP BY service_name
       ORDER BY total_revenue DESC`,
      [...params, ...arParams]
    );
    setCached('/partners/summary', req.query, rows);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET available months — includes both tables
router.get('/months', async (req, res) => {
  try {
    // Cache for 10 minutes — month list rarely changes during a session
    const cached = getCached('/partners/months', {});
    if (cached) return res.json(cached);

    const [rows] = await pool.execute(
      `SELECT revenue_month, 
        SUM(total_revenue) as total_revenue,
        0 as total_ethio,
        COUNT(*) as total_partners
       FROM (
        SELECT revenue_month, total_revenue FROM partner_revenue WHERE revenue_month IS NOT NULL
        UNION ALL
        SELECT ar.revenue_month, ar.amount as total_revenue FROM actual_revenue ar WHERE ar.revenue_month IS NOT NULL
       ) combined
       GROUP BY revenue_month 
       ORDER BY revenue_month DESC`
    );
    setCached('/partners/months', {}, rows, 10 * 60 * 1000); // 10 min TTL
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET full partner list with search/pagination — includes both tables
router.get('/partners', async (req, res) => {
  try {
    const { revenue_month, start_date, end_date, service_name, search, page = 1, limit = 50 } = req.query;
    const { where: dateWhere, params: dateParams } = buildDateFilter(start_date, end_date, revenue_month);
    let arWhere = '';
    const arParams = [];
    if (revenue_month) { arWhere = 'WHERE ar.revenue_month = ?'; arParams.push(revenue_month); }
    else if (start_date || end_date) {
      const c = [];
      if (start_date) { c.push('ar.revenue_month >= ?'); arParams.push(toMonth(start_date)); }
      if (end_date) { c.push('ar.revenue_month <= ?'); arParams.push(toMonth(end_date)); }
      arWhere = 'WHERE ' + c.join(' AND ');
    }

    let outerClauses = [];
    const outerParams = [];
    if (service_name) { outerClauses.push('combined.service_name = ?'); outerParams.push(service_name); }
    if (search) { outerClauses.push('combined.partner_name LIKE ?'); outerParams.push(`%${search}%`); }

    const outerWhere = outerClauses.length > 0 ? 'WHERE ' + outerClauses.join(' AND ') : '';

    // Build count query with service filter via subquery
    let countSql = `SELECT COUNT(DISTINCT partner_name) as total FROM (
      SELECT partner_name, service_name FROM partner_revenue ${dateWhere ? dateWhere + ' AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'}
      UNION ALL
      SELECT COALESCE(ar.partner_name, 'Manual') as partner_name, vs.name as service_name
      FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arWhere ? arWhere + ' AND vs.status = \'active\'' : 'WHERE vs.status = \'active\''}
    ) combined WHERE combined.partner_name IS NOT NULL AND combined.partner_name != ''`;
    const countParams = [...dateParams, ...arParams];
    if (service_name) {
      countSql += ' AND combined.service_name = ?';
      countParams.push(service_name);
    }
    if (search) {
      countSql += ' AND combined.partner_name LIKE ?';
      countParams.push(`%${search}%`);
    }
    const [countResult] = await pool.execute(countSql, countParams);

    const offset = (parseInt(page) - 1) * parseInt(limit);
    // Service/search filters are applied to the per-row data BEFORE grouping.
    // (Putting a WHERE after GROUP BY is invalid SQL and broke this list.)
    const rowClauses = ['combined.partner_name IS NOT NULL AND combined.partner_name != \'\''];
    const rowParams = [];
    if (service_name) { rowClauses.push('combined.service_name = ?'); rowParams.push(service_name); }
    if (search) { rowClauses.push('combined.partner_name LIKE ?'); rowParams.push(`%${search}%`); }
    const rowWhere = 'WHERE ' + rowClauses.join(' AND ');

    const [rows] = await pool.execute(
      `SELECT partner_name, 
        GROUP_CONCAT(DISTINCT service_name ORDER BY service_name SEPARATOR ', ') as services,
        SUM(total_revenue) as total_revenue,
        SUM(ethio_share) as ethio_share,
        MAX(revenue_month) as latest_month,
        COUNT(DISTINCT service_name) as service_count,
        COUNT(*) as entry_count
       FROM (
        SELECT partner_name, service_name, total_revenue, ethio_share, revenue_month FROM partner_revenue ${dateWhere ? dateWhere + ' AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'}
        UNION ALL
        SELECT COALESCE(ar.partner_name, 'Manual') as partner_name, vs.name as service_name, ar.amount as total_revenue, 0 as ethio_share, ar.revenue_month
        FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arWhere ? arWhere + ' AND vs.status = \'active\'' : 'WHERE vs.status = \'active\''}
       ) combined
       ${rowWhere}
       GROUP BY partner_name
       ORDER BY total_revenue DESC
       LIMIT ${parseInt(limit)} OFFSET ${offset}`,
      [...dateParams, ...arParams, ...rowParams]
    );

    res.json({
      data: rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: countResult[0].total,
        pages: Math.ceil(countResult[0].total / parseInt(limit))
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET individual partner revenue records (for edit/delete)
router.get('/records', async (req, res) => {
  try {
    const { revenue_month, start_date, end_date, service_name, search, page = 1, limit = 50 } = req.query;
    const { where: dateWhere, params: dateParams } = buildDateFilter(start_date, end_date, revenue_month);

    let whereClauses = ['pr.partner_name IS NOT NULL AND pr.partner_name != \'\''];
    let whereParams = [];
    // Add date filter conditions if present
    if (dateWhere) {
      whereClauses.push(dateWhere.replace('WHERE ', ''));
      whereParams.push(...dateParams);
    }
    if (service_name) { whereClauses.push('pr.service_name = ?'); whereParams.push(service_name); }
    if (search) { whereClauses.push('pr.partner_name LIKE ?'); whereParams.push(`%${search}%`); }
    const whereStr = 'WHERE ' + whereClauses.join(' AND ');

    const [countResult] = await pool.execute(
      `SELECT COUNT(*) as total FROM partner_revenue pr ${whereStr}`,
      whereParams
    );
    const total = countResult[0].total;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const [rows] = await pool.execute(
      `SELECT id, partner_name, service_name, total_revenue, ethio_share, revenue_month, import_batch_id, created_at
       FROM partner_revenue pr
       ${whereStr}
       ORDER BY revenue_month DESC, total_revenue DESC
       LIMIT ${parseInt(limit)} OFFSET ${offset}`,
      whereParams
    );

    res.json({
      data: rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE revenue data by month (YYYY-MM) — deletes from both tables
router.delete('/month/:revenueMonth', async (req, res) => {
  try {
    const { revenueMonth } = req.params;
    if (!revenueMonth || !/^\d{4}-\d{2}$/.test(revenueMonth)) {
      return res.status(400).json({ error: 'Invalid month format. Use YYYY-MM.' });
    }

    // Only delete BATCH-IMPORTED data — leave manual entries intact
    // partner_revenue: batch imports have import_batch_id set
    // actual_revenue: manual entries have source = 'manual'
    const [countPR] = await pool.execute(
      'SELECT COUNT(*) as cnt, SUM(total_revenue) as total_rev FROM partner_revenue WHERE revenue_month = ? AND import_batch_id IS NOT NULL',
      [revenueMonth]
    );
    const [countAR] = await pool.execute(
      "SELECT COUNT(*) as cnt, SUM(amount) as total_rev FROM actual_revenue WHERE revenue_month = ? AND (source IS NULL OR source != 'manual')",
      [revenueMonth]
    );
    const totalCnt = (countPR[0].cnt || 0) + (countAR[0].cnt || 0);
    const totalRev = parseFloat(countPR[0].total_rev || 0) + parseFloat(countAR[0].total_rev || 0);

    if (totalCnt === 0) {
      return res.status(404).json({ error: `No batch-imported revenue data found for ${revenueMonth}. Manual entries are preserved.` });
    }

    // Delete only batch-imported records from both tables
    await pool.execute('DELETE FROM partner_revenue WHERE revenue_month = ? AND import_batch_id IS NOT NULL', [revenueMonth]);
    await pool.execute("DELETE FROM actual_revenue WHERE revenue_month = ? AND (source IS NULL OR source != 'manual')", [revenueMonth]);

    // Invalidate cached data so the months list refreshes
    invalidate('/partners/months');
    invalidate('/partners');
    invalidate('/partners/summary');
    invalidate('/partners/top-partners');

    res.json({
      message: `Deleted ${totalCnt} records for ${revenueMonth}`,
      deleted_count: totalCnt,
      total_revenue_deleted: totalRev
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET top N partners for a service — includes both tables
router.get('/top-partners', async (req, res) => {
  try {
    const { service_name, revenue_month, start_date, end_date, limit = 10 } = req.query;

    // Cache — top partners don't change within a session
    const cached = getCached('/partners/top-partners', req.query);
    if (cached) return res.json(cached);

    const { where, params } = buildDateFilter(start_date, end_date, revenue_month);
    let arWhere = '';
    const arParams = [];
    if (revenue_month) { arWhere = 'WHERE ar.revenue_month = ?'; arParams.push(revenue_month); }
    else if (start_date || end_date) {
      const c = [];
      if (start_date) { c.push('ar.revenue_month >= ?'); arParams.push(toMonth(start_date)); }
      if (end_date) { c.push('ar.revenue_month <= ?'); arParams.push(toMonth(end_date)); }
      arWhere = 'WHERE ' + c.join(' AND ');
    }
    let extraWhere = '';
    if (service_name) {
      extraWhere = ' AND combined.service_name = ?';
      params.push(service_name);
    }

    const [rows] = await pool.execute(
      `SELECT partner_name, 
        GROUP_CONCAT(DISTINCT service_name ORDER BY service_name SEPARATOR ', ') as services,
        SUM(total_revenue) as total_revenue, 
        SUM(ethio_share) as ethio_share,
        COUNT(DISTINCT service_name) as service_count,
        COUNT(*) as entry_count
       FROM (
        SELECT partner_name, service_name, total_revenue, ethio_share FROM partner_revenue ${where ? where + ' AND service_name IN (SELECT name FROM vas_services WHERE status = \'active\')' : 'WHERE service_name IN (SELECT name FROM vas_services WHERE status = \'active\')'}
        UNION ALL
        SELECT COALESCE(ar.partner_name, 'Manual') as partner_name, vs.name as service_name, ar.amount as total_revenue, 0 as ethio_share
        FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id ${arWhere ? arWhere + ' AND vs.status = \'active\'' : 'WHERE vs.status = \'active\''}
       ) combined
       WHERE combined.partner_name IS NOT NULL AND combined.partner_name != '' AND combined.partner_name != 'Manual' ${extraWhere}
       GROUP BY partner_name
       ORDER BY total_revenue DESC`,
      [...params, ...arParams]
    );

    // Merge partner names that differ only by wording (fuzzy match), then rank.
    const merged = mergePartnerNames(rows)
      .filter((r) => r.partner_name !== 'Unknown Partner')
      .sort((a, b) => parseFloat(b.total_revenue) - parseFloat(a.total_revenue))
      .slice(0, parseInt(limit) || 10);
    setCached('/partners/top-partners', req.query, merged);
    res.json(merged);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT update a single partner_revenue record
router.put('/:id', async (req, res) => {
  try {
    const { partner_name, service_name, total_revenue, ethio_share, revenue_month } = req.body;
    const [existing] = await pool.execute('SELECT * FROM partner_revenue WHERE id = ?', [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Record not found' });

    await pool.execute(
      `UPDATE partner_revenue SET 
        partner_name = COALESCE(?, partner_name),
        service_name = COALESCE(?, service_name),
        total_revenue = COALESCE(?, total_revenue),
        ethio_share = COALESCE(?, ethio_share),
        revenue_month = COALESCE(?, revenue_month)
       WHERE id = ?`,
      [partner_name, service_name, total_revenue, ethio_share, revenue_month, req.params.id]
    );

    const [updated] = await pool.execute('SELECT * FROM partner_revenue WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE a single partner_revenue record
router.delete('/:id', async (req, res) => {
  try {
    const [existing] = await pool.execute('SELECT * FROM partner_revenue WHERE id = ?', [req.params.id]);
    if (existing.length === 0) return res.status(404).json({ error: 'Record not found' });

    await pool.execute('DELETE FROM partner_revenue WHERE id = ?', [req.params.id]);
    res.json({ message: 'Record deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
