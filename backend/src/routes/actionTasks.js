const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { createNotification } = require('./notifications');

// Create action_tasks table if not exists
async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS action_tasks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      action_id INT NOT NULL,
      title VARCHAR(500) NOT NULL,
      description TEXT,
      assigned_to INT,
      assigned_to_name VARCHAR(255),
      assigned_by VARCHAR(100),
      assigned_by_id INT,
      due_date DATE,
      priority ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
      status ENUM('pending', 'in_progress', 'completed', 'cancelled') DEFAULT 'pending',
      completed_date DATETIME,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (action_id) REFERENCES action_notes(id) ON DELETE CASCADE,
      FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL
    )
  `);
}
ensureTable().catch(() => {});

// Migration: add assigned_by_id column if missing
async function migrateTable() {
  try {
    await pool.query(`ALTER TABLE action_tasks ADD COLUMN assigned_by_id INT NULL`);
  } catch (e) { /* column already exists */ }
}
migrateTable().catch(() => {});

// GET all tasks for an action
router.get('/action/:actionId', async (req, res) => {
  try {
    const [tasks] = await pool.execute(
      `SELECT t.*, u.full_name as assignee_name, u.avatar_url as assignee_avatar,
              ua.full_name as assigner_name, ua.avatar_url as assigner_avatar
       FROM action_tasks t
       LEFT JOIN users u ON t.assigned_to = u.id
       LEFT JOIN users ua ON t.assigned_by_id = ua.id
       WHERE t.action_id = ?
       ORDER BY 
         CASE t.priority 
           WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 
         END,
         t.due_date ASC, t.created_at ASC`,
      [req.params.actionId]
    );
    res.json(tasks);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST create task
router.post('/', async (req, res) => {
  try {
    const { action_id, title, description, assigned_to, assigned_to_name, assigned_by, assigned_by_id, due_date, priority } = req.body;
    if (!action_id || !title) {
      return res.status(400).json({ error: 'Action ID and title are required' });
    }

    // If assigned_to is provided, get the user's name
    let assigneeName = assigned_to_name;
    if (assigned_to && !assigneeName) {
      const [user] = await pool.execute('SELECT full_name FROM users WHERE id = ?', [assigned_to]);
      if (user.length > 0) assigneeName = user[0].full_name;
    }

    // Tasks are automatically in progress once assigned
    const taskStatus = assigned_to ? 'in_progress' : 'pending';
    const assignerId = assigned_by_id || (req.user && req.user.id) || null;
    const assignerName = assigned_by || (req.user && (req.user.full_name || req.user.username)) || null;

    const [result] = await pool.execute(
      `INSERT INTO action_tasks (action_id, title, description, assigned_to, assigned_to_name, assigned_by, assigned_by_id, due_date, priority, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [action_id, title, description || null, assigned_to || null, assigneeName || null, assignerName, assignerId, due_date || null, priority || 'medium', taskStatus]
    );

    // Notify the assigned person
    if (assigned_to) {
      const [act] = await pool.execute('SELECT title FROM action_notes WHERE id = ?', [action_id]);
      const actionTitle = act.length > 0 ? act[0].title : `Action #${action_id}`;
      await createNotification({
        user_id: assigned_to,
        type: 'task_assigned',
        title: 'New task assigned to you',
        message: `You have been assigned the task "${title}" on action "${actionTitle}"`,
        action_id,
        link: '/actions',
        section: (req.user && req.user.section) || 'VAS',
      });
    }

    const [newTask] = await pool.execute(
      `SELECT t.*, u.full_name as assignee_name, u.avatar_url as assignee_avatar,
              ua.full_name as assigner_name, ua.avatar_url as assigner_avatar
       FROM action_tasks t LEFT JOIN users u ON t.assigned_to = u.id
       LEFT JOIN users ua ON t.assigned_by_id = ua.id WHERE t.id = ?`,
      [result.insertId]
    );

    // Add to action history
    await pool.execute(
      'INSERT INTO action_history (action_id, old_status, new_status, note, changed_by) VALUES (?, ?, ?, ?, ?)',
      [action_id, null, 'task_assigned', `Task assigned: "${title}" → ${assigneeName || 'Unassigned'}`, assignerName || 'System']
    );

    res.status(201).json(newTask[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT update task
router.put('/:id', async (req, res) => {
  try {
    const { title, description, assigned_to, assigned_to_name, due_date, priority, status } = req.body;
    
    let assigneeName = assigned_to_name;
    if (assigned_to && !assigneeName) {
      const [user] = await pool.execute('SELECT full_name FROM users WHERE id = ?', [assigned_to]);
      if (user.length > 0) assigneeName = user[0].full_name;
    }

    await pool.execute(
      `UPDATE action_tasks SET title=?, description=?, assigned_to=?, assigned_to_name=?, due_date=?, priority=?, status=?,
       completed_date = IF(? = 'completed', NOW(), completed_date)
       WHERE id=?`,
      [title, description || null, assigned_to || null, assigneeName || null, due_date || null, priority || 'medium', status || 'pending', status || 'pending', req.params.id]
    );

    const [updated] = await pool.execute(
      `SELECT t.*, u.full_name as assignee_name, u.avatar_url as assignee_avatar,
              ua.full_name as assigner_name, ua.avatar_url as assigner_avatar
       FROM action_tasks t LEFT JOIN users u ON t.assigned_to = u.id
       LEFT JOIN users ua ON t.assigned_by_id = ua.id WHERE t.id = ?`,
      [req.params.id]
    );
    res.json(updated[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PATCH update task status — only the assigned user (or assigner/admin) may change it
router.patch('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;

    const [existing] = await pool.execute(
      `SELECT t.*, a.created_by_id as action_creator_id FROM action_tasks t
       JOIN action_notes a ON t.action_id = a.id WHERE t.id = ?`,
      [req.params.id]
    );
    if (existing.length === 0) return res.status(404).json({ error: 'Task not found' });
    const task = existing[0];

    // Only the assigned user (the task owner) may change the task status.
    // If the task has no assignee yet, fall back to assigner / creator / admin.
    let allowed;
    if (task.assigned_to != null) {
      allowed = req.user && req.user.id === task.assigned_to;
    } else {
      allowed = req.user && (
        req.user.id === task.assigned_by_id ||
        req.user.id === task.action_creator_id ||
        req.user.role_scope === 'GLOBAL'
      );
    }
    if (!allowed) {
      return res.status(403).json({ error: 'Only the assigned user can complete this task' });
    }

    await pool.execute(
      'UPDATE action_tasks SET status=?, completed_date = IF(? = \'completed\', NOW(), completed_date) WHERE id=?',
      [status, status, req.params.id]
    );
    const [updated] = await pool.execute(
      `SELECT t.*, u.full_name as assignee_name, u.avatar_url as assignee_avatar,
              ua.full_name as assigner_name, ua.avatar_url as assigner_avatar
       FROM action_tasks t LEFT JOIN users u ON t.assigned_to = u.id
       LEFT JOIN users ua ON t.assigned_by_id = ua.id WHERE t.id = ?`,
      [req.params.id]
    );

    const actorName = req.user && (req.user.full_name || req.user.username);
    // Add to action history
    if (updated.length > 0) {
      await pool.execute(
        'INSERT INTO action_history (action_id, old_status, new_status, note, changed_by) VALUES (?, ?, ?, ?, ?)',
        [updated[0].action_id, 'task', 'task_' + status, `Task "${updated[0].title}" marked as ${status}`, actorName || updated[0].assigned_to_name || 'System']
      );
    }

    // Notify the assigner when the assignee completes the task
    if (status === 'completed' && updated.length > 0 && updated[0].assigned_by_id && req.user && req.user.id === updated[0].assigned_to) {
      const { createNotification } = require('./notifications');
      await createNotification({
        user_id: updated[0].assigned_by_id,
        type: 'task_completed',
        title: 'Task completed',
        message: `${actorName} completed the task "${updated[0].title}"`,
        action_id: updated[0].action_id,
        link: '/actions',
        section: (req.user && req.user.section) || 'VAS',
      });
    }

    res.json(updated[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE task
router.delete('/:id', async (req, res) => {
  try {
    const [task] = await pool.execute('SELECT * FROM action_tasks WHERE id = ?', [req.params.id]);
    if (task.length > 0) {
      await pool.execute(
        'INSERT INTO action_history (action_id, old_status, new_status, note, changed_by) VALUES (?, ?, ?, ?, ?)',
        [task[0].action_id, 'task', 'task_deleted', `Task deleted: "${task[0].title}"`, 'System']
      );
    }
    await pool.execute('DELETE FROM action_tasks WHERE id = ?', [req.params.id]);
    res.json({ message: 'Task deleted' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET task summary for an action
router.get('/summary/:actionId', async (req, res) => {
  try {
    const [summary] = await pool.execute(
      `SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
        SUM(CASE WHEN due_date < CURDATE() AND status NOT IN ('completed', 'cancelled') THEN 1 ELSE 0 END) as overdue
       FROM action_tasks WHERE action_id = ?`,
      [req.params.actionId]
    );
    res.json(summary[0] || { total: 0, pending: 0, in_progress: 0, completed: 0, cancelled: 0, overdue: 0 });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
