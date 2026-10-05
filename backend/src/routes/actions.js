const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { createNotification } = require('./notifications');

// Create action_notes table if not exists
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS action_notes (
      id INT AUTO_INCREMENT PRIMARY KEY,
      service_name VARCHAR(255),
      action_type ENUM('strategy', 'campaign', 'partnership', 'pricing', 'promotion', 'technical', 'other') DEFAULT 'strategy',
      title VARCHAR(500) NOT NULL,
      description TEXT,
      expected_impact VARCHAR(500),
      actual_impact VARCHAR(500),
      revenue_month VARCHAR(10),
      action_caused_change BOOLEAN DEFAULT NULL,
      status ENUM('planned', 'in_progress', 'completed', 'cancelled') DEFAULT 'planned',
      priority ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
      target_date DATE,
      completed_date DATETIME,
      created_by VARCHAR(100),
      created_by_id INT,
      cancel_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS action_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      action_id INT NOT NULL,
      old_status VARCHAR(50),
      new_status VARCHAR(50) NOT NULL,
      note TEXT,
      changed_by VARCHAR(100) DEFAULT 'System',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (action_id) REFERENCES action_notes(id) ON DELETE CASCADE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS action_replies (
      id INT AUTO_INCREMENT PRIMARY KEY,
      action_id INT NOT NULL,
      task_id INT,
      user_id INT,
      user_name VARCHAR(255),
      message TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (action_id) REFERENCES action_notes(id) ON DELETE CASCADE
    )
  `);
}
ensureTable().catch(() => {});

// Migration: add missing columns
async function migrateTable() {
  try {
    await pool.query(`ALTER TABLE action_notes ADD COLUMN action_caused_change BOOLEAN DEFAULT NULL`);
  } catch (e) { /* column already exists */ }
  try {
    await pool.query(`ALTER TABLE action_notes ADD COLUMN created_by_id INT NULL`);
  } catch (e) { /* column already exists */ }
  try {
    await pool.query(`ALTER TABLE action_notes ADD COLUMN cancel_reason TEXT NULL`);
  } catch (e) { /* column already exists */ }
  try {
    await pool.query(`ALTER TABLE action_replies ADD COLUMN task_id INT NULL`);
  } catch (e) { /* column already exists */ }
}
migrateTable().catch(() => {});

// Valid status transitions
const VALID_TRANSITIONS = {
  planned: ['in_progress', 'cancelled', 'expired'],
  in_progress: ['completed', 'cancelled', 'expired'],
  completed: [],
  cancelled: ['planned'],
  expired: ['planned'],  // Can reopen an expired action
};

// Compute revenue change (current month vs previous month) for an action's service + revenue month
async function computeRevenueChange(action) {
  if (!action || !action.service_name || !action.revenue_month) return null;
  const [year, mon] = action.revenue_month.split('-').map(Number);
  const prevMon = mon === 1 ? 12 : mon - 1;
  const prevYear = mon === 1 ? year - 1 : year;
  const prevMonth = `${prevYear}-${String(prevMon).padStart(2, '0')}`;
  const currentMonth = action.revenue_month;

  const [currentRev] = await pool.execute(
    `SELECT COALESCE(SUM(total), 0) as revenue FROM (
      SELECT total_revenue as total FROM partner_revenue WHERE service_name = ? AND revenue_month = ?
      UNION ALL
      SELECT ar.amount as total FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id WHERE vs.name = ? AND ar.revenue_month = ?
    ) combined`,
    [action.service_name, currentMonth, action.service_name, currentMonth]
  );
  const [prevRev] = await pool.execute(
    `SELECT COALESCE(SUM(total), 0) as revenue FROM (
      SELECT total_revenue as total FROM partner_revenue WHERE service_name = ? AND revenue_month = ?
      UNION ALL
      SELECT ar.amount as total FROM actual_revenue ar JOIN vas_services vs ON ar.service_id = vs.id WHERE vs.name = ? AND ar.revenue_month = ?
    ) combined`,
    [action.service_name, prevMonth, action.service_name, prevMonth]
  );

  const currentRevenue = parseFloat(currentRev[0].revenue);
  const prevRevenue = parseFloat(prevRev[0].revenue);
  const change = currentRevenue - prevRevenue;
  const changePct = prevRevenue > 0 ? ((change / prevRevenue) * 100).toFixed(1) : null;

  return {
    current_month: currentMonth,
    previous_month: prevMonth,
    current_revenue: Math.round(currentRevenue),
    previous_revenue: Math.round(prevRevenue),
    change: Math.round(change),
    change_pct: changePct ? parseFloat(changePct) : null,
    direction: change > 0 ? 'increase' : change < 0 ? 'decrease' : 'same',
  };
}

// Get assignee ids for an action (users assigned to its tasks)
async function getAssigneeIds(actionId) {
  const [rows] = await pool.execute(
    'SELECT DISTINCT assigned_to as uid FROM action_tasks WHERE action_id = ? AND assigned_to IS NOT NULL',
    [actionId]
  );
  return rows.map(r => r.uid);
}

// GET all action notes with latest history
router.get('/', async (req, res) => {
  try {
    // Auto-expire actions where target_date has passed
    await pool.query(
      "UPDATE action_notes SET status='expired' WHERE target_date IS NOT NULL AND target_date < CURDATE() AND status IN ('planned', 'in_progress')"
    );

    const { service_name, action_type, status, revenue_month } = req.query;
    let query = 'SELECT a.*, u.full_name as created_by_name, u.avatar_url as created_by_avatar FROM action_notes a LEFT JOIN users u ON a.created_by_id = u.id WHERE 1=1';
    const params = [];

    if (service_name) { query += ' AND a.service_name = ?'; params.push(service_name); }
    if (action_type) { query += ' AND a.action_type = ?'; params.push(action_type); }
    if (status) { query += ' AND a.status = ?'; params.push(status); }
    if (revenue_month) { query += ' AND a.revenue_month = ?'; params.push(revenue_month); }

    query += ' ORDER BY a.created_at DESC';
    const [rows] = await pool.execute(query, params);

    // Attach valid transitions + revenue change to each action
    const enriched = [];
    for (const row of rows) {
      const assigneeIds = await getAssigneeIds(row.id);
      enriched.push({
        ...row,
        assignee_ids: assigneeIds,
        can_change_status: req.user && (req.user.id === row.created_by_id || assigneeIds.includes(req.user.id) || req.user.role_scope === 'GLOBAL'),
        valid_transitions: VALID_TRANSITIONS[row.status] || [],
        revenue_change: await computeRevenueChange(row),
      });
    }

    res.json(enriched);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET single action with full history
router.get('/:id', async (req, res) => {
  try {
    // Auto-expire this action if needed
    await pool.query(
      "UPDATE action_notes SET status='expired' WHERE id=? AND target_date IS NOT NULL AND target_date < CURDATE() AND status IN ('planned', 'in_progress')",
      [req.params.id]
    );

    const [actions] = await pool.execute(
      'SELECT a.*, u.full_name as created_by_name, u.avatar_url as created_by_avatar FROM action_notes a LEFT JOIN users u ON a.created_by_id = u.id WHERE a.id = ?',
      [req.params.id]
    );
    if (actions.length === 0) return res.status(404).json({ error: 'Action not found' });

    const action = actions[0];

    // Get history
    const [history] = await pool.execute(
      'SELECT * FROM action_history WHERE action_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );

    const assigneeIds = await getAssigneeIds(req.params.id);

    res.json({
      ...action,
      assignee_ids: assigneeIds,
      can_change_status: req.user && (req.user.id === action.created_by_id || assigneeIds.includes(req.user.id) || req.user.role_scope === 'GLOBAL'),
      valid_transitions: VALID_TRANSITIONS[action.status] || [],
      history,
      revenue_change: await computeRevenueChange(action),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST create action note — also creates initial history entry
router.post('/', async (req, res) => {
  try {
    const { service_name, action_type, title, description, expected_impact, revenue_month, status, priority, target_date, created_by, created_by_id } = req.body;
    const initialStatus = status || 'planned';
    const creatorId = created_by_id || (req.user && req.user.id) || null;
    const creatorName = created_by || (req.user && (req.user.full_name || req.user.username)) || null;

    const [result] = await pool.execute(
      `INSERT INTO action_notes (service_name, action_type, title, description, expected_impact, revenue_month, status, priority, target_date, created_by, created_by_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [service_name || null, action_type || 'strategy', title, description || null, expected_impact || null, revenue_month || null, initialStatus, priority || 'medium', target_date || null, creatorName, creatorId]
    );

    // Create initial history entry
    await pool.execute(
      'INSERT INTO action_history (action_id, old_status, new_status, note, changed_by) VALUES (?, ?, ?, ?, ?)',
      [result.insertId, null, initialStatus, `Action created with status: ${initialStatus}`, creatorName || 'System']
    );

    const [newNote] = await pool.execute(
      'SELECT a.*, u.full_name as created_by_name, u.avatar_url as created_by_avatar FROM action_notes a LEFT JOIN users u ON a.created_by_id = u.id WHERE a.id = ?',
      [result.insertId]
    );
    res.status(201).json({
      ...newNote[0],
      assignee_ids: [],
      can_change_status: true,
      valid_transitions: VALID_TRANSITIONS[initialStatus] || [],
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT update action note (basic fields, not status change)
router.put('/:id', async (req, res) => {
  try {
    const { service_name, action_type, title, description, expected_impact, actual_impact, revenue_month, action_caused_change, status, priority, target_date } = req.body;
    await pool.execute(
      `UPDATE action_notes SET service_name=?, action_type=?, title=?, description=?, expected_impact=?, actual_impact=?, revenue_month=?, action_caused_change=?, status=?, priority=?, target_date=? WHERE id=?`,
      [service_name || null, action_type || 'strategy', title, description || null, expected_impact || null, actual_impact || null, revenue_month || null, action_caused_change !== undefined ? action_caused_change : null, status || 'planned', priority || 'medium', target_date || null, req.params.id]
    );
    const [updated] = await pool.execute('SELECT * FROM action_notes WHERE id = ?', [req.params.id]);
    res.json({ ...updated[0], valid_transitions: VALID_TRANSITIONS[updated[0].status] || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST transition status (e.g., planned → in_progress)
router.post('/:id/transition', async (req, res) => {
  try {
    const { new_status, note, changed_by, cancel_reason } = req.body;

    // Get current action
    const [actions] = await pool.execute(
      'SELECT a.*, u.full_name as created_by_name, u.avatar_url as created_by_avatar FROM action_notes a LEFT JOIN users u ON a.created_by_id = u.id WHERE a.id = ?',
      [req.params.id]
    );
    if (actions.length === 0) return res.status(404).json({ error: 'Action not found' });

    const action = actions[0];
    const old_status = action.status;

    // Only creator, assignees or admins may change status
    const assigneeIds = await getAssigneeIds(req.params.id);
    const canChange = req.user && (req.user.id === action.created_by_id || assigneeIds.includes(req.user.id) || req.user.role_scope === 'GLOBAL');
    if (!canChange) {
      return res.status(403).json({ error: 'Only the assigned user or the action creator can change the status' });
    }

    // Validate transition
    const allowed = VALID_TRANSITIONS[old_status] || [];
    if (!allowed.includes(new_status)) {
      return res.status(400).json({ error: `Cannot transition from "${old_status}" to "${new_status}". Allowed: ${allowed.join(', ') || 'none'}` });
    }

    const actorName = changed_by || (req.user && (req.user.full_name || req.user.username)) || 'System';

    // Cancellation requires a reason
    if (new_status === 'cancelled' && !cancel_reason) {
      return res.status(400).json({ error: 'A cancellation reason is required' });
    }

    // Update action status
    await pool.execute(
      'UPDATE action_notes SET status=?, completed_date=?, cancel_reason=? WHERE id=?',
      [new_status, new_status === 'completed' ? new Date() : action.completed_date, new_status === 'cancelled' ? cancel_reason : action.cancel_reason, req.params.id]
    );

    // Record history
    const historyNote = new_status === 'cancelled'
      ? (cancel_reason ? `Action cancelled: ${cancel_reason}` : 'Action cancelled')
      : (note || `Status changed from ${old_status} to ${new_status}`);
    await pool.execute(
      'INSERT INTO action_history (action_id, old_status, new_status, note, changed_by) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, old_status, new_status, historyNote, actorName]
    );

    // Notify assignees when cancelled or completed
    if (new_status === 'cancelled' || new_status === 'completed') {
      const { createNotification } = require('./notifications');
      for (const uid of assigneeIds) {
        if (req.user && req.user.id === uid) continue;
        await createNotification({
          user_id: uid,
          type: new_status === 'cancelled' ? 'action_cancelled' : 'action_completed',
          title: new_status === 'cancelled' ? 'Action cancelled' : 'Action completed',
          message: new_status === 'cancelled'
            ? `The action "${action.title}" was cancelled by ${actorName}${cancel_reason ? `: ${cancel_reason}` : ''}`
            : `The action "${action.title}" was marked complete by ${actorName}`,
          action_id: req.params.id,
          link: '/actions',
          section: (req.user && req.user.section) || 'VAS',
        });
      }
    }

    const [updated] = await pool.execute(
      'SELECT a.*, u.full_name as created_by_name, u.avatar_url as created_by_avatar FROM action_notes a LEFT JOIN users u ON a.created_by_id = u.id WHERE a.id = ?',
      [req.params.id]
    );
    const [history] = await pool.execute(
      'SELECT * FROM action_history WHERE action_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );

    res.json({
      ...updated[0],
      assignee_ids: assigneeIds,
      can_change_status: true,
      valid_transitions: VALID_TRANSITIONS[new_status] || [],
      history,
      revenue_change: await computeRevenueChange(updated[0]),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH toggle action_caused_change checkbox
router.patch('/:id/caused-change', async (req, res) => {
  try {
    const { action_caused_change } = req.body;
    await pool.execute('UPDATE action_notes SET action_caused_change=? WHERE id=?', [action_caused_change, req.params.id]);
    const [updated] = await pool.execute('SELECT * FROM action_notes WHERE id=?', [req.params.id]);
    res.json(updated[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE action note
router.delete('/:id', async (req, res) => {
  try {
    await pool.execute('DELETE FROM action_notes WHERE id = ?', [req.params.id]);
    res.json({ message: 'Action note deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET all replies (discussion) for an action — optionally filtered by task_id
router.get('/:id/replies', async (req, res) => {
  try {
    const { task_id } = req.query;
    let query = `SELECT r.*, u.full_name as user_name, u.avatar_url as user_avatar
       FROM action_replies r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.action_id = ?`;
    const params = [req.params.id];
    if (task_id) {
      query += ' AND r.task_id = ?';
      params.push(parseInt(task_id, 10));
    } else {
      query += ' AND r.task_id IS NULL';
    }
    query += ' ORDER BY r.created_at ASC, r.id ASC';
    const [rows] = await pool.execute(query, params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST add a reply — assigner and assigned users can reply.
// Replies can target the whole action (no task_id) or a specific task (task_id).
// The other participants are notified.
router.post('/:id/replies', async (req, res) => {
  try {
    const { user_id, message, task_id } = req.body;
    if (!user_id || !message || !String(message).trim()) {
      return res.status(400).json({ error: 'user_id and message are required' });
    }

    const [users] = await pool.execute('SELECT full_name, avatar_url FROM users WHERE id = ?', [user_id]);
    const userName = users.length > 0 ? users[0].full_name : `User ${user_id}`;
    const userAvatar = users.length > 0 ? users[0].avatar_url : null;

    const [result] = await pool.execute(
      'INSERT INTO action_replies (action_id, task_id, user_id, user_name, message) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, task_id ? parseInt(task_id, 10) : null, user_id, userName, String(message).trim()]
    );

    // Notify the other participants (task assignees + task assigners), excluding the replier
    const [act] = await pool.execute('SELECT title FROM action_notes WHERE id = ?', [req.params.id]);
    const actionTitle = act.length > 0 ? act[0].title : `Action #${req.params.id}`;
    const [participants] = await pool.execute(
      `SELECT DISTINCT user_id FROM (
         SELECT assigned_to as user_id FROM action_tasks WHERE action_id = ? AND assigned_to IS NOT NULL
         UNION
         SELECT assigned_by_id as user_id FROM action_tasks WHERE action_id = ? AND assigned_by_id IS NOT NULL
       ) p WHERE user_id IS NOT NULL AND user_id != ?`,
      [req.params.id, req.params.id, user_id]
    );
    for (const p of participants) {
      await createNotification({
        user_id: p.user_id,
        type: 'action_reply',
        title: 'New reply on action',
        message: `${userName} replied on "${actionTitle}": "${String(message).trim().slice(0, 120)}"`,
        action_id: req.params.id,
        link: '/actions',
        section: (req.user && req.user.section) || 'VAS',
      });
    }

    res.status(201).json({
      id: result.insertId,
      action_id: req.params.id,
      task_id: task_id ? parseInt(task_id, 10) : null,
      user_id,
      user_name: userName,
      user_avatar: userAvatar,
      message: String(message).trim(),
      created_at: new Date(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
