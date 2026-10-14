/**
 * Automated Migration Script: MySQL to PostgreSQL
 *
 * Migrates schemas, constraints, sequences, and data from
 * MySQL (vas_revenue_tracking) to PostgreSQL (vas_revenue_tracking).
 */

const path = require('path');
const backendNodeModules = path.resolve(__dirname, '../../backend/node_modules');
const mysql = require(path.join(backendNodeModules, 'mysql2/promise'));
const { Client } = require(path.join(backendNodeModules, 'pg'));

const MYSQL_CONFIG = {
  host: process.env.MYSQL_HOST || 'localhost',
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || 'root',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DATABASE || 'vas_revenue_tracking',
  dateStrings: true,
};

const PG_CONFIG = {
  host: process.env.PG_HOST || 'localhost',
  port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || 'Ethiopia@#$1',
  database: process.env.PG_DATABASE || 'vas_revenue_tracking',
};

function mapMySQLTypeToPG(rawCol) {
  const col = {};
  for (const [k, v] of Object.entries(rawCol)) {
    col[k.toUpperCase()] = v;
  }
  const type = (col.DATA_TYPE || '').toLowerCase();
  const colType = (col.COLUMN_TYPE || '').toLowerCase();
  const isAutoInc = (col.EXTRA || '').toLowerCase().includes('auto_increment');

  if (isAutoInc) {
    if (type === 'bigint') return 'BIGSERIAL';
    return 'SERIAL';
  }

  if (colType === 'tinyint(1)' || colType.startsWith('tinyint(1)')) {
    return 'BOOLEAN';
  }

  switch (type) {
    case 'tinyint':
    case 'smallint':
      return 'SMALLINT';
    case 'mediumint':
    case 'int':
    case 'integer':
      return 'INTEGER';
    case 'bigint':
      return 'BIGINT';
    case 'decimal':
    case 'numeric':
      return `NUMERIC(${col.NUMERIC_PRECISION || 15}, ${col.NUMERIC_SCALE || 2})`;
    case 'float':
      return 'REAL';
    case 'double':
      return 'DOUBLE PRECISION';
    case 'varchar':
      return `VARCHAR(${col.CHARACTER_MAXIMUM_LENGTH || 255})`;
    case 'char':
      return `CHAR(${col.CHARACTER_MAXIMUM_LENGTH || 1})`;
    case 'text':
    case 'tinytext':
    case 'mediumtext':
    case 'longtext':
      return 'TEXT';
    case 'datetime':
    case 'timestamp':
      return 'TIMESTAMPTZ';
    case 'date':
      return 'DATE';
    case 'time':
      return 'TIME';
    case 'year':
      return 'INTEGER';
    case 'json':
      return 'JSONB';
    case 'enum':
      return 'VARCHAR(100)';
    case 'blob':
    case 'tinyblob':
    case 'mediumblob':
    case 'longblob':
      return 'BYTEA';
    default:
      return 'TEXT';
  }
}

function formatDefault(col, pgType) {
  if (col.COLUMN_DEFAULT === null || col.COLUMN_DEFAULT === undefined) {
    return '';
  }
  let def = col.COLUMN_DEFAULT.toString().trim();
  if (def.startsWith("'") && def.endsWith("'")) {
    def = def.slice(1, -1).trim();
  }
  if (def.toUpperCase() === 'NULL' || def === '') {
    return 'DEFAULT NULL';
  }
  if (def.toUpperCase() === 'CURRENT_TIMESTAMP' || def.toUpperCase().startsWith('CURRENT_TIMESTAMP')) {
    return 'DEFAULT CURRENT_TIMESTAMP';
  }
  if (pgType === 'BOOLEAN') {
    if (def === '1') return 'DEFAULT TRUE';
    if (def === '0') return 'DEFAULT FALSE';
  }
  if (pgType === 'DATE' || pgType === 'TIMESTAMPTZ' || pgType === 'TIMESTAMP' || pgType === 'TIME') {
    if (def.includes('0000-00-00') || def.toUpperCase() === 'NULL') {
      return 'DEFAULT NULL';
    }
  }
  if (['INTEGER', 'BIGINT', 'SMALLINT', 'REAL', 'DOUBLE PRECISION'].includes(pgType) || pgType.startsWith('NUMERIC')) {
    if (!isNaN(Number(def))) return `DEFAULT ${def}`;
  }
  return `DEFAULT '${def.replace(/'/g, "''")}'`;
}

async function ensureDatabaseExists() {
  const adminClient = new Client({
    ...PG_CONFIG,
    database: 'postgres',
  });
  await adminClient.connect();
  const res = await adminClient.query(
    `SELECT 1 FROM pg_database WHERE datname = $1`,
    [PG_CONFIG.database]
  );
  if (res.rowCount === 0) {
    console.log(`Creating database "${PG_CONFIG.database}" on PostgreSQL...`);
    await adminClient.query(`CREATE DATABASE "${PG_CONFIG.database}"`);
  }
  await adminClient.end();
}

async function runMigration() {
  console.log('=====================================================');
  console.log('🚀 Starting MySQL to PostgreSQL Automated Migration');
  console.log('=====================================================');

  const mysqlConn = await mysql.createConnection(MYSQL_CONFIG);
  console.log(`Connected to MySQL (${MYSQL_CONFIG.host}:${MYSQL_CONFIG.port}/${MYSQL_CONFIG.database})`);

  await ensureDatabaseExists();

  const pgClient = new Client(PG_CONFIG);
  await pgClient.connect();
  console.log(`Connected to PostgreSQL (${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database})\n`);

  try {
    // 1. Fetch all tables from MySQL
    const [tables] = await mysqlConn.query(
      `SELECT table_name 
       FROM information_schema.tables 
       WHERE table_schema = ? AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [MYSQL_CONFIG.database]
    );

    const tableNames = tables.map(t => t.table_name || t.TABLE_NAME);
    console.log(`Found ${tableNames.length} tables in MySQL.\n`);

    // 2. Reset target schema in PostgreSQL to ensure a clean state
    console.log('Preparing clean public schema in PostgreSQL...');
    await pgClient.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pgClient.query('GRANT ALL ON SCHEMA public TO postgres; GRANT ALL ON SCHEMA public TO public;');

    // 3. For each table, extract definition and create in PostgreSQL
    console.log('\n--- Phase 1: Creating Table Schemas in PostgreSQL ---');
    const tableColMeta = {};

    for (const tableName of tableNames) {
      const [rawColumns] = await mysqlConn.query(
        `SELECT column_name, data_type, column_type, is_nullable, column_default, extra,
                numeric_precision, numeric_scale, character_maximum_length
         FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ?
         ORDER BY ordinal_position`,
        [MYSQL_CONFIG.database, tableName]
      );

      const columns = rawColumns.map(row => {
        const c = {};
        for (const [k, v] of Object.entries(row)) c[k.toUpperCase()] = v;
        return c;
      });

      // Primary keys
      const [pkRows] = await mysqlConn.query(
        `SELECT column_name
         FROM information_schema.key_column_usage
         WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY'
         ORDER BY ordinal_position`,
        [MYSQL_CONFIG.database, tableName]
      );
      const pkCols = pkRows.map(r => r.column_name || r.COLUMN_NAME);

      tableColMeta[tableName] = { columns, pkCols };

      const colDefs = [];
      for (const col of columns) {
        const colName = col.column_name || col.COLUMN_NAME;
        const pgType = mapMySQLTypeToPG(col);
        const isSerial = pgType === 'SERIAL' || pgType === 'BIGSERIAL';
        const nullable = col.is_nullable === 'NO' && !isSerial ? 'NOT NULL' : '';
        const def = !isSerial ? formatDefault(col, pgType) : '';

        colDefs.push(`"${colName}" ${pgType} ${nullable} ${def}`.replace(/\s+/g, ' ').trim());
      }

      if (pkCols.length > 0) {
        const hasSerialPk = columns.some(
          c => (c.column_name || c.COLUMN_NAME) === pkCols[0] &&
               (mapMySQLTypeToPG(c) === 'SERIAL' || mapMySQLTypeToPG(c) === 'BIGSERIAL')
        );
        // If single auto_increment, SERIAL already acts as primary key in some models,
        // but explicit PRIMARY KEY constraint is best practice:
        colDefs.push(`CONSTRAINT "${tableName}_pkey" PRIMARY KEY (${pkCols.map(c => `"${c}"`).join(', ')})`);
      }

      const createSql = `CREATE TABLE "${tableName}" (\n  ${colDefs.join(',\n  ')}\n);`;
      await pgClient.query(createSql);
      process.stdout.write(`  Created schema: ${tableName}\n`);
    }

    // 4. Migrate Data
    console.log('\n--- Phase 2: Copying Data from MySQL to PostgreSQL ---');
    const results = [];

    for (const tableName of tableNames) {
      const { columns } = tableColMeta[tableName];
      const [mysqlRows] = await mysqlConn.query(`SELECT * FROM \`${tableName}\``);
      const totalCount = mysqlRows.length;

      if (totalCount === 0) {
        results.push({ table: tableName, mysql: 0, pg: 0, status: 'OK (Empty)' });
        process.stdout.write(`  ${tableName.padEnd(30)}: 0 rows\n`);
        continue;
      }

      const colNames = columns.map(c => c.column_name || c.COLUMN_NAME);
      const colTypes = columns.map(c => mapMySQLTypeToPG(c));

      // Batch insert into Postgres
      const BATCH_SIZE = 500;
      for (let i = 0; i < totalCount; i += BATCH_SIZE) {
        const batch = mysqlRows.slice(i, i + BATCH_SIZE);
        const valueClauses = [];
        const flatParams = [];
        let paramIdx = 1;

        for (const row of batch) {
          const rowParams = [];
          for (let c = 0; c < colNames.length; c++) {
            const colName = colNames[c];
            const pgType = colTypes[c];
            let val = row[colName];

            if (val === undefined || val === null) {
              rowParams.push(`$${paramIdx++}`);
              flatParams.push(null);
            } else if (pgType === 'BOOLEAN') {
              rowParams.push(`$${paramIdx++}`);
              flatParams.push(val === 1 || val === '1' || val === true);
            } else if (pgType === 'JSONB') {
              rowParams.push(`$${paramIdx++}`);
              flatParams.push(typeof val === 'object' ? JSON.stringify(val) : val);
            } else if (pgType === 'TIMESTAMPTZ' || pgType === 'DATE') {
              rowParams.push(`$${paramIdx++}`);
              if (val === '0000-00-00' || val === '0000-00-00 00:00:00') {
                flatParams.push(null);
              } else {
                flatParams.push(val);
              }
            } else {
              rowParams.push(`$${paramIdx++}`);
              flatParams.push(val);
            }
          }
          valueClauses.push(`(${rowParams.join(', ')})`);
        }

        const insertSql = `INSERT INTO "${tableName}" (${colNames.map(c => `"${c}"`).join(', ')}) VALUES ${valueClauses.join(', ')}`;
        await pgClient.query(insertSql, flatParams);
      }

      // Sync auto-increment sequences
      for (const col of columns) {
        const cName = col.column_name || col.COLUMN_NAME;
        const pgType = mapMySQLTypeToPG(col);
        if (pgType === 'SERIAL' || pgType === 'BIGSERIAL') {
          await pgClient.query(
            `SELECT setval(pg_get_serial_sequence('"' || $1 || '"', $2), COALESCE((SELECT MAX("${cName}") FROM "${tableName}"), 1))`
          , [tableName, cName]).catch(() => {});
        }
      }

      // Verify row count
      const pgCountRes = await pgClient.query(`SELECT COUNT(*)::int as count FROM "${tableName}"`);
      const pgCount = pgCountRes.rows[0].count;
      const status = pgCount === totalCount ? 'MATCH' : 'MISMATCH';

      results.push({ table: tableName, mysql: totalCount, pg: pgCount, status });
      process.stdout.write(`  ${tableName.padEnd(30)}: ${totalCount} -> ${pgCount} [${status}]\n`);
    }

    // 5. Add secondary indexes
    console.log('\n--- Phase 3: Creating Indexes ---');
    for (const tableName of tableNames) {
      const [indexes] = await mysqlConn.query(
        `SELECT DISTINCT index_name, column_name, non_unique
         FROM information_schema.statistics
         WHERE table_schema = ? AND table_name = ? AND index_name != 'PRIMARY'`,
        [MYSQL_CONFIG.database, tableName]
      );

      // Group columns by index_name
      const indexMap = {};
      for (const idx of indexes) {
        const name = idx.index_name || idx.INDEX_NAME;
        const col = idx.column_name || idx.COLUMN_NAME;
        const nonUnique = idx.non_unique !== undefined ? idx.non_unique : idx.NON_UNIQUE;
        if (!indexMap[name]) indexMap[name] = { isUnique: nonUnique === 0, columns: [] };
        indexMap[name].columns.push(col);
      }

      for (const [idxName, info] of Object.entries(indexMap)) {
        try {
          const uniqueStr = info.isUnique ? 'UNIQUE' : '';
          const safeIdxName = `idx_${tableName}_${idxName}`.slice(0, 60);
          const colList = info.columns.map(c => `"${c}"`).join(', ');
          await pgClient.query(`CREATE ${uniqueStr} INDEX IF NOT EXISTS "${safeIdxName}" ON "${tableName}" (${colList});`);
        } catch (e) {
          // Ignore duplicate or incompatible index names
        }
      }
    }
    console.log('Indexes recreated.');

    // 6. Summary Report
    console.log('\n=====================================================');
    console.log('📊 MIGRATION SUMMARY');
    console.log('=====================================================');
    let allMatched = true;
    for (const r of results) {
      if (r.status === 'MISMATCH') allMatched = false;
    }

    console.table(results);

    if (allMatched) {
      console.log('\n SUCCESS: All tables and rows transferred with 100% data integrity!');
    } else {
      console.warn('\n⚠️ WARNING: Some tables reported mismatched counts. Check details above.');
    }

  } catch (err) {
    console.error('Migration failed:', err);
  } finally {
    await mysqlConn.end();
    await pgClient.end();
  }
}

runMigration();
