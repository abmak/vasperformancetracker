const db = require('../../backend/src/config/database');
const { defaultGuide } = require('../../backend/src/config/guideDefaults');

async function restore() {
  const content = defaultGuide('VAS');
  await db.query(
    `INSERT INTO guide_content (section, content, updated_by, updated_at) 
     VALUES ('VAS', ?, 'system default', CURRENT_TIMESTAMP)
     ON CONFLICT (section) DO UPDATE SET content = EXCLUDED.content, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
    [content]
  );
  console.log('✅ Restored VAS User Guide to full default content! Length:', content.length);
  process.exit(0);
}

restore().catch(err => {
  console.error('Error restoring VAS guide:', err);
  process.exit(1);
});
