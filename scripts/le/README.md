# Let's Encrypt IP certificate — renewal system

The app runs at **`https://196.189.155.179:5000`** on a **genuine,
browser-trusted Let's Encrypt certificate for the bare IP** (LE has issued
short-lived IP certificates since 2026-01-15). Port 5000 is TLS-terminated by
the `vas-https` pm2 process (Node proxy, `~/vas-https-proxy.js`) which
forwards to the Express app on 127.0.0.1:5001; plain HTTP no longer reaches
the app. Visitors landing on ports 80/443 are redirected there by nginx.

## How it works

The VPS has no outbound internet, so the ACME protocol is driven from **this
PC** (`scripts/le/renew.js`, uses `acme-client` + your SSH key):

1. ACME account + order for identifier `ip:196.189.155.179`, profile `shortlived`
2. HTTP-01 challenge file is pushed over SSH into
   `/var/www/performancetracking/app/backend/acme-challenges/`
3. Let's Encrypt fetches it via `http://196.189.155.179/.well-known/acme-challenge/…`
   — nginx (patched once, `~/acme-nginx-setup.sh` on the VPS) proxies that
   path to the Express app, which serves the folder (`server.js` route)
4. Certificate downloaded, pushed to the VPS, installed into `~/vas-tls/`,
   `pm2 restart vas-https`

## Automation

Task Scheduler task **"LE IP Cert Renewal"** runs `renew-task.cmd` **daily at
08:00**. The script skips itself while the installed cert has more than 4 days
of validity left (LE IP certs live ~6.5 days). Log: `scripts/le/renew.log`.

If the PC is off for several days and the cert lapses, just run:

```
cd scripts/le && node renew.js
```

## Files

- `renew.js` — the whole flow; `--staging` uses the LE staging CA (rate-limit
  friendly testing); state (account key, issued certs) in `state/`
- `renew-task.cmd` — Task Scheduler wrapper
- VPS side: `~/vas-tls/` (live cert, read by `vas-https` pm2 process),
  `~/vas-tls-le/` (last issued LE cert), `~/acme-nginx-setup.sh` (idempotent
  nginx patch, already applied — backup at
  `/etc/nginx/sites-available/vas-ip-redirect.conf.bak-acme`)
- Port layout: nginx 80/443 → redirect to `https://196.189.155.179:5000`;
  `vas-https` listens 0.0.0.0:5000 (TLS, LE cert) → Express on 127.0.0.1:5001
  (`.env.production` carries `PORT=5001`)

## Notes

- The certificate has `subjectAltName: IP:196.189.155.179` marked **critical**
  (LE requirement for short-lived profiles) and an empty subject — both normal.
- The old self-signed cert in `~/vas-tls` was replaced. If renewal ever lapses,
  browsers fall back to an untrusted warning — not worse than before, but
  renew promptly.
- Keep the **account key** (`state/account.key`) with the repo backup; losing
  it only means LE creates a fresh account next run (harmless, but clean).
