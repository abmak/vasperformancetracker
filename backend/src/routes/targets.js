const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { requirePermission } = require('../middleware/permissions');
const { ensureTargetAllocationSchema } = require('../utils/targetCalculator');

// ── Target allocation mode & monthly allocations (admin feature) ─────────────
// 'automatic' = legacy equal split across the period; 'manual' = the admin
// allocates a target amount for each month of the fiscal period and every
// report/alert/dashboard uses those month values vs actual revenue.

// GET /api/targets/:id/allocations — mode + monthly allocations for one target
router.get('/:id/allocations', requirePermission('targets.edit'), async (req, res) => {
  try {
    await ensureTargetAllocationSchema();
    const [rows] = await pool.execute('SELECT * FROM revenue_targets WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Target not found' });
    const t = rows[0];
    const [allocs] = await pool.execute(
      'SELECT target_month, allocated_amount FROM revenue_target_allocations WHERE target_id = ? ORDER BY target_month',
      [req.params.id]
    );
    const allocations = {};
    allocs.forEach(a => { allocations[a.target_month] = parseFloat(a.allocated_amount); });
    res.json({
      target_id: t.id,
      service_id: t.service_id,
      service_name: t.service_name,
      target_amount: parseFloat(t.target_amount),
      period_type: t.period_type,
      target_start_date: t.target_start_date,
      target_end_date: t.target_end_date,
      allocation_mode: t.allocation_mode || 'automatic',
      allocations,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/targets/:id/allocations — set mode and/or replace monthly allocations
// Body: { allocation_mode?: 'automatic'|'manual', allocations?: { 'YYYY-MM': amount } }
router.put('/:id/allocations', requirePermission('targets.edit'), async (req, res) => {
  try {
    await ensureTargetAllocationSchema();
    const [rows] = await pool.execute('SELECT * FROM revenue_targets WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Target not found' });
    const t = rows[0];
    const { allocation_mode, allocations } = req.body || {};

    if (allocation_mode !== undefined && !['automatic', 'manual'].includes(allocation_mode)) {
      return res.status(400).json({ error: "allocation_mode must be 'automatic' or 'manual'" });
    }

    if (allocation_mode !== undefined && allocation_mode !== (t.allocation_mode || 'automatic')) {
      await pool.execute('UPDATE revenue_targets SET allocation_mode = ? WHERE id = ?', [allocation_mode, t.id]);
      await pool.execute(
        'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name, new_value) VALUES (?, ?, ?, ?, ?, ?)',
        ['update', 'target', t.id, `Target allocation mode set to ${allocation_mode} for ${t.service_name}`, req.body.user_name || 'System', JSON.stringify({ from: t.allocation_mode || 'automatic', to: allocation_mode })]
      );
    }

    if (allocations !== undefined) {
      if (typeof allocations !== 'object' || allocations === null) {
        return res.status(400).json({ error: 'allocations must be an object of { "YYYY-MM": amount }' });
      }
      // Replace-all semantics — the UI always sends the complete month map.
      await pool.execute('DELETE FROM revenue_target_allocations WHERE target_id = ?', [t.id]);
      const entries = Object.entries(allocations).filter(([, v]) => v !== null && v !== '' && !Number.isNaN(Number(v)));
      for (const [month, amount] of entries) {
        if (!/^\d{4}-\d{2}$/.test(month)) {
          return res.status(400).json({ error: `Invalid month key: ${month} (expected YYYY-MM)` });
        }
        await pool.execute(
          'INSERT INTO revenue_target_allocations (target_id, service_id, service_name, target_month, allocated_amount) VALUES (?, ?, ?, ?, ?)',
          [t.id, t.service_id || null, t.service_name || null, month, Number(amount)]
        );
      }
      const saved = entries.length;
      await pool.execute(
        'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name, new_value) VALUES (?, ?, ?, ?, ?, ?)',
        ['update', 'target', t.id, `Saved ${saved} monthly target allocations for ${t.service_name}`, req.body.user_name || 'System', JSON.stringify(allocations)]
      );
    }

    const [allocs] = await pool.execute(
      'SELECT target_month, allocated_amount FROM revenue_target_allocations WHERE target_id = ? ORDER BY target_month',
      [t.id]
    );
    const result = {};
    allocs.forEach(a => { result[a.target_month] = parseFloat(a.allocated_amount); });
    const [updated] = await pool.execute('SELECT allocation_mode FROM revenue_targets WHERE id = ?', [t.id]);
    res.json({
      target_id: t.id,
      allocation_mode: updated[0]?.allocation_mode || 'automatic',
      allocations: result,
      allocated_total: Object.values(result).reduce((s, v) => s + v, 0),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET all targets with service info - support date range filtering
router.get('/', async (req, res) => {
  try {
    const { period_type, fiscal_year, service_id, start_date, end_date } = req.query;
    let query = `
      SELECT rt.*,
        COALESCE(vs.name, rt.service_name) as service_name,
        COALESCE(vs.code, '') as service_code
      FROM revenue_targets rt
      LEFT JOIN vas_services vs ON rt.service_id = vs.id
      WHERE 1=1
    `;
    const params = [];

    if (period_type) {
      query += ' AND rt.period_type = ?';
      params.push(period_type);
    }
    if (fiscal_year) {
      query += ' AND rt.fiscal_year = ?';
      params.push(fiscal_year);
    }
    if (service_id) {
      query += ' AND rt.service_id = ?';
      params.push(service_id);
    }
    // Date range filtering: target overlaps with the query range
    if (start_date) {
      query += ' AND (rt.target_end_date >= ? OR rt.target_end_date IS NULL)';
      params.push(start_date);
    }
    if (end_date) {
      query += ' AND (rt.target_start_date <= ? OR rt.target_start_date IS NULL)';
      params.push(end_date);
    }

    query += ' ORDER BY rt.created_at DESC';
    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET target with achievement for a service
router.get('/:id/achievement', async (req, res) => {
  try {
    const [target] = await pool.execute(
      `SELECT rt.*, COALESCE(vs.name, rt.service_name) as service_name FROM revenue_targets rt
       LEFT JOIN vas_services vs ON rt.service_id = vs.id WHERE rt.id = ?`,
      [req.params.id]
    );
    if (target.length === 0) {
      return res.status(404).json({ error: 'Target not found' });
    }

    const t = target[0];

    // Use start_date/end_date for partner_revenue filtering
    let partnerFilter = 'WHERE service_name = ?';
    const params = [t.service_name];

    if (t.target_start_date && t.target_end_date) {
      partnerFilter += ' AND revenue_month >= ? AND revenue_month <= ?';
      // Convert dates to YYYY-MM format
      const startMonth = t.target_start_date.substring(0, 7);
      const endMonth = t.target_end_date.substring(0, 7);
      params.push(startMonth, endMonth);
    } else if (t.period_value) {
      partnerFilter += ' AND revenue_month = ?';
      params.push(t.period_value);
    }

    const [partnerRevenue] = await pool.execute(
      `SELECT COALESCE(SUM(total_revenue), 0) as total_achieved
       FROM partner_revenue ${partnerFilter}`,
      params
    );
    const achieved = parseFloat(partnerRevenue[0].total_achieved);
    const targetAmount = parseFloat(t.target_amount);
    const percentage = targetAmount > 0 ? ((achieved / targetAmount) * 100).toFixed(2) : 0;
    const remaining = Math.max(0, targetAmount - achieved);

    res.json({
      ...t,
      achieved,
      percentage: parseFloat(percentage),
      remaining,
      status: achieved >= targetAmount ? 'achieved' : 'in_progress'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST create target with start/end dates
router.post('/', requirePermission('targets.create'), async (req, res) => {
  try {
    const { service_id, service_name, target_amount, period_type, period_value, target_start_date, target_end_date, fiscal_year, assigned_by, notes } = req.body;
    // Validate required fields
    if (!target_amount || !period_type) {
      return res.status(400).json({ error: 'Target amount and period type are required' });
    }
    // Get service name from vas_services if not provided
    let serviceName = service_name;
    if (!serviceName && service_id) {
      const [svc] = await pool.execute('SELECT name FROM vas_services WHERE id = ?', [service_id]);
      if (svc.length > 0) serviceName = svc[0].name;
    }
    const sid = service_id || null;
    // If no service_id and no service_name, reject
    if (!sid && !serviceName) {
      return res.status(400).json({ error: 'Service is required' });
    }

    // Auto-calculate end date from start_date + period_type if end_date not provided
    let startDate = target_start_date || null;
    let endDate = target_end_date || null;
    if (startDate && !endDate) {
      endDate = calculateEndDate(startDate, period_type);
    }

    const [result] = await pool.execute(
      'INSERT INTO revenue_targets (service_id, service_name, target_amount, period_type, period_value, target_start_date, target_end_date, fiscal_year, assigned_by, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [sid, serviceName, target_amount, period_type, period_value || null, startDate, endDate, fiscal_year || null, assigned_by || null, notes || null]
    );

    // Audit trail
    await pool.execute(
      'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name, new_value) VALUES (?, ?, ?, ?, ?, ?)',
      ['create', 'target', result.insertId, `Set ${period_type} target: ${target_amount} ETB (${startDate} to ${endDate})`, assigned_by || 'System', JSON.stringify(req.body)]
    );

    const [newTarget] = await pool.execute(
      `SELECT rt.*, COALESCE(vs.name, rt.service_name) as service_name FROM revenue_targets rt
       LEFT JOIN vas_services vs ON rt.service_id = vs.id WHERE rt.id = ?`,
      [result.insertId]
    );
    res.status(201).json(newTarget[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT update target
router.put('/:id', requirePermission('targets.edit'), async (req, res) => {
  try {
    const { target_amount, period_type, period_value, target_start_date, target_end_date, fiscal_year, assigned_by, notes } = req.body;

    let startDate = target_start_date || null;
    let endDate = target_end_date || null;
    if (startDate && !endDate) {
      endDate = calculateEndDate(startDate, period_type);
    }

    await pool.execute(
      'UPDATE revenue_targets SET target_amount = ?, period_type = ?, period_value = ?, target_start_date = ?, target_end_date = ?, fiscal_year = ?, assigned_by = ?, notes = ? WHERE id = ?',
      [target_amount, period_type, period_value || null, startDate, endDate, fiscal_year || null, assigned_by || null, notes || null, req.params.id]
    );

    const [updated] = await pool.execute(
      `SELECT rt.*, COALESCE(vs.name, rt.service_name) as service_name FROM revenue_targets rt
       LEFT JOIN vas_services vs ON rt.service_id = vs.id WHERE rt.id = ?`,
      [req.params.id]
    );
    res.json(updated[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE target
router.delete('/:id', requirePermission('targets.delete'), async (req, res) => {
  try {
    await pool.execute('DELETE FROM revenue_targets WHERE id = ?', [req.params.id]);
    res.json({ message: 'Target deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper: calculate end date from start date + period type
// Uses local time formatting to avoid UTC timezone shift issues
function calculateEndDate(startDate, periodType) {
  const [y, m, d] = startDate.split('-').map(Number);
  // Format Date to YYYY-MM-DD using local time (avoids toISOString UTC shift)
  function fmtDate(dateObj) {
    const yy = dateObj.getFullYear();
    const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
    const dd = String(dateObj.getDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }
  if (periodType === 'monthly') {
    return fmtDate(new Date(y, m, 0));
  } else if (periodType === 'quarterly') {
    const quarterMonth = Math.ceil(m / 3) * 3;
    return fmtDate(new Date(y, quarterMonth, 0));
  } else if (periodType === 'yearly') {
    let endYear, endMonth;
    if (m === 1) { endYear = y; endMonth = 12; }
    else { endYear = y + 1; endMonth = m - 1; }
    return fmtDate(new Date(endYear, endMonth, 0));
  }
  return fmtDate(new Date(y, m, 0));
}

module.exports = router;
