/**
 * addGuidePermissions — ensures the User Guide permissions exist so they can be
 * configured on roles from the Roles page:
 *
 *   guide.view — see the User Guide page and its sidebar link
 *   guide.edit — edit the guide content (the in-place guide editor)
 *
 * Both are section SHARED, so a VAS role and an Indirect Channel role can
 * carry them alike. Defaults on first run:
 *   - every existing role gets guide.view (the guide was previously visible
 *     to everyone; reverting that silently would hide the link from users),
 *   - the GLOBAL (master admin) role also gets guide.edit.
 *
 *   node src/config/addGuidePermissions.js
 */
const mysql = require('mysql2/promise');
require('../env');

const PERMISSIONS = [
  { name: 'guide.view', description: 'View the User Guide page', module: 'guide', action: 'view', section: 'SHARED' },
  { name: 'guide.edit', description: 'Edit the User Guide content', module: 'guide', action: 'edit', section: 'SHARED' },
];

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
  });

  console.log('✅ Connected to database');

  let created = 0;
  const ids = {};
  for (const p of PERMISSIONS) {
    const [existing] = await conn.query('SELECT id FROM permissions WHERE name = ?', [p.name]);
    if (existing.length === 0) {
      const [result] = await conn.query(
        'INSERT INTO permissions (name, description, module, action, section) VALUES (?, ?, ?, ?, ?)',
        [p.name, p.description, p.module, p.action, p.section]
      );
      ids[p.name] = result.insertId;
      console.log(`✅ Created permission: ${p.name} (section: SHARED)`);
      created++;
    } else {
      ids[p.name] = existing[0].id;
      await conn.query(
        'UPDATE permissions SET section = ? WHERE name = ? AND (section IS NULL OR section != ?)',
        [p.section, p.name, p.section]
      );
      console.log(`ℹ️  Permission ${p.name} already exists (ensured section: SHARED)`);
    }
  }

  // Default grants so nobody loses the guide after this change:
  //  - every role can VIEW it (previous behaviour)
  //  - the GLOBAL role(s) can also EDIT it
  const [roles] = await conn.query('SELECT id, name, scope FROM roles');
  let grants = 0;
  for (const role of roles) {
    const wanted = role.scope === 'GLOBAL'
      ? ['guide.view', 'guide.edit']
      : ['guide.view'];
    for (const name of wanted) {
      const [rp] = await conn.query(
        'SELECT id FROM role_permissions WHERE role_id = ? AND permission_id = ?',
        [role.id, ids[name]]
      );
      if (rp.length === 0) {
        await conn.query(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
          [role.id, ids[name]]
        );
        grants++;
        console.log(`  ↳ granted ${name} to role "${role.name}" (${role.scope || 'no scope'})`);
      }
    }
  }

  await conn.end();
  console.log(`\n🎉 Done! Created ${created} permission(s), added ${grants} role grant(s).`);
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Failed:', err.message);
  process.exit(1);
});
