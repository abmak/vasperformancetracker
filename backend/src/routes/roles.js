const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const { requirePermission, sectionScope, isMasterAdmin } = require('../middleware/permissions');

const VALID_SCOPES = ['GLOBAL', 'VAS', 'INDIRECT_CHANNEL', 'MULTI_SECTION'];
const SECTION_SCOPES = ['VAS', 'INDIRECT_CHANNEL'];

const sectionLabel = (section) => (section === 'INDIRECT_CHANNEL' ? 'Indirect Channel' : 'VAS Section');

/**
 * resolveScope — decides the scope a role may be given, and rejects escalation.
 *
 *   GLOBAL                   the master admin: every section, no section scoping
 *   VAS / INDIRECT_CHANNEL   a section role, valid only inside that section
 *   MULTI_SECTION            "Different Sections": the role belongs to each of the
 *                            sections listed for it, and confers the permissions
 *                            configured for that section while a user is in it
 *
 * Only a master admin may mint or edit a cross-section role (GLOBAL or
 * MULTI_SECTION); a section admin may only create or change roles inside their own
 * section.
 */
function resolveScope(req, requestedScope, currentScope) {
  const callerSection = sectionScope(req);
  const scope = requestedScope || currentScope || (callerSection || 'VAS');

  if (!VALID_SCOPES.includes(scope)) {
    return { error: `Invalid scope. Use ${VALID_SCOPES.join(', ')}.` };
  }
  if ((scope === 'GLOBAL' || scope === 'MULTI_SECTION') && !isMasterAdmin(req)) {
    return { error: `Only a master admin can create or edit a ${scope === 'GLOBAL' ? 'GLOBAL' : 'multi-section'} role` };
  }
  if (callerSection && scope !== callerSection) {
    return { error: `You can only manage ${callerSection} roles` };
  }
  return { scope };
}

/**
 * resolveSections — the sections a MULTI_SECTION role belongs to.
 *
 * Each section a role is scoped to must have at least one permission of that role
 * for the section: otherwise a user holding it enters that section with nothing to
 * do there. Returns { sections } or { error }.
 *
 * `roleId` is null on create, where the sections must be supplied; on update an
 * omitted `sections` means "leave the stored ones alone".
 */
async function resolveSections(scope, sections, permissionIds, roleId = null) {
  if (scope !== 'MULTI_SECTION' || (sections === undefined && roleId === null)) {
    return { sections: null };
  }

  const chosen = [...new Set((Array.isArray(sections) ? sections : []).filter(Boolean))];
  if (chosen.length === 0) {
    return { error: 'Choose at least one section for a role scoped to different sections' };
  }

  const invalid = chosen.filter(s => !SECTION_SCOPES.includes(s));
  if (invalid.length > 0) {
    return { error: `Invalid sections: ${invalid.join(', ')}` };
  }

  // Which sections do this role's permissions cover? Use the submitted ids, or the
  // role's stored ones when this update is not changing them.
  let ids = permissionIds;
  if (ids === undefined && roleId) {
    const [existing] = await pool.query(
      'SELECT permission_id FROM role_permissions WHERE role_id = ?',
      [roleId]
    );
    ids = existing.map(r => r.permission_id);
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return { error: `Assign at least one permission for ${chosen.map(sectionLabel).join(' and ')}` };
  }

  // permissions.section is the authoritative column, so a selected permission tells
  // us which section it can serve.
  const placeholders = ids.map(() => '?').join(',');
  const [permRows] = await pool.query(
    `SELECT DISTINCT section FROM permissions WHERE id IN (${placeholders})`,
    ids
  );
  const covered = new Set(permRows.map(p => p.section));
  const missing = chosen.filter(s => !covered.has(s));
  if (missing.length > 0) {
    return {
      error: `Assign at least one permission for ${missing.map(sectionLabel).join(' and ')} — this role is scoped to that section`,
    };
  }

  return { sections: chosen };
}

/**
 * saveSections — stores a role's sections in role_section_access, the table that
 * already maps a role to sections. Only called for MULTI_SECTION roles, so the
 * section-access configuration of other scopes is never touched.
 */
async function saveSections(roleId, scopedSections) {
  if (!scopedSections) return;
  await pool.query('DELETE FROM role_section_access WHERE role_id = ?', [roleId]);
  for (const section of scopedSections) {
    await pool.query(
      'INSERT IGNORE INTO role_section_access (role_id, section) VALUES (?, ?)',
      [roleId, section]
    );
  }
}

// GET all roles with permission count
router.get('/', async (req, res) => {
  try {
    const { section } = req.query;
    let query = `
      SELECT r.*, 
        COUNT(rp.id) as permission_count,
        (SELECT COUNT(*) FROM users WHERE role_id = r.id) as user_count,
        GROUP_CONCAT(DISTINCT p.module) as modules,
        (SELECT GROUP_CONCAT(rsa.section ORDER BY rsa.section)
           FROM role_section_access rsa WHERE rsa.role_id = r.id) as sections
      FROM roles r
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
      LEFT JOIN permissions p ON p.id = rp.permission_id
    `;

    const conditions = [];
    const params = [];

    if (section) {
      // Section membership is a property of the ROLE (roles.scope), so a newly
      // created role shows up immediately. Filtering on assigned users instead
      // hid every role that nobody holds yet. Roles that users in this section
      // already hold stay visible so nothing drops out of view, and a role scoped
      // to several sections is listed in each of them.
      conditions.push(`(r.scope = ?
        OR r.id IN (SELECT DISTINCT role_id FROM users WHERE section = ? AND role_id IS NOT NULL)
        OR (r.scope = 'MULTI_SECTION' AND EXISTS (
              SELECT 1 FROM role_section_access rsa WHERE rsa.role_id = r.id AND rsa.section = ?
            )))`);
      params.push(section, section, section);
    }

    // A role that spans several sections is cross-section configuration, so it is
    // never listed for anyone but the master admin — such a role cannot be seen,
    // picked or assigned from a section user's role list.
    if (!isMasterAdmin(req)) {
      conditions.push(`r.scope <> 'MULTI_SECTION'`);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }
    query += ` GROUP BY r.id ORDER BY r.name`;
    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET single role with its permissions
router.get('/:id', async (req, res) => {
  try {
    const [roles] = await pool.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    if (roles.length === 0) {
      return res.status(404).json({ error: 'Role not found' });
    }

    // Multi-section roles are hidden from everyone except the master admin, and
    // that applies to fetching one directly, not only to the list.
    if (roles[0].scope === 'MULTI_SECTION' && !isMasterAdmin(req)) {
      return res.status(403).json({ error: 'Only a master admin can view a role scoped to different sections' });
    }
    const [perms] = await pool.query(`
      SELECT p.* FROM permissions p
      JOIN role_permissions rp ON rp.permission_id = p.id
      WHERE rp.role_id = ?
      ORDER BY p.module, p.action
    `, [req.params.id]);

    // The sections this role is scoped to (only meaningful for MULTI_SECTION), so
    // the Roles UI can pre-tick them when editing.
    const [sectionRows] = await pool.query(
      'SELECT section FROM role_section_access WHERE role_id = ?',
      [req.params.id]
    );

    res.json({ ...roles[0], permissions: perms, sections: sectionRows.map(r => r.section) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST create role
router.post('/', requirePermission('roles.create', 'channel_roles.create'), async (req, res) => {
  try {
    const { name, description, is_default, permission_ids, scope: requestedScope, sections } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Role name is required' });
    }

    const resolved = resolveScope(req, requestedScope, null);
    if (resolved.error) {
      return res.status(403).json({ error: resolved.error });
    }

    const scoped = await resolveSections(resolved.scope, sections, permission_ids);
    if (scoped.error) {
      return res.status(400).json({ error: scoped.error });
    }

    const [result] = await pool.query(
      'INSERT INTO roles (name, description, is_default, scope) VALUES (?, ?, ?, ?)',
      [name, description || null, is_default ? 1 : 0, resolved.scope]
    );
    
    // sections.swap is meaningless for a multi-section role — it already belongs to
    // its sections — so strip it instead of storing a permission that cannot work
    // (the Roles UI hides it for this scope; this is the enforcement behind it).
    let permsToSave = permission_ids;
    if (resolved.scope === 'MULTI_SECTION' && Array.isArray(permsToSave) && permsToSave.length > 0) {
      const [swapPerm] = await pool.query("SELECT id FROM permissions WHERE name = 'sections.swap'");
      if (swapPerm.length > 0) {
        permsToSave = permsToSave.filter(id => id !== swapPerm[0].id);
      }
    }

    // Assign permissions
    if (permsToSave && permsToSave.length > 0) {
      for (const pid of permsToSave) {
        await pool.query('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [result.insertId, pid]);
      }
    }

    // A role scoped to several sections records which ones
    await saveSections(result.insertId, scoped.sections);

    // Audit trail
    await pool.query(
      'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name, new_value) VALUES (?, ?, ?, ?, ?, ?)',
      ['create', 'role', result.insertId, `Created role: ${name}`, req.body.user_name || 'System', JSON.stringify(req.body)]
    );
    
    const [newRole] = await pool.query('SELECT * FROM roles WHERE id = ?', [result.insertId]);
    res.status(201).json(newRole[0]);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Role name already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

// PUT update role
router.put('/:id', requirePermission('roles.edit', 'channel_roles.edit'), async (req, res) => {
  try {
    const { name, description, is_default, permission_ids, scope: requestedScope, sections } = req.body;
    const [old] = await pool.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    if (old.length === 0) {
      return res.status(404).json({ error: 'Role not found' });
    }

    // A section admin may only edit roles that belong to their own section, and
    // nobody but a master admin may turn a role into (or out of) GLOBAL.
    const callerScope = sectionScope(req);
    if (callerScope && old[0].scope !== callerScope) {
      return res.status(403).json({ error: `You can only manage ${callerScope} roles` });
    }

    const resolved = resolveScope(req, requestedScope, old[0].scope);
    if (resolved.error) {
      return res.status(403).json({ error: resolved.error });
    }

    const scoped = await resolveSections(resolved.scope, sections, permission_ids, req.params.id);
    if (scoped.error) {
      return res.status(400).json({ error: scoped.error });
    }

    await pool.query(
      'UPDATE roles SET name = ?, description = ?, is_default = ?, scope = ? WHERE id = ?',
      [name, description || null, is_default ? 1 : 0, resolved.scope, req.params.id]
    );
    
    // Update permissions: delete all, re-insert (sections.swap stripped for
    // multi-section roles — see the create route for why).
    if (permission_ids !== undefined) {
      let permsToSave = permission_ids;
      if (resolved.scope === 'MULTI_SECTION' && Array.isArray(permsToSave) && permsToSave.length > 0) {
        const [swapPerm] = await pool.query("SELECT id FROM permissions WHERE name = 'sections.swap'");
        if (swapPerm.length > 0) {
          permsToSave = permsToSave.filter(id => id !== swapPerm[0].id);
        }
      }
      await pool.query('DELETE FROM role_permissions WHERE role_id = ?', [req.params.id]);
      if (permsToSave.length > 0) {
        for (const pid of permsToSave) {
          await pool.query('INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)', [req.params.id, pid]);
        }
      }
    }

    // Sections are only rewritten for a multi-section role, and only when sent
    await saveSections(req.params.id, scoped.sections);
    
    // Audit trail
    await pool.query(
      'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name, old_value, new_value) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['update', 'role', req.params.id, `Updated role: ${name}`, req.body.user_name || 'System', JSON.stringify(old[0]), JSON.stringify(req.body)]
    );
    
    const [updated] = await pool.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    res.json(updated[0]);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Role name already exists' });
    }
    res.status(500).json({ error: error.message });
  }
});

// DELETE role (only if no users assigned)
router.delete('/:id', requirePermission('roles.delete', 'channel_roles.delete'), async (req, res) => {
  try {
    const [role] = await pool.query('SELECT * FROM roles WHERE id = ?', [req.params.id]);
    if (role.length === 0) {
      return res.status(404).json({ error: 'Role not found' });
    }
    if (role[0].is_default) {
      return res.status(400).json({ error: `Cannot delete default role "${role[0].name}". Unset default first.` });
    }

    // Section admins may only delete roles inside their own section
    const callerScope = sectionScope(req);
    if (callerScope && role[0].scope !== callerScope) {
      return res.status(403).json({ error: `You can only manage ${callerScope} roles` });
    }
    
    // Check if any users have this role
    const [users] = await pool.query('SELECT COUNT(*) as cnt FROM users WHERE role_id = ?', [req.params.id]);
    if (users[0].cnt > 0) {
      return res.status(400).json({ error: `Cannot delete role "${role[0].name}" — ${users[0].cnt} user(s) are assigned to it. Reassign them first.` });
    }
    
    await pool.query('DELETE FROM role_permissions WHERE role_id = ?', [req.params.id]);
    await pool.query('DELETE FROM roles WHERE id = ?', [req.params.id]);
    
    // Audit trail
    await pool.query(
      'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name) VALUES (?, ?, ?, ?, ?)',
      ['delete', 'role', req.params.id, `Deleted role: ${role[0].name}`, req.body?.user_name || 'System']
    );
    
    res.json({ message: 'Role deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── Section Access for Swap Permission ─────────────────────────────────

// GET /api/roles/:id/section-access — Get which sections this role can swap to
router.get('/:id/section-access', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT section FROM role_section_access WHERE role_id = ?',
      [req.params.id]
    );
    res.json(rows.map(r => r.section));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/roles/:id/section-access — Set which sections this role can swap to
router.put('/:id/section-access', requirePermission('roles.edit', 'channel_roles.edit'), async (req, res) => {
  try {
    const { sections } = req.body; // array of section names, e.g. ['VAS', 'INDIRECT_CHANNEL']
    const roleId = req.params.id;

    // Verify role exists
    const [role] = await pool.query('SELECT id, name, scope FROM roles WHERE id = ?', [roleId]);
    if (!role.length) return res.status(404).json({ error: 'Role not found' });

    // Section access decides which sections a role can reach, which is an
    // all-sections concern — it belongs to the master admin alone. The Roles UI
    // hides this control from everyone else; this is the enforcement behind it.
    if (!isMasterAdmin(req)) {
      return res.status(403).json({ error: 'Only a master admin can change section access' });
    }

    // Validate sections
    const validSections = ['VAS', 'INDIRECT_CHANNEL'];
    const invalidSections = (sections || []).filter(s => !validSections.includes(s));
    if (invalidSections.length > 0) {
      return res.status(400).json({ error: `Invalid sections: ${invalidSections.join(', ')}` });
    }

    // Must have at least one section if sections.swap is assigned
    const [swapPerm] = await pool.query(
      `SELECT rp.id FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ? AND p.name = 'sections.swap'`,
      [roleId]
    );
    if (swapPerm.length > 0 && (!sections || sections.length === 0)) {
      return res.status(400).json({ error: 'At least one section must be selected when sections.swap is assigned' });
    }

    // A newly granted section must come with at least one permission for that section,
    // otherwise the user swaps into it with nothing to do there. Sections the role
    // already had are left alone so legacy roles (e.g. Admin) stay editable.
    const [existingAccess] = await pool.query(
      'SELECT section FROM role_section_access WHERE role_id = ?',
      [roleId]
    );
    const existingSections = new Set(existingAccess.map(r => r.section));
    const newSections = (sections || []).filter(s => !existingSections.has(s));

    if (newSections.length > 0) {
      // permissions.section is the authoritative column for a permission's section
      const [sectionCounts] = await pool.query(
        'SELECT section, COUNT(*) as cnt FROM permissions GROUP BY section'
      );
      const definedPerSection = new Map(sectionCounts.map(r => [r.section, Number(r.cnt)]));

      const [roleCounts] = await pool.query(
        `SELECT p.section, COUNT(*) as cnt FROM role_permissions rp
         JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ?
         GROUP BY p.section`,
        [roleId]
      );
      const heldPerSection = new Map(roleCounts.map(r => [r.section, Number(r.cnt)]));

      for (const section of newSections) {
        if (!definedPerSection.get(section)) continue; // section defines no permissions
        if (!heldPerSection.get(section)) {
          return res.status(400).json({
            error: `At least one permission for ${section === 'INDIRECT_CHANNEL' ? 'Indirect Channel' : 'VAS Section'} must be assigned to this role before granting access to that section`,
          });
        }
      }
    }

    // Delete existing and re-insert
    await pool.query('DELETE FROM role_section_access WHERE role_id = ?', [roleId]);
    if (sections && sections.length > 0) {
      for (const section of sections) {
        await pool.query(
          'INSERT INTO role_section_access (role_id, section) VALUES (?, ?)',
          [roleId, section]
        );
      }
    }

    // Audit trail
    await pool.query(
      'INSERT INTO audit_trail (action, entity_type, entity_id, description, user_name) VALUES (?, ?, ?, ?, ?)',
      ['update', 'role', roleId, `Updated section access for role ${role[0].name}: ${(sections || []).join(', ') || 'none'}`, req.body?.user_name || 'System']
    );

    res.json({ message: 'Section access updated', sections: sections || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
