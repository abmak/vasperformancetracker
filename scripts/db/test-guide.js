const jwt = require('../../backend/node_modules/jsonwebtoken');
require('../../backend/src/env');

const token = jwt.sign(
  { id: 1, username: 'vasadmin', role_id: 1, role_name: 'Super Admin', role_scope: 'GLOBAL' },
  process.env.JWT_SECRET || 'vas-revenue-tracker-secret-key-2026'
);

async function testGuide() {
  console.log('Testing User Guide endpoints...');
  const sections = ['VAS', 'INDIRECT_CHANNEL'];

  for (const s of sections) {
    const res = await fetch(`http://localhost:5000/api/guide/${s}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log(`GET /api/guide/${s} -> status ${res.status}`);
    const data = await res.json();
    if (!res.ok) {
      console.error(`❌ Failed:`, data);
      process.exit(1);
    }
    console.log(`✅ ${s} Guide loaded! Content length: ${data.content?.length} chars, is_default: ${data.is_default}`);
  }

  process.exit(0);
}

testGuide().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
