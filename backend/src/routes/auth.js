const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { rolePermissions } = require('../utils/rolePermissions');
const { issueChallenge, verifyChallenge, captchaRateLimit } = require('../utils/puzzleCaptcha');

const JWT_SECRET = process.env.JWT_SECRET || 'vas-revenue-tracker-secret-key-2026';
const JWT_EXPIRY = '24h';
const RESET_EXPIRY_MINUTES = 30;

const ALL_SECTIONS = ['VAS', 'INDIRECT_CHANNEL'];

/**
 * getAvailableSections — the sections a user may enter.
 *
 * For a GLOBAL-scope role (the master admin), the available sections come from
 * role_section_access. If no entries exist for the role, all sections are
 * returned (backward-compatible default).
 *
 * For a MULTI_SECTION role ("Different Sections" in the Roles UI), the sections
 * listed for the role ARE the sections it belongs to: the user may enter any of
 * them and nothing else.
 *
 * For other roles, the user's own section plus whatever their role was granted
 * in role_section_access (if the role also holds the sections.swap permission).
 */
async function getAvailableSections({ section, role_scope: roleScope }, roleId) {
  if (roleScope === 'MULTI_SECTION') {
    const [rows] = await pool.query(
      'SELECT section FROM role_section_access WHERE role_id = ?',
      [roleId || 0]
    );
    const scoped = ALL_SECTIONS.filter(s => rows.some(r => r.section === s));
    if (scoped.length > 0) return scoped;
    // No sections configured yet: fall back to where the user already is rather
    // than locking them out of the app entirely.
    return section ? [section] : ALL_SECTIONS;
  }

  if (roleScope === 'GLOBAL') {
    // Check role_section_access for the GLOBAL role; fall back to ALL_SECTIONS
    // when no rows exist (backward-compatible default).
    const [rows] = await pool.query(
      'SELECT section FROM role_section_access WHERE role_id = ?',
      [roleId || 0]
    );
    if (rows.length > 0) {
      return ALL_SECTIONS.filter(s => rows.some(r => r.section === s));
    }
    return ALL_SECTIONS;
  }

  if (section === null || section === undefined) {
    return ALL_SECTIONS;
  }

  const allowed = new Set(section ? [section] : []);

  const [swapPerm] = await pool.query(
    `SELECT p.name FROM permissions p
     JOIN role_permissions rp ON rp.permission_id = p.id
     WHERE rp.role_id = ? AND p.name = 'sections.swap'`,
    [roleId || 0]
  );

  if (swapPerm.length > 0) {
    const [rows] = await pool.query(
      'SELECT section FROM role_section_access WHERE role_id = ?',
      [roleId || 0]
    );
    rows.forEach(r => allowed.add(r.section));
  }

  return ALL_SECTIONS.filter(s => allowed.has(s));
}

// GET /api/auth/captcha — new slider-puzzle challenge (rate-limited per IP)
router.get('/captcha', captchaRateLimit, (req, res) => {
  res.json(issueChallenge());
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password, captcha_id, captcha_x } = req.body;

    // Puzzle captcha must pass BEFORE anything else — this endpoint is the only
    // way in, so it is the natural bottleneck for bots/credential stuffing.
    const verdict = await verifyChallenge(captcha_id, captcha_x);
    if (!verdict.ok) {
      const hint = verdict.reason === 'expired'
        ? 'Puzzle expired — try again'
        : 'Puzzle verification failed — drag the piece into place and retry';
      return res.status(400).json({ error: hint, captcha_failed: true, captcha_reason: verdict.reason });
    }

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Find user by email
    const [users] = await pool.query(
      `SELECT u.id, u.full_name, u.email, u.username, u.password_hash, u.role_id, u.department, u.section, u.division, u.status, u.avatar_url,
              r.name as role_name, r.scope as role_scope
       FROM users u
       LEFT JOIN roles r ON u.role_id = r.id
       WHERE u.email = ? OR u.username = ?`,
      [email, email]
    );

    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = users[0];

    if (user.status !== 'active') {
      return res.status(403).json({ error: 'Account is inactive. Contact your administrator.' });
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update last_login
    await pool.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    // Get user permissions, narrowed to the section they are in when the role is
    // scoped to several sections.
    const perms = await rolePermissions(user.role_id, {
      scope: user.role_scope,
      section: user.section,
    });

    const available_sections = await getAvailableSections(user, user.role_id);

    // Generate JWT
    const token = jwt.sign(
      { id: user.id, email: user.email, username: user.username, role_id: user.role_id, role_name: user.role_name, role_scope: user.role_scope, section: user.section || null },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    // Audit trail
    await pool.query(
      'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name) VALUES (?, ?, ?, ?, ?)',
      ['login', 'user', user.id, `User logged in: ${user.full_name}`, user.username]
    );

    res.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        username: user.username,
        role_id: user.role_id,
        role_name: user.role_name,
        role_scope: user.role_scope || null,
        department: user.department,
        section: user.section || null,
        division: user.division || null,
        avatar_url: user.avatar_url || null,
        permissions: perms,
        available_sections,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Find user by email
    const [users] = await pool.query('SELECT id, full_name, email FROM users WHERE email = ?', [email]);
    if (users.length === 0) {
      // Don't reveal whether email exists
      return res.json({ message: 'If an account with that email exists, a password reset link has been sent.' });
    }

    const user = users[0];

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetExpires = new Date(Date.now() + RESET_EXPIRY_MINUTES * 60 * 1000);

    // Store reset token in users table
    await pool.query(
      'UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?',
      [resetToken, resetExpires, user.id]
    );

    // In production, send email here. For now, return the token for testing.
    const resetUrl = `http://localhost:3001/reset-password?token=${resetToken}`;

    // Audit trail
    await pool.query(
      'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name) VALUES (?, ?, ?, ?, ?)',
      ['forgot_password', 'user', user.id, `Password reset requested for: ${user.email}`, user.username || user.email]
    );

    // TODO: In production, send email with resetUrl
    // For development, return the URL directly
    res.json({
      message: 'If an account with that email exists, a password reset link has been sent.',
      // Dev only — remove in production:
      _dev_reset_url: resetUrl,
      _dev_expires_at: resetExpires,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, new_password } = req.body;
    if (!token || !new_password) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }

    // Find user by reset token
    const [users] = await pool.query(
      'SELECT id, full_name, email, reset_token_expires FROM users WHERE reset_token = ?',
      [token]
    );

    if (users.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const user = users[0];

    // Check expiry
    if (new Date(user.reset_token_expires) < new Date()) {
      return res.status(400).json({ error: 'Reset token has expired. Please request a new one.' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(new_password, salt);

    // Update password and clear reset token
    await pool.query(
      'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?',
      [hashedPassword, user.id]
    );

    // Audit trail
    await pool.query(
      'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name) VALUES (?, ?, ?, ?, ?)',
      ['reset_password', 'user', user.id, `Password reset completed for: ${user.email}`, user.email]
    );

    res.json({ message: 'Password has been reset successfully. You can now log in with your new password.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/auth/me — verify token and return current user
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    const [users] = await pool.query(
      `SELECT u.id, u.full_name, u.email, u.username, u.role_id, u.department, u.section, u.division, u.status, u.avatar_url,
              r.name as role_name
       FROM users u
       LEFT JOIN roles r ON u.role_id = r.id
       WHERE u.id = ?`,
      [decoded.id]
    );

    if (users.length === 0 || users[0].status !== 'active') {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    const user = users[0];

    // Honour the section and section-specific role carried by the token, so a
    // reload after a section swap does not snap the UI back to the default role.
    const roleId = decoded.role_id || user.role_id;
    const section = 'section' in decoded ? decoded.section : (user.section || null);
    let roleName = decoded.role_name;
    let roleScope = decoded.role_scope;
    if (!roleName || !roleScope) {
      const [roleRows] = await pool.query('SELECT name, scope FROM roles WHERE id = ?', [roleId]);
      roleName = roleName || roleRows[0]?.name || null;
      roleScope = roleScope || roleRows[0]?.scope || null;
    }

    // Get permissions for the effective role, narrowed to the section this token
    // is in when the role spans several sections.
    const perms = await rolePermissions(roleId, { scope: roleScope, section });

    const available_sections = await getAvailableSections({ section, role_scope: roleScope }, roleId);

    res.json({
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        username: user.username,
        role_id: roleId,
        role_name: roleName,
        role_scope: roleScope || null,
        department: user.department,
        section,
        division: user.division || null,
        avatar_url: user.avatar_url || null,
        permissions: perms,
        available_sections,
      },
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/auth/change-password — Change password while logged in ────────
router.post('/change-password', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    if (new_password.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    const [users] = await pool.query('SELECT id, password_hash FROM users WHERE id = ?', [decoded.id]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isMatch = await bcrypt.compare(current_password, users[0].password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(new_password, salt);
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [hashedPassword, decoded.id]);

    await pool.query(
      'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name) VALUES (?, ?, ?, ?, ?)',
      ['change_password', 'user', decoded.id, 'User changed their password', decoded.username]
    );

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/auth/upload-avatar — Upload profile picture (base64) ──────────
router.post('/upload-avatar', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    const { avatar_data } = req.body; // base64 data URL

    if (!avatar_data) {
      return res.status(400).json({ error: 'Avatar data is required' });
    }

    await pool.query('UPDATE users SET avatar_url = ? WHERE id = ?', [avatar_data, decoded.id]);

    res.json({ message: 'Avatar updated', avatar_url: avatar_data });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE /api/auth/remove-avatar — Remove profile picture ─────────────────
router.delete('/remove-avatar', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    await pool.query('UPDATE users SET avatar_url = NULL WHERE id = ?', [decoded.id]);
    res.json({ message: 'Avatar removed' });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    res.status(500).json({ error: error.message });
  }
});

// ── POST /api/auth/swap-section — Admin-only section switch ──────────────
router.post('/swap-section', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    // Load fresh user from DB
    const [users] = await pool.query(
      `SELECT u.id, u.full_name, u.email, u.username, u.role_id, u.section, u.status,
              u.department, u.division, u.avatar_url, r.name as role_name, r.scope as role_scope
       FROM users u LEFT JOIN roles r ON u.role_id = r.id
       WHERE u.id = ?`,
      [decoded.id]
    );
    if (!users.length) return res.status(404).json({ error: 'User not found' });
    const user = users[0];

    // Check if user can swap sections
    const isMasterAdmin = user.role_scope === 'GLOBAL';
    const isCrossSection = user.section === null;
    
    // Check sections.swap permission
    const [swapPermCheck] = await pool.query(
      `SELECT p.name FROM permissions p
       JOIN role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = ? AND p.name = 'sections.swap'`,
      [user.role_id || 0]
    );
    const hasSwapPermission = swapPermCheck.length > 0;
    
    // A role scoped to several sections may move between the sections it owns; the
    // role_section_access check below confines it to exactly those.
    const canMultiSection = user.role_scope === 'MULTI_SECTION';

    if (!isMasterAdmin && !isCrossSection && !hasSwapPermission && !canMultiSection) {
      return res.status(403).json({ error: 'Only admin, cross-section users, or users with sections.swap permission can swap sections' });
    }

    const { target_section } = req.body; // 'VAS' or 'INDIRECT_CHANNEL' or null for cross-section
    if (target_section !== 'VAS' && target_section !== 'INDIRECT_CHANNEL' && target_section !== null) {
      return res.status(400).json({ error: 'Invalid section. Use VAS, INDIRECT_CHANNEL, or null for cross-section.' });
    }

    // Check if the role has access to the target section via role_section_access.
    // When role_section_access has entries for a role (including GLOBAL),
    // enforce them for everyone — same logic as getAvailableSections.
    if (target_section) {
      const [accessRows] = await pool.query(
        'SELECT section FROM role_section_access WHERE role_id = ?',
        [user.role_id || 0]
      );
      if (accessRows.length > 0) {
        const isAllowed = accessRows.some(r => r.section === target_section);
        if (!isAllowed) {
          return res.status(403).json({ error: `Your role does not have access to the ${target_section} section` });
        }
      }
    }

    // Look up section-specific role from user_sections table
    let effectiveRoleId = user.role_id;
    let effectiveRoleName = user.role_name;
    let effectiveRoleScope = user.role_scope;
    
    if (target_section) {
      const [sectionRole] = await pool.query(
        `SELECT us.role_id, r.name as role_name, r.scope as role_scope
         FROM user_sections us
         JOIN roles r ON r.id = us.role_id
         WHERE us.user_id = ? AND us.section = ?`,
        [user.id, target_section]
      );
      if (sectionRole.length > 0) {
        effectiveRoleId = sectionRole[0].role_id;
        effectiveRoleName = sectionRole[0].role_name;
        effectiveRoleScope = sectionRole[0].role_scope;
      }
    }

    // Generate new token with the target section and section-specific role
    const targetPerms = await rolePermissions(effectiveRoleId, {
      scope: effectiveRoleScope,
      section: target_section,
    });

    const available_sections = await getAvailableSections(
      { section: target_section, role_scope: effectiveRoleScope },
      effectiveRoleId
    );

    const newToken = jwt.sign(
      { id: user.id, email: user.email, username: user.username, role_id: effectiveRoleId, role_name: effectiveRoleName, role_scope: effectiveRoleScope, section: target_section },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );

    // Audit trail
    await pool.query(
      'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name) VALUES (?, ?, ?, ?, ?)',
      ['section_swap', 'user', user.id, `Swapped to section: ${target_section || 'Cross-Section'} (role: ${effectiveRoleName})`, user.username]
    );

    res.json({
      token: newToken,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        username: user.username,
        role_id: effectiveRoleId,
        role_name: effectiveRoleName,
        role_scope: effectiveRoleScope || null,
        section: target_section,
        department: user.department,
        division: user.division || null,
        avatar_url: user.avatar_url || null,
        permissions: targetPerms,
        available_sections,
      },
    });
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
