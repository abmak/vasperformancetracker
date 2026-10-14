const path = require('path');
const { Client } = require(path.resolve(__dirname, '../../backend/node_modules/pg'));

async function check() {
  const c = new Client({
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    password: 'Ethiopia@#$1',
    database: 'vas_revenue_tracking',
  });
  await c.connect();
  console.log('Connected to:', c.database);

  const dbRes = await c.query('SELECT current_database(), current_schema(), inet_server_addr(), inet_server_port()');
  console.log('Current connection info:', dbRes.rows[0]);

  const tablesRes = await c.query(
    `SELECT table_schema, table_name 
     FROM information_schema.tables 
     WHERE table_schema NOT IN ('information_schema', 'pg_catalog') 
     ORDER BY table_schema, table_name`
  );
  console.log(`Found ${tablesRes.rows.length} tables:`);
  for (const row of tablesRes.rows) {
    console.log(`  ${row.table_schema}.${row.table_name}`);
  }

  const pubTables = await c.query(
    `SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename LIMIT 10`
  );
  console.log(`pg_tables in 'public':`, pubTables.rows);

  // Grant all permissions on all tables to public and postgres
  await c.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres;`);
  await c.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO public;`);
  await c.query(`GRANT ALL ON SCHEMA public TO postgres;`);
  await c.query(`GRANT ALL ON SCHEMA public TO public;`);

  await c.end();
}

check().catch(console.error);
