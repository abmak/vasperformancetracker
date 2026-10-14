const jwt = require('../../backend/node_modules/jsonwebtoken');
require('../../backend/src/env');

const JWT_SECRET = process.env.JWT_SECRET || 'vas-revenue-tracker-secret-key-2026';

const token = jwt.sign(
  { id: 1, username: 'vasadmin', role_id: 1, role_name: 'Super Admin' },
  JWT_SECRET,
  { expiresIn: '1h' }
);

async function testEndpoint(name, url) {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error(`❌ ${name} returned non-JSON (${res.status}):`, text.slice(0, 300));
      return false;
    }
    if (!res.ok) {
      console.error(`❌ ${name} FAILED (${res.status}):`, data);
      return false;
    }
    console.log(`✅ ${name} SUCCESS:`);
    if (Array.isArray(data)) {
      console.log(`   Array items: ${data.length}`);
      if (data.length > 0) console.log('   Sample:', data[0]);
    } else {
      console.log('   Keys:', Object.keys(data).slice(0, 8).join(', '));
      if (data.counts) console.log('   counts:', data.counts);
      if (data.total_balance !== undefined) console.log('   total_balance:', data.total_balance);
    }
    return true;
  } catch (e) {
    console.error(`❌ ${name} ERROR:`, e.message);
    return false;
  }
}

async function run() {
  console.log('Testing Action Notes, Chat, and IDC (Indirect Channel) endpoints...\n');

  // Action Notes
  await testEndpoint('1. Action Notes List', 'http://localhost:5000/api/actions');

  // Chat
  await testEndpoint('2. Chat Contacts', 'http://localhost:5000/api/chat/contacts');
  await testEndpoint('3. Chat Conversations', 'http://localhost:5000/api/chat/conversations?user_id=1');
  await testEndpoint('4. Chat Groups', 'http://localhost:5000/api/chat/groups?user_id=1');

  // IDC (Indirect Channel)
  await testEndpoint('5. IDC Meta', 'http://localhost:5000/api/channel/meta');
  await testEndpoint('6. IDC Dashboard KPIs', 'http://localhost:5000/api/channel/dashboard/kpis');
  await testEndpoint('7. IDC Dashboard Matrix', 'http://localhost:5000/api/channel/dashboard/matrix');
  await testEndpoint('8. IDC Dashboard Trend', 'http://localhost:5000/api/channel/dashboard/trend');
  await testEndpoint('9. IDC Top Distributors', 'http://localhost:5000/api/channel/dashboard/top-distributors');
  await testEndpoint('10. IDC Geo', 'http://localhost:5000/api/channel/dashboard/geo');
  await testEndpoint('11. IDC Entities List', 'http://localhost:5000/api/channel/entities?page=1&limit=20');
  await testEndpoint('12. IDC Level Report', 'http://localhost:5000/api/channel/reports/level?level=1');
  await testEndpoint('13. IDC Retailer Coverage', 'http://localhost:5000/api/channel/reports/retailer-coverage');

  process.exit(0);
}

run();
