-- ============================================================================
-- READ-ONLY AUDIT of production MySQL access (vas_revenue_tracking @ VPS)
-- Run:  mysql < vps-db-audit.sql      (as root via sudo mysql, or as vas_user
--       for the parts it can see — SHOW GRANTS works for CURRENT_USER always)
-- No changes are made by this file.
-- ============================================================================

SELECT '=== 1. MySQL accounts and host exposure ===' AS '';
SELECT user, host,
       plugin,
       IF(password_last_changed = '0000-00-00 00:00:00','never',password_last_changed) AS password_last_changed
FROM mysql.user
ORDER BY user, host;

SELECT '=== 2. Accounts reachable from ANY host (0.0.0.0 / %) ===' AS '';
SELECT user, host, plugin FROM mysql.user WHERE host IN ('%', '0.0.0.0', '::');

SELECT '=== 3. Accounts with empty password ===' AS '';
SELECT user, host FROM mysql.user WHERE authentication_string = '' AND plugin NOT LIKE 'sha256%';
-- (auth_socket accounts are OS-root-only and are fine)

SELECT '=== 4. Grants per account ===' AS '';
SELECT 'root' AS who; SHOW GRANTS FOR 'root'@'localhost';
SELECT 'vas_user@localhost' AS who; SHOW GRANTS FOR 'vas_user'@'localhost';

SELECT '=== 5. Network exposure ===' AS '';
SHOW VARIABLES WHERE Variable_name IN ('bind_address','skip_networking','have_ssl','have_openssl','ssl_ca');
SHOW VARIABLES LIKE 'mysqlx_bind_address';

SELECT '=== 6. Databases present ===' AS '';
SHOW DATABASES;

SELECT '=== 7. vas_revenue_tracking table count (expect 44) ===' AS '';
SELECT COUNT(*) AS tables_in_app FROM information_schema.tables WHERE table_schema='vas_revenue_tracking';

SELECT '=== 8. Who has privileges on the app schema ===' AS '';
SELECT grantee, privilege_type
FROM information_schema.schema_privileges
WHERE table_schema='vas_revenue_tracking'
ORDER BY grantee, privilege_type;
