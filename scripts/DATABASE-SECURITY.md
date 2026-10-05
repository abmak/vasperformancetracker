# Database Access & Security — phpMyAdmin on Production (status + runbook)

Prod: MySQL 8.0.46 @ `196.189.155.179` (Ubuntu 22.04), schema `vas_revenue_tracking`,
app user `vas_user` (creds in `/var/www/performancetracking/app/backend/.env.production`).
Server has **no root SSH access and no outbound route to apt archives** — phpMyAdmin
was therefore deployed userland-only (no packages installed, no nginx changes).

## 1. How to use phpMyAdmin (the daily flow)

phpMyAdmin 5.2.2 runs on the VPS at **127.0.0.1:8081 only** (pm2 process `phpmyadmin`,
auto-restarts via `pm2 save`d list). It is **not reachable from the internet** (verified
from outside). You reach it through an SSH tunnel:

```bash
# on your Windows machine (Git Bash / PowerShell):
ssh -i ~/.ssh/id_rsa_feveneyasu -N -L 8081:127.0.0.1:8081 feveneyasu@196.189.155.179
# leave that window open, then browse:  http://127.0.0.1:8081
```

- Log in with the **app credentials**: user `vas_user`, password from
  `backend/.env.production` (`DB_PASSWORD`). Full access to `vas_revenue_tracking`.
- Stop tunnel = close the SSH window (nothing stays open behind you).
- Server-side pieces (user `feveneyasu` on the VPS):
  - `~/apps/phpmyadmin/` — the app + hardened `config.inc.php`
    (`AllowArbitraryServer=false`, 1h cookie, fixed host `127.0.0.1`)
  - `~/apps/pma-server.sh` — launcher (PHPRC ini with portable `mbstring.so`,
    `LD_LIBRARY_PATH`, 4 workers, 64MB upload limit)
  - `pm2 restart phpmyadmin` if it ever stops; logs: `pm2 logs phpmyadmin`
- Caveat: if you ever get logged out instantly, that's the 1h cookie validity by design.

## 2. What was audited & fixed (2026-09-30)

| Item | Result |
|---|---|
| MySQL bind address | ✅ Already loopback-only: `bind-address=127.0.0.1`, `mysqlx-bind-address=127.0.0.1` in `/etc/mysql/mysql.conf.d/mysqld.cnf` |
| 3306 from internet | ✅ Filtered (probed from outside) |
| App DB user scope | ✅ `vas_user@127.0.0.1` = `ALL` on `vas_revenue_tracking.*` only, `USAGE` globally |
| `.env.production` perms | ✅ `600`, owner `feveneyasu` |
| JWT_SECRET | ✅ Present, 64 chars (not the code default) |
| phpMyAdmin exposure | ✅ Loopback-only pm2 process; 8081 confirmed closed from internet; no nginx changes made |
| **Nightly DB backups** | ✅ **NEW**: crontab dumps `vas_revenue_tracking` 02:15 daily to `~/backups/vas-YYYY-MM-DD.sql.gz`, 14-day rotation; tested 2.1MB valid dump |
| Dump credentials | ✅ **NEW**: `~/.my.cnf` (chmod 600) so cron dumps run passwordless |
| Deploy artifacts | ✅ Removed; tarball/deb checksums verified (SHA-256) before use |

## 2a. Bare-IP redirect to the app (installed 2026-09-30)

Visitors to `http(s)://196.189.155.179` are 302-redirected to
`http://196.189.155.179:5000` (path preserved) via two nginx blocks:
`/etc/nginx/sites-available/vas-ip-redirect{,-443}.conf` (symlinked in
`sites-enabled`). The 443 block uses a self-signed cert at
`/etc/nginx/vas-ip-cert/` (CN/SAN = the IP; browsers show a one-time warning —
normal for bare IPs). Named sites (jobsethiopia.et, LibLeLeb) match their own
server blocks first and are unaffected. Staged copies remain in `~/vas-ip-*`.
**Remove anytime:** `sudo rm /etc/nginx/sites-enabled/vas-ip-redirect* && sudo nginx -t && sudo systemctl reload nginx`.

## 2b. Sharing access with colleagues (as of 2026-09-30)

Per-person **tunnel-only** SSH keys are generated admin-side and installed on the
VPS with: `no-pty,no-X11-forwarding,no-agent-forwarding,permitopen="127.0.0.1:8081",command="echo tunnel-only-access"`.
(Do NOT use the single `restrict` option on this OpenSSH build — it blocks even
permitted forwarding; use the granular list above.) Recipient kit + instructions:
`scripts/pma-handover/` (gitignored — contains the private key).

- **Revoke one person:** delete their line in `~/.ssh/authorized_keys` (match the
  key comment, e.g. `pma-tunnel-colleague-20260930`). Takes effect immediately.
- **DB login for colleagues:** share `vas_user` credentials only verbally/via
  password manager — or better, ask for a least-privilege `pma_app` user
  (SELECT/INSERT/UPDATE/DELETE only) so data-editing is possible but DDL is not.
- Note: an earlier `-W 127.0.0.1:8081` stdio-forward test passed after the fix,
  and a tunnel to MySQL 3306 was verified refused.

## 3. Remaining recommendations (need your VPS sudo password, not yet applied)

1. **Full MySQL account audit** — one-time, as root:
   `sudo mysql < scripts/vps-db-audit.sql` (file is in this repo). Confirms there are
   no `'user'@'%'` wildcard or empty-password accounts. Delete this file after use.
2. **SSH hardening** — `PasswordAuthentication no` in `/etc/ssh/sshd_config.d/` +
   `fail2ban` install. (Key-only auth already used in practice; lock the door formally.)
3. **ufw** — if enabled, allow only `OpenSSH, 80, 443`. ⚠️ Do this from the provider
   console the first time, and note ports 3000/3001/8181 also serve other apps directly
   (Node binds all interfaces) — coordinate before firewalling them.
4. **Optional least-privilege browser user** — create `pma_app@localhost` with only
   `SELECT,INSERT,UPDATE,DELETE` on the schema for day-to-day phpMyAdmin browsing;
   keep `vas_user` for DDL/structure work. Say the word and I'll add it (needs SSH only).
5. **Port 5000 is your app's front door over plain HTTP** — future hardening: put it
   behind nginx with TLS (like the other two apps) so credentials aren't cleartext.
6. Rotate `vas_user` password periodically: `ALTER USER 'vas_user'@'127.0.0.1'
   IDENTIFIED BY '…'` + update `.env.production` + `pm2 restart perf-tracking-api`
   + update `~/.my.cnf`.

## 4. Rollback / removal of phpMyAdmin

```bash
ssh -i ~/.ssh/id_rsa_feveneyasu feveneyasu@196.189.155.179
pm2 delete phpmyadmin && pm2 save
rm -rf ~/apps/phpmyadmin ~/apps/pma-server.sh ~/apps/php-custom ~/apps/php-lib \
       ~/apps/php-extract-mb ~/apps/php-extract-onig
```
