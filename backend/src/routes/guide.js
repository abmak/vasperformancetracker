const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { defaultGuide, GUIDE_SECTIONS } = require('../config/guideDefaults');

const MAX_CONTENT_LENGTH = 200 * 1024; // 200KB of markdown is far beyond a guide

// The guide permissions (guide.view / guide.edit, section SHARED) are ensured
// lazily on first use, mirroring the table seeding — no manual migration step.
// addGuidePermissions.js does the same eagerly and also grants them to roles.
async function ensureGuidePermissions() {
  const [perms] = await db.query(
    "SELECT id, name FROM permissions WHERE name IN ('guide.view', 'guide.edit')"
  );
  const have = new Set(perms.map((p) => p.name));
  const wanted = [
    { name: 'guide.view', description: 'View the User Guide page', action: 'view' },
    { name: 'guide.edit', description: 'Edit the User Guide content', action: 'edit' },
  ];
  for (const w of wanted) {
    if (have.has(w.name)) continue;
    const [r] = await db.query(
      "INSERT INTO permissions (name, description, module, action, section) VALUES (?, ?, 'guide', ?, 'SHARED')",
      [w.name, w.description, w.action]
    );
    perms.push({ id: r.insertId, name: w.name });
  }
  // Default grants: every role can view; GLOBAL roles can also edit. Existing
  // grants are left untouched — the Roles page is the source of truth after
  // the first ensure.
  if (!have.has('guide.view') || !have.has('guide.edit')) {
    const [roles] = await db.query('SELECT id, scope FROM roles');
    for (const role of roles) {
      const names = role.scope === 'GLOBAL' ? ['guide.view', 'guide.edit'] : ['guide.view'];
      for (const name of names) {
        const perm = perms.find((p) => p.name === name);
        if (!perm) continue;
        await db.query(
          'INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
          [role.id, perm.id]
        );
      }
    }
  }
}

function hasGuidePermission(req, name) {
  if (req.user?.role_scope === 'GLOBAL') return true; // master admin always passes
  return Array.isArray(req.user?.permissionNames) && req.user.permissionNames.includes(name);
}

// The guide table is created and seeded lazily on first use so no separate
// migration step is needed. Safe to call concurrently (CREATE ... IF NOT EXISTS).
let readyPromise = null;
function ensureGuideTable() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS guide_content (
          section VARCHAR(30) PRIMARY KEY,
          content LONGTEXT NOT NULL,
          updated_by VARCHAR(100) NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      const [rows] = await db.query('SELECT section FROM guide_content');
      const have = new Set(rows.map((r) => r.section));
      for (const section of GUIDE_SECTIONS) {
        if (!have.has(section)) {
          await db.query(
            'INSERT INTO guide_content (section, content, updated_by) VALUES (?, ?, ?)',
            [section, defaultGuide(section), 'system default']
          );
        }
      }
    })().catch((e) => {
      readyPromise = null; // allow a retry on the next request
      throw e;
    });
  }
  return readyPromise;
}

// GET /api/guide/:section — markdown content for one section (any signed-in user)
router.get('/:section', async (req, res) => {
  try {
    const section = req.params.section;
    if (!GUIDE_SECTIONS.includes(section)) {
      return res.status(400).json({ error: `Unknown guide section: ${section}` });
    }
    await ensureGuideTable();
    await ensureGuidePermissions();
    if (!hasGuidePermission(req, 'guide.view')) {
      return res.status(403).json({ error: 'You do not have permission to view the User Guide (guide.view)' });
    }
    const [rows] = await db.query('SELECT section, content, updated_by, updated_at FROM guide_content WHERE section = ?', [section]);
    if (rows.length === 0) {
      return res.json({ section, content: defaultGuide(section), updated_by: null, updated_at: null, is_default: true });
    }
    res.json({ section: rows[0].section, content: rows[0].content, updated_by: rows[0].updated_by, updated_at: rows[0].updated_at, is_default: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/guide/:section — save edited markdown (needs the guide.edit
// permission; the master admin always passes). Configurable from the Roles page.
router.put('/:section', async (req, res) => {
  try {
    const section = req.params.section;
    if (!GUIDE_SECTIONS.includes(section)) {
      return res.status(400).json({ error: `Unknown guide section: ${section}` });
    }
    await ensureGuideTable();
    await ensureGuidePermissions();
    if (!hasGuidePermission(req, 'guide.edit')) {
      return res.status(403).json({ error: 'You do not have permission to edit the User Guide (guide.edit)' });
    }
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    if (!content.trim()) {
      return res.status(400).json({ error: 'Guide content cannot be empty' });
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      return res.status(400).json({ error: 'Guide content is too large (max 200KB)' });
    }
    await ensureGuideTable();
    const updatedBy = req.user?.username || req.user?.email || 'super admin';
    await db.query(
      `INSERT INTO guide_content (section, content, updated_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content), updated_by = VALUES(updated_by)`,
      [section, content, updatedBy]
    );
    const [rows] = await db.query('SELECT section, content, updated_by, updated_at FROM guide_content WHERE section = ?', [section]);
    res.json({ section: rows[0].section, content: rows[0].content, updated_by: rows[0].updated_by, updated_at: rows[0].updated_at, is_default: false });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
