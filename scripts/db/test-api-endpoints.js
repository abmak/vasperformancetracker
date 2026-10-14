const jwt = require('../../backend/node_modules/jsonwebtoken');
require('../../backend/src/env');

const JWT_SECRET = process.env.JWT_SECRET || 'vas-revenue-tracker-secret-key-2026';

// Generate token for user id 1 (vasadmin)
const token = jwt.sign(
  {
    id: 1,
    username: 'vasadmin',
    role_id: 1,
    role_name: 'Super Admin',
  },
  JWT_SECRET,
  { expiresIn: '1h' }
);

async function testEndpoint(name, url) {
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await res.json();
    if (!res.ok) {
      console.error(`❌ ${name} FAILED (${res.status}):`, data);
      return false;
    }
    console.log(`✅ ${name} SUCCESS:`);
    if (Array.isArray(data)) {
      console.log(`   Returned array with ${data.length} items`);
      if (data.length > 0) console.log('   Sample:', data[0]);
    } else {
      console.log('   Summary fields:', Object.keys(data).slice(0, 8).join(', '));
      if (data.total_actual !== undefined) console.log('   total_actual:', data.total_actual, 'total_target:', data.total_target);
      if (data.grand_total !== undefined) console.log('   grand_total:', data.grand_total);
      if (data.summary) console.log('   summary:', data.summary);
    }
    return true;
  } catch (e) {
    console.error(`❌ ${name} ERROR:`, e.message);
    return false;
  }
}

async function run() {
  console.log('Testing live API endpoints with JWT authentication...\n');

  await testEndpoint('1. Dashboard KPIs', 'http://localhost:5000/api/dashboard/kpis?start_date=2026-07-01&end_date=2026-08-31');
  await testEndpoint('2. Dashboard Service Achievements', 'http://localhost:5000/api/dashboard/service-achievements?start_date=2026-07-01&end_date=2026-08-31');
  await testEndpoint('3. Dashboard MoM Growth', 'http://localhost:5000/api/dashboard/mom-growth?start_date=2026-07-01&end_date=2026-08-31');
  await testEndpoint('4. Partner Revenue Summary', 'http://localhost:5000/api/partners/summary?start_date=2026-07-01&end_date=2026-08-31');
  await testEndpoint('5. Partner Revenue List', 'http://localhost:5000/api/partners/partners?start_date=2026-07-01&end_date=2026-08-31&page=1&limit=10');
  await testEndpoint('6. Reports Performance', 'http://localhost:5000/api/reports/performance?start_date=2026-07-01&end_date=2026-08-31');
  await testEndpoint('7. Reports Monthly Trend', 'http://localhost:5000/api/reports/monthly-trend');

  process.exit(0);
}

run();
