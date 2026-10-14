const path = require('path');
const { Client } = require(path.resolve(__dirname, '../../backend/node_modules/pg'));
require('../../backend/src/env');

async function setup() {
  const c = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'Ethiopia@#$1',
    database: process.env.DB_NAME || 'vas_revenue_tracking',
  });
  await c.connect();
  console.log('Installing advanced MySQL compatibility in PostgreSQL...');

  // 1. CURDATE() and DATABASE()
  await c.query(`
    CREATE OR REPLACE FUNCTION curdate()
    RETURNS date LANGUAGE sql IMMUTABLE AS $$
      SELECT CURRENT_DATE;
    $$;

    CREATE OR REPLACE FUNCTION database()
    RETURNS text LANGUAGE sql IMMUTABLE AS $$
      SELECT current_database();
    $$;
  `);

  // 2. SUM(boolean) aggregate for MySQL-style SUM(status = 'active')
  await c.query(`
    CREATE OR REPLACE FUNCTION sum_boolean_state(state bigint, val boolean)
    RETURNS bigint LANGUAGE plpgsql IMMUTABLE AS $$
    BEGIN
      IF val IS TRUE THEN
        RETURN state + 1;
      ELSE
        RETURN state;
      END IF;
    END;
    $$;

    DROP AGGREGATE IF EXISTS sum(boolean);
    CREATE AGGREGATE sum(boolean) (
      SFUNC = sum_boolean_state,
      STYPE = bigint,
      INITCOND = '0'
    );
  `);

  // 3. Operators for boolean = integer, integer = boolean, boolean <> integer
  await c.query(`
    CREATE OR REPLACE FUNCTION bool_eq_int(b boolean, i integer)
    RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT (b IS TRUE AND i = 1) OR (b IS FALSE AND i = 0);
    $$;

    CREATE OR REPLACE FUNCTION int_eq_bool(i integer, b boolean)
    RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT (b IS TRUE AND i = 1) OR (b IS FALSE AND i = 0);
    $$;

    CREATE OR REPLACE FUNCTION bool_neq_int(b boolean, i integer)
    RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT NOT ((b IS TRUE AND i = 1) OR (b IS FALSE AND i = 0));
    $$;

    CREATE OR REPLACE FUNCTION int_neq_bool(i integer, b boolean)
    RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
      SELECT NOT ((b IS TRUE AND i = 1) OR (b IS FALSE AND i = 0));
    $$;

    DROP OPERATOR IF EXISTS = (boolean, integer) CASCADE;
    CREATE OPERATOR = (
      LEFTARG = boolean,
      RIGHTARG = integer,
      PROCEDURE = bool_eq_int,
      COMMUTATOR = =
    );

    DROP OPERATOR IF EXISTS = (integer, boolean) CASCADE;
    CREATE OPERATOR = (
      LEFTARG = integer,
      RIGHTARG = boolean,
      PROCEDURE = int_eq_bool,
      COMMUTATOR = =
    );

    DROP OPERATOR IF EXISTS <> (boolean, integer) CASCADE;
    CREATE OPERATOR <> (
      LEFTARG = boolean,
      RIGHTARG = integer,
      PROCEDURE = bool_neq_int
    );

    DROP OPERATOR IF EXISTS <> (integer, boolean) CASCADE;
    CREATE OPERATOR <> (
      LEFTARG = integer,
      RIGHTARG = boolean,
      PROCEDURE = int_neq_bool
    );

    DROP OPERATOR IF EXISTS != (boolean, integer) CASCADE;
    CREATE OPERATOR != (
      LEFTARG = boolean,
      RIGHTARG = integer,
      PROCEDURE = bool_neq_int
    );

    DROP OPERATOR IF EXISTS != (integer, boolean) CASCADE;
    CREATE OPERATOR != (
      LEFTARG = integer,
      RIGHTARG = boolean,
      PROCEDURE = int_neq_bool
    );
  `);

  // 4. Update built-in cast from integer to boolean to assignment ('a')
  try {
    await c.query(`
      UPDATE pg_cast
         SET castcontext = 'a'
       WHERE castsource = 'integer'::regtype
         AND casttarget = 'boolean'::regtype;
    `);
    console.log('Enabled assignment cast (integer AS boolean)');
  } catch (e) {
    console.warn('Cast update note:', e.message);
  }

  // 5. Update built-in cast from boolean to integer to assignment ('a')
  try {
    await c.query(`
      UPDATE pg_cast
         SET castcontext = 'a'
       WHERE castsource = 'boolean'::regtype
         AND casttarget = 'integer'::regtype;
    `);
    console.log('Enabled assignment cast (boolean AS integer)');
  } catch (e) {
    console.warn('Cast update note:', e.message);
  }

  console.log('✅ Advanced compatibility layer installed successfully!');
  await c.end();
}

setup().catch(console.error);
