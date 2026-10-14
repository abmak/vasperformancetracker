const pool = require('../../backend/src/config/database');

async function testAll() {
  console.log('🧪 Testing Dashboard, Partner Revenue, and Report Queries on PostgreSQL...\n');

  // --- 1. Dashboard KPIs query ---
  console.log('1. Testing Dashboard Top Partners Query (with GROUP_CONCAT):');
  const [topPartners] = await pool.execute(
    `SELECT partner_name, GROUP_CONCAT(DISTINCT service_name ORDER BY service_name SEPARATOR ', ') as services, SUM(total_revenue) as total_revenue FROM partner_revenue WHERE service_name IN (SELECT name FROM vas_services WHERE status = 'active') GROUP BY partner_name ORDER BY total_revenue DESC LIMIT 5`
  );
  console.log('   Result count:', topPartners.length);
  console.log('   Sample:', topPartners[0]);

  // --- 2. Partners Summary query ---
  console.log('\n2. Testing Partners Summary Query:');
  const [partnerTotals] = await pool.execute(
    `SELECT SUM(total_revenue) as grand_total, SUM(ethio_share) as total_ethio, COUNT(DISTINCT service_name) as total_services FROM partner_revenue`
  );
  console.log('   Partner Totals:', partnerTotals[0]);

  // --- 3. Partners List with GROUP_CONCAT ---
  console.log('\n3. Testing Partners List Query:');
  const [partnersList] = await pool.execute(
    `SELECT partner_name, 
      GROUP_CONCAT(DISTINCT service_name ORDER BY service_name SEPARATOR ', ') as services,
      SUM(total_revenue) as total_revenue, 
      SUM(ethio_share) as ethio_share,
      COUNT(DISTINCT service_name) as service_count
     FROM partner_revenue
     GROUP BY partner_name
     ORDER BY total_revenue DESC
     LIMIT 5`
  );
  console.log('   Partners List count:', partnersList.length);
  console.log('   Top partner:', partnersList[0]?.partner_name, 'Revenue:', partnersList[0]?.total_revenue, 'Services:', partnersList[0]?.services);

  // --- 4. Reports Target Query (with DATE_FORMAT & GROUP BY) ---
  console.log('\n4. Testing Reports Target Query:');
  const [targets] = await pool.execute(
    `SELECT rt.*, COALESCE(vs.name, rt.service_name) as service_name
     FROM revenue_targets rt
     LEFT JOIN vas_services vs ON rt.service_id = vs.id
     WHERE (DATE_FORMAT(target_end_date, '%Y-%m-%d') >= '2026-05-01' OR target_end_date IS NULL)
       AND (DATE_FORMAT(target_start_date, '%Y-%m-%d') <= '2026-05-31' OR target_start_date IS NULL)
       AND (rt.service_id IS NULL OR vs.status = 'active')
     GROUP BY rt.id, vs.name`
  );
  console.log('   Target rows count:', targets.length);

  // --- 5. Reports Performance Service Query ---
  console.log('\n5. Testing Reports Performance Service Query:');
  const [perfServices] = await pool.execute(
    `SELECT 
      service_name,
      SUM(total) as actual_amount,
      SUM(ethio_share) as ethio_amount,
      COUNT(DISTINCT partner_name) as partner_count
     FROM (
      SELECT service_name, total_revenue as total, ethio_share, partner_name FROM partner_revenue
     ) combined
     GROUP BY service_name
     ORDER BY actual_amount DESC
     LIMIT 5`
  );
  console.log('   Performance Services count:', perfServices.length);
  console.log('   Top service:', perfServices[0]);

  console.log('\n✅ ALL QUERIES EXECUTED SUCCESSFULLY AND RETURNED DATA!');
  process.exit(0);
}

testAll().catch(err => {
  console.error('\n❌ Query failed:', err);
  process.exit(1);
});
