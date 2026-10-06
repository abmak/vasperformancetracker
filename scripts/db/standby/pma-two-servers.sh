#!/usr/bin/env bash
# Adds the standby (127.0.0.1:3307) as a second selectable server in
# phpMyAdmin on the VPS. Idempotent — safe to re-run.
set -euo pipefail

PMA_DIR="/home/feveneyasu/apps/phpmyadmin"
PMA_CFG="$PMA_DIR/config.inc.php"
[ -f "$PMA_CFG" ] || { echo "ERROR: $PMA_CFG not found"; exit 1; }

if grep -q "Standby (3307)" "$PMA_CFG"; then
  echo "phpMyAdmin already lists both servers — nothing to do"
  exit 0
fi

cp "$PMA_CFG" "$PMA_CFG.pre-standby.bak"
echo "backup: $PMA_CFG.pre-standby.bak"

# Preserve the existing blowfish_secret and TempDir from the old config.
OLD_SECRET="$(sed -n "s/^\$cfg\['blowfish_secret'\] = '\([^']*\)'.*/\1/p" "$PMA_CFG")"
OLD_SECRET="${OLD_SECRET:-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
OLD_TMPDIR="$(sed -n "s/^\$cfg\['TempDir'\] = '\([^']*\)'.*/\1/p" "$PMA_CFG")"
OLD_TMPDIR="${OLD_TMPDIR:-$PMA_DIR/tmp}"

cat > "$PMA_CFG" <<PMAEOF
<?php
declare(strict_types=1);
\$cfg['blowfish_secret'] = '${OLD_SECRET}';
\$i = 0;
\$i++;
\$cfg['Servers'][\$i]['verbose'] = 'Primary (3306)';
\$cfg['Servers'][\$i]['auth_type'] = 'cookie';
\$cfg['Servers'][\$i]['host'] = '127.0.0.1';
\$cfg['Servers'][\$i]['port'] = '3306';
\$cfg['Servers'][\$i]['compress'] = false;
\$cfg['Servers'][\$i]['AllowNoPassword'] = false;
\$i++;
\$cfg['Servers'][\$i]['verbose'] = 'Standby (3307)';
\$cfg['Servers'][\$i]['auth_type'] = 'cookie';
\$cfg['Servers'][\$i]['host'] = '127.0.0.1';
\$cfg['Servers'][\$i]['port'] = '3307';
\$cfg['Servers'][\$i]['compress'] = false;
\$cfg['Servers'][\$i]['AllowNoPassword'] = false;
\$cfg['AllowArbitraryServer'] = false;
\$cfg['LoginCookieValidity'] = 3600;
\$cfg['TempDir'] = '${OLD_TMPDIR}';
\$cfg['ShowPhpInfo'] = false;
PMAEOF

echo "written. verifying PHP syntax…"
if command -v php >/dev/null && php -l "$PMA_CFG"; then
  echo "OK — phpMyAdmin now lists Primary (3306) and Standby (3307)"
else
  echo "php lint failed — restoring backup"
  cp "$PMA_CFG.pre-standby.bak" "$PMA_CFG"
  exit 1
fi
