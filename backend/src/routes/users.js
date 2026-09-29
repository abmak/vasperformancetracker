const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const bcrypt = require('bcryptjs');
const { requirePermission, sectionScope } = require('../middleware/permissions');

// GET all users with role info
router.get('/', async (req, res) => {
  try {
    const { role_id, status, search, section } = req.query;
    let query = `
      SELECT u.id, u.full_name, u.email, u.username, u.role_id, u.department, u.section, u.division, u.phone, 
             u.status, u.last_login, u.created_at,
             COALESCE(u.max_ai_questions_per_day, 50) as max_ai_questions_per_day,
             r.name as role_name, r.description as role_description, r.scope as role_scope
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      WHERE 1=1
    `;
    const params = [];
    
    if (role_id) {
      query += ' AND u.role_id = ?';
      params.push(role_id);
    }
    if (status) {
      query += ' AND u.status = ?';
      params.push(status);
    }
    if (section) {
      query += ' AND u.section = ?';
      params.push(section);
    }
    if (search) {
      query += ' AND (u.full_name LIKE ? OR u.email LIKE ? OR u.username LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    
    query += ' ORDER BY u.created_at DESC';
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/users/section-assignments — every per-section role assignment in one call
// (declared before /:id so it is not swallowed by the id route)
router.get('/section-assignments', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT us.user_id, us.section, us.role_id, r.name as role_name
       FROM user_sections us
       JOIN roles r ON r.id = us.role_id
       ORDER BY us.user_id, us.section`
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET single user with role and permissions
router.get('/:id', async (req, res) => {
  try {
    const [users] = await pool.query(`
      SELECT u.id, u.full_name, u.email, u.username, u.role_id, u.department, u.section, u.division, u.phone,
             u.status, u.last_login, u.created_at,
             COALESCE(u.max_ai_questions_per_day, 50) as max_ai_questions_per_day,
             r.name as role_name
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      WHERE u.id = ?
    `, [req.params.id]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get user's role permissions
    const [perms] = await pool.query(`
      SELECT p.* FROM permissions p
      JOIN role_permissions rp ON rp.permission_id = p.id
      WHERE rp.role_id = ?
      ORDER BY p.module, p.action
    `, [users[0].role_id || 0]);
    
    res.json({ ...users[0], permissions: perms });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST create user
router.post('/', requirePermission('users.create', 'channel_users.create'), async (req, res) => {
  try {
    const { full_name, email, username, password_hash, role_id, department, section, division, phone, status, max_ai_questions_per_day } = req.body;
    if (!full_name || !email || !username || !password_hash) {
      return res.status(400).json({ error: 'Full name, email, username, and password are required' });
    }
    
    // Hash password with bcrypt before storing
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password_hash, salt);

    // A section admin can only create accounts inside their own section
    const scope = sectionScope(req);
    const assignedSection = scope || (section || null);
    
    const [result] = await pool.query(
      'INSERT INTO users (full_name, email, username, password_hash, role_id, department, section, division, phone, status, max_ai_questions_per_day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [full_name, email, username, hashedPassword, role_id || null, department || null, assignedSection, division || null, phone || null, status || 'active', max_ai_questions_per_day || 50]
    );
    
    // Audit trail
    await pool.query(
      'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name, new_value) VALUES (?, ?, ?, ?, ?, ?)',
      ['create', 'user', result.insertId, `Created user: ${full_name} (${username})`, req.body.created_by || 'System', JSON.stringify({ ...req.body, password_hash: '***' })]
    );
    
    const [newUser] = await pool.query(`
      SELECT u.id, u.full_name, u.email, u.username, u.role_id, u.department, u.section, u.division, u.phone, u.status, u.created_at,
             r.name as role_name
      FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.id = ?
    `, [result.insertId]);
    res.status(201).json(newUser[0]);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Email or username already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

// PUT update user
router.put('/:id', requirePermission('users.edit', 'channel_users.edit'), async (req, res) => {
  try {
    const { full_name, email, username, password_hash, role_id, department, section, division, phone, status, max_ai_questions_per_day } = req.body;
    const [old] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (old.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // A section admin may only touch accounts inside their own section
    const scope = sectionScope(req);
    if (scope && old[0].section !== scope) {
      return res.status(403).json({ error: `You can only manage users in the ${scope} section` });
    }

    // This update writes every column, so a partial payload would silently blank
    // the missing ones. Require the identity fields instead of wiping them.
    if (!full_name || !email || !username) {
      return res.status(400).json({ error: 'full_name, email and username are required' });
    }

    // Banning (status -> inactive) must never take out the last way in.
    if (status && status !== 'active') {
      const [currentRole] = await pool.query('SELECT name, scope FROM roles WHERE id = ?', [old[0].role_id || 0]);
      if (currentRole.length > 0 && currentRole[0].scope === 'GLOBAL') {
        const [otherAdmins] = await pool.query(
          `SELECT COUNT(*) as cnt FROM users u
           JOIN roles r ON u.role_id = r.id
           WHERE r.scope = 'GLOBAL' AND u.status = 'active' AND u.id <> ?`,
          [req.params.id]
        );
        if (otherAdmins[0].cnt === 0) {
          return res.status(400).json({ error: 'Cannot deactivate the last active master admin user' });
        }
      }
    }
    
    // A password is only written when a real new value is supplied — '***' means
    // "keep current". A value identical to the stored one is also treated as
    // "keep": re-hashing it would change the hash string while leaving the actual
    // password alone, which is what makes an update look like it silently worked.
    const wantsPasswordChange = !!(password_hash && password_hash !== '***');
    let passwordChanged = false;
    if (wantsPasswordChange) {
      passwordChanged = !old[0].password_hash
        || !(await bcrypt.compare(password_hash, old[0].password_hash));
    }

    if (passwordChanged) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password_hash, salt);
      await pool.query(
        'UPDATE users SET full_name = ?, email = ?, username = ?, password_hash = ?, role_id = ?, department = ?, section = ?, division = ?, phone = ?, status = ?, max_ai_questions_per_day = ? WHERE id = ?',
        [full_name, email, username, hashedPassword, role_id || null, department || null, scope || (section || null), division || null, phone || null, status || 'active', max_ai_questions_per_day || 50, req.params.id]
      );
    } else {
      await pool.query(
        'UPDATE users SET full_name = ?, email = ?, username = ?, role_id = ?, department = ?, section = ?, division = ?, phone = ?, status = ?, max_ai_questions_per_day = ? WHERE id = ?',
        [full_name, email, username, role_id || null, department || null, scope || (section || null), division || null, phone || null, status || 'active', max_ai_questions_per_day || 50, req.params.id]
      );
    }
    
    // Audit trail
    await pool.query(
      'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['update', 'user', req.params.id, `Updated user: ${full_name}${passwordChanged ? ' (password changed)' : ''}`, req.body.updated_by || 'System', JSON.stringify(old[0]), JSON.stringify({ ...req.body, password_hash: '***' })]
    );
    
    const [updated] = await pool.query(`
      SELECT u.id, u.full_name, u.email, u.username, u.role_id, u.department, u.phone, u.status, u.created_at,
             COALESCE(u.max_ai_questions_per_day, 50) as max_ai_questions_per_day,
             r.name as role_name
      FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.id = ?
    `, [req.params.id]);
    // password_changed tells the UI whether the submitted value was actually
    // applied, so a stale/auto-filled value cannot masquerade as a successful
    // password update.
    res.json({ ...updated[0], password_changed: passwordChanged });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Email or username already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

// DELETE user
router.delete('/:id', requirePermission('users.delete', 'channel_users.delete'), async (req, res) => {
  try {
    const [user] = await pool.query('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (user.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // A section admin may only touch accounts inside their own section
    const scope = sectionScope(req);
    if (scope && user[0].section !== scope) {
      return res.status(403).json({ error: `You can only manage users in the ${scope} section` });
    }

    // Prevent deleting the last admin
    if (user[0].role_id) {
      const [role] = await pool.query('SELECT name, scope FROM roles WHERE id = ?', [user[0].role_id]);
      if (role.length > 0 && role[0].scope === 'GLOBAL') {
        const [adminCount] = await pool.query(`
          SELECT COUNT(*) as cnt FROM users u 
          JOIN roles r ON u.role_id = r.id 
          WHERE r.scope = 'GLOBAL' AND u.status = 'active'
        `);
        if (adminCount[0].cnt <= 1) {
          return res.status(400).json({ error: 'Cannot delete the last active master admin user' });
        }
      }
    }
    
    await pool.query('DELETE FROM users WHERE id = ?', [req.params.id]);
    
    // Audit trail
    await pool.query(
      'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name) VALUES (?, ?, ?, ?, ?)',
      ['delete', 'user', req.params.id, `Deleted user: ${user[0].full_name} (${user[0].username})`, req.body?.user_name || 'System']
    );
    
    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Section-specific role assignments ────────────────────────────────────

// GET /api/users/:id/sections — Get section assignments for a user
router.get('/:id/sections', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT us.id, us.user_id, us.section, us.role_id, r.name as role_name
       FROM user_sections us
       JOIN roles r ON r.id = us.role_id
       WHERE us.user_id = ?`,
      [req.params.id]
    );
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/users/:id/sections — Add or update section assignment
router.post('/:id/sections', requirePermission('users.edit', 'channel_users.edit'), async (req, res) => {
  try {
    const { section, role_id } = req.body;
    const userId = req.params.id;
    
    if (!section || !role_id) {
      return res.status(400).json({ error: 'Section and role_id are required' });
    }
    if (section !== 'VAS' && section !== 'INDIRECT_CHANNEL') {
      return res.status(400).json({ error: 'Section must be VAS or INDIRECT_CHANNEL' });
    }

    // A section admin can only assign roles for their own section
    const scope = sectionScope(req);
    if (scope && section !== scope) {
      return res.status(403).json({ error: `You can only manage the ${scope} section` });
    }

    // Verify user exists
    const [user] = await pool.query('SELECT id, section FROM users WHERE id = ?', [userId]);
    if (!user.length) return res.status(404).json({ error: 'User not found' });
    if (scope && user[0].section !== scope) {
      return res.status(403).json({ error: `You can only manage users in the ${scope} section` });
    }

    // Verify role exists
    const [role] = await pool.query('SELECT id, name FROM roles WHERE id = ?', [role_id]);
    if (!role.length) return res.status(404).json({ error: 'Role not found' });

    // The role must grant at least one permission for the section being assigned,
    // otherwise the user lands in that section with nothing to do there.
    const [sectionPermCount] = await pool.query(
      'SELECT COUNT(*) as cnt FROM permissions WHERE section = ?',
      [section]
    );
    const sectionHasPermissions = sectionPermCount[0].cnt > 0;

    if (sectionHasPermissions) {
      const [roleSectionPerms] = await pool.query(
        `SELECT COUNT(*) as cnt FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ? AND p.section = ?`,
        [role_id, section]
      );
      if (roleSectionPerms[0].cnt === 0) {
        return res.status(400).json({
          error: `Role "${role[0].name}" has no permissions for ${section === 'INDIRECT_CHANNEL' ? 'Indirect Channel' : 'VAS Section'} — assign it at least one permission for that section first`,
        });
      }
    }

    // Upsert section assignment
    await pool.query(
      `INSERT INTO user_sections (user_id, section, role_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)`,
      [userId, section, role_id]
    );

    // Audit trail
    await pool.query(
      'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name) VALUES (?, ?, ?, ?, ?)',
      ['update', 'user_section', userId, `Assigned section ${section} with role ${role_id} to user ${userId}`, req.body?.user_name || 'System']
    );

    res.json({ message: 'Section assignment saved' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/users/:id/sections/:section — Remove section assignment
router.delete('/:id/sections/:section', requirePermission('users.edit', 'channel_users.edit'), async (req, res) => {
  try {
    const { id, section } = req.params;
    
    if (section !== 'VAS' && section !== 'INDIRECT_CHANNEL') {
      return res.status(400).json({ error: 'Invalid section' });
    }

    // A section admin can only manage their own section's assignments
    const scope = sectionScope(req);
    if (scope && section !== scope) {
      return res.status(403).json({ error: `You can only manage the ${scope} section` });
    }
    const [target] = await pool.query('SELECT section FROM users WHERE id = ?', [id]);
    if (!target.length) return res.status(404).json({ error: 'User not found' });
    if (scope && target[0].section !== scope) {
      return res.status(403).json({ error: `You can only manage users in the ${scope} section` });
    }

    await pool.query(
      'DELETE FROM user_sections WHERE user_id = ? AND section = ?',
      [id, section]
    );

    // Audit trail
    await pool.query(
      'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name) VALUES (?, ?, ?, ?, ?)',
      ['delete', 'user_section', id, `Removed section ${section} assignment from user ${id}`, req.body?.user_name || 'System']
    );

    res.json({ message: 'Section assignment removed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
