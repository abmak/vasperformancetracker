const path = require('path');
require('../../backend/src/env');
const { Client } = require(path.resolve(__dirname, '../../backend/node_modules/pg'));

async function setup() {
  const c = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'Ethiopia@#$1',
    database: process.env.DB_NAME || 'vas_revenue_tracking',
  });
  await c.connect();
  console.log('Connected to PostgreSQL for compatibility functions setup...');

  // 1. GROUP_CONCAT support
  await c.query(`
    CREATE OR REPLACE FUNCTION group_concat_state(state text, val text)
    RETURNS text LANGUAGE plpgsql AS $$
    BEGIN
      IF state IS NULL OR state = '' THEN
        RETURN val;
      ELSIF val IS NULL THEN
        RETURN state;
      ELSE
        RETURN state || ',' || val;
      END IF;
    END;
    $$;
  `);

  await c.query(`
    DROP AGGREGATE IF EXISTS GROUP_CONCAT(text);
    CREATE AGGREGATE GROUP_CONCAT(text) (
      SFUNC = group_concat_state,
      STYPE = text
    );
  `);

  await c.query(`
    DROP AGGREGATE IF EXISTS GROUP_CONCAT(character varying);
    CREATE AGGREGATE GROUP_CONCAT(character varying) (
      SFUNC = group_concat_state,
      STYPE = text
    );
  `);

  // 2. DATE_SUB support
  await c.query(`
    CREATE OR REPLACE FUNCTION date_sub(dt timestamptz, iv interval)
    RETURNS timestamptz LANGUAGE sql AS $$
      SELECT dt - iv;
    $$;
  `);

  // 3. DATE_FORMAT support (converts MySQL date format specifiers to PostgreSQL)
  await c.query(`
    CREATE OR REPLACE FUNCTION date_format(val timestamptz, fmt text)
    RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE
      res text := fmt;
    BEGIN
      IF val IS NULL THEN RETURN NULL; END IF;
      res := replace(res, '%Y', to_char(val, 'YYYY'));
      res := replace(res, '%y', to_char(val, 'YY'));
      res := replace(res, '%m', to_char(val, 'MM'));
      res := replace(res, '%c', to_char(val, 'FMMM'));
      res := replace(res, '%d', to_char(val, 'DD'));
      res := replace(res, '%e', to_char(val, 'FMDD'));
      res := replace(res, '%H', to_char(val, 'HH24'));
      res := replace(res, '%h', to_char(val, 'HH12'));
      res := replace(res, '%i', to_char(val, 'MI'));
      res := replace(res, '%s', to_char(val, 'SS'));
      res := replace(res, '%S', to_char(val, 'SS'));
      res := replace(res, '%p', to_char(val, 'AM'));
      RETURN res;
    END;
    $$;

    CREATE OR REPLACE FUNCTION date_format(val timestamp, fmt text)
    RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT date_format(val::timestamptz, fmt);
    $$;

    CREATE OR REPLACE FUNCTION date_format(val date, fmt text)
    RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT date_format(val::timestamptz, fmt);
    $$;

    CREATE OR REPLACE FUNCTION date_format(val text, fmt text)
    RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE 
        WHEN val IS NULL OR val = '' THEN NULL 
        ELSE date_format(val::timestamptz, fmt) 
      END;
    $$;
  `);

  // 4. SUBSTRING_INDEX support
  await c.query(`
    CREATE OR REPLACE FUNCTION substring_index(str text, delim text, count integer)
    RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE
      arr text[];
      len integer;
    BEGIN
      IF str IS NULL THEN RETURN NULL; END IF;
      IF count = 0 THEN RETURN ''; END IF;
      arr := string_to_array(str, delim);
      len := array_length(arr, 1);
      IF len IS NULL THEN RETURN str; END IF;
      IF count > 0 THEN
        IF count > len THEN RETURN str; END IF;
        RETURN array_to_string(arr[1:count], delim);
      ELSE
        IF abs(count) > len THEN RETURN str; END IF;
        RETURN array_to_string(arr[len + count + 1 : len], delim);
      END IF;
    END;
    $$;
  `);

  // 3. Ensure unique constraint on user_sections (user_id, section) if not present
  try {
    await c.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_user_sections_user_section 
      ON user_sections (user_id, section);
    `);
  } catch (e) {
    // index already exists or table structure handles it
  }

  console.log('✅ PostgreSQL compatibility functions installed successfully!');
  await c.end();
}

setup().catch(console.error);
