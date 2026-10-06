/**
 * Failover event log + master-admin notifications.
 *
 * NOTE: `./database` is required lazily inside the functions (not at module
 * top) because database.js requires this module — a top-level require would
 * be circular and receive an empty exports object.
 *
 * recordFailoverEvent(type, message) — writes one row into system_events
 * (table created lazily) and, when the failover STATE changes, notifies
 * every active GLOBAL-scope (master admin) user via the notifications table.
 *
 * Writes go through the failover-aware pool, so events land on whichever
 * database is currently serving — and survive failback (standby → primary
 * restore) because the standby is the source during an incident.
 */

let ensured = false;

async function ensureTable() {
  if (ensured) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS system_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      event_type VARCHAR(50) NOT NULL,
      severity ENUM('info','warning','critical') NOT NULL DEFAULT 'info',
      message VARCHAR(500) NOT NULL,
      details TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_system_events_created (created_at),
      INDEX idx_system_events_type (event_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  ensured = true;
}

// Notify only on state transitions, never on every flip attempt.
let lastNotifiedState = null;

async function notifyMasterAdmins(state, message) {
  if (state === lastNotifiedState) return;
  lastNotifiedState = state;
  try {
    const db = require('./database');
    const [admins] = await db.query(`
      SELECT u.id FROM users u
      JOIN roles r ON u.role_id = r.id
      WHERE r.scope = 'GLOBAL' AND u.status = 'active'
    `);
    if (!admins.length) return;
    const title = state === 'standby'
      ? '⚠️ Database failover — running on STANDBY'
      : '✅ Database back on PRIMARY';
    const values = admins.map(() => '(?, ?, ?, ?, ?)').join(', ');
    const params = [];
    for (const a of admins) {
      params.push(a.id, 'system_failover', title, message, '/admin/system-health');
    }
    await db.query(
      `INSERT INTO notifications (user_id, type, title, message, link) VALUES ${values}`,
      params
    );
  } catch (e) {
    console.warn('[db-failover-events] notification failed:', e.message);
  }
}

/**
 * type: 'FAILOVER_START' | 'FAILOVER_END' | 'INFO'
 */
async function recordFailoverEvent(type, message, details) {
  try {
    const db = require('./database');
    await ensureTable();
    const severity = type === 'FAILOVER_START' ? 'critical'
      : type === 'FAILOVER_END' ? 'info' : 'warning';
    await db.query(
      'INSERT INTO system_events (event_type, severity, message, details) VALUES (?, ?, ?, ?)',
      [type, severity, String(message).slice(0, 500), details ? JSON.stringify(details).slice(0, 2000) : null]
    );
    if (type === 'FAILOVER_START') {
      await notifyMasterAdmins('standby', message);
    } else if (type === 'FAILOVER_END') {
      await notifyMasterAdmins('primary', message);
    }
  } catch (e) {
    // Never let event logging break request handling.
    console.warn('[db-failover-events] could not record event:', e.message);
  }
}

module.exports = { recordFailoverEvent };
