#!/usr/bin/env node
/**
 * Let's Encrypt short-lived TLS certificate for the VPS public IP.
 *
 * Why this lives on the operator PC and not the VPS: the VPS has no outbound
 * internet, so it can never talk to the ACME API. This machine runs the whole
 * ACME flow (account, order, challenge, finalize, download) and pushes two
 * files to the VPS over SSH; the VPS answers the HTTP-01 validation through
 * its existing nginx -> Express path and swaps the certificate live.
 *
 * Usage:
 *   node renew.js                # production certificate
 *   node renew.js --staging      # Let's Encrypt staging (rate-limit friendly)
 *   node renew.js --dry-run      # staging + validate everything, install nothing
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const acme = require('acme-client');

// ── Configuration ────────────────────────────────────────────────────────────
const PUBLIC_IP = '196.189.155.179';
const SSH_USER = 'feveneyasu';
const SSH_KEY = path.join(os.homedir(), '.ssh', 'id_rsa_feveneyasu');
const SSH_HOST = `${SSH_USER}@${PUBLIC_IP}`;
const SSH_OPTS = ['-i', SSH_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];

// The certificate identifies the bare IP; the SAN must be the IP literal.
const IDENTIFIER = { type: 'ip', value: PUBLIC_IP };

// LE short-lived profile (~160h) — the only profile LE issues for IPs.
// On staging the profile name is identical; we pass it on every newOrder.
const ACME_PROFILE = 'shortlived';

// Local state — the ACME account key is precious: losing it just means LE
// creates a fresh account next run (harmless), but keep it anyway.
const STATE_DIR = path.join(__dirname, 'state');
const ACCOUNT_KEY_PATH = path.join(STATE_DIR, 'account.key');

// Remote paths (owned by feveneyasu; vas-https reads them directly).
const REMOTE_TLS_DIR = '/home/feveneyasu/vas-tls-le';

const args = process.argv.slice(2);
const STAGING = args.includes('--staging') || args.includes('--dry-run');
const DRY_RUN = args.includes('--dry-run');

const directoryUrl = STAGING
  ? acme.directory.letsencrypt.staging
  : acme.directory.letsencrypt.production;

function sshRemote(cmd, opts = {}) {
  return execFileSync('ssh', [...SSH_OPTS, `${SSH_HOST}`, cmd], {
    encoding: 'utf8',
    stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
    timeout: 120000,
  });
}

function scpPush(localPath, remotePath) {
  execFileSync('scp', ['-i', SSH_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', localPath, `${SSH_HOST}:${remotePath}`], {
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 120000,
  });
}

const log = (...m) => console.log(new Date().toISOString(), ...m);

async function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(path.join(STATE_DIR, 'out'), { recursive: true });

  // ── 0. Skip when the installed certificate is still fresh ─────────────────
  // The certificate lives ~6.5 days; renew only when fewer than 4 remain.
  // This makes a daily scheduled task safe and idempotent.
  try {
    const enddate = sshRemote(
      "openssl x509 -in ~/vas-tls/cert.pem -noout -enddate 2>/dev/null",
      { quiet: true }
    ).trim();
    const m = /notAfter=(.*)$/.exec(enddate);
    if (m) {
      const daysLeft = (new Date(m[1]) - new Date()) / 86400000;
      if (enddate.includes('notAfter') && daysLeft > 4) {
        log(`installed cert still fresh (${daysLeft.toFixed(1)} days left) — nothing to do`);
        return;
      }
      log(`installed cert expires in ${daysLeft.toFixed(1)} days — renewing`);
    }
  } catch { /* first run, no cert installed yet — proceed */ }

  // ── 1. ACME account ────────────────────────────────────────────────────────
  if (!fs.existsSync(ACCOUNT_KEY_PATH)) {
    fs.writeFileSync(ACCOUNT_KEY_PATH, await acme.forge.createPrivateKey());
  }
  const client = new acme.Client({
    directoryUrl,
    accountKey: fs.readFileSync(ACCOUNT_KEY_PATH),
    backoffPersist: path.join(STATE_DIR, 'backoff.json'),
  });
  await client.createAccount({ termsOfServiceAgreed: true, onlyReturnExisting: false });
  log(`ACME account ready (${STAGING ? 'STAGING' : 'PRODUCTION'})`);

  // ── 2. Order with the shortlived profile ──────────────────────────────────
  const order = await client.createOrder({
    identifiers: [IDENTIFIER],
    profile: ACME_PROFILE,
  });
  log('order created:', order.url || '(url hidden)');

  // ── 3. HTTP-01 challenge: authorizations → push token files to the VPS ────
  const authorizations = await client.getAuthorizations(order);
  const challengeFiles = [];

  for (const authz of authorizations) {
    const challenge = authz.challenges.find((c) => c.type === 'http-01');
    if (!challenge) throw new Error(`no http-01 challenge offered for ${authz.identifier.value}`);
    const keyAuthorization = await client.getChallengeKeyAuthorization(challenge);
    const fileName = challenge.token;

    // The VPS answers /.well-known/acme-challenge/<token> from the backend's
    // acme-challenges folder — write the file there over SSH.
    const remoteTmp = `/tmp/acme-${fileName}`;
    fs.writeFileSync(path.join(STATE_DIR, 'out', fileName), keyAuthorization);
    scpPush(path.join(STATE_DIR, 'out', fileName), remoteTmp);
    sshRemote(
      `mv /tmp/acme-${fileName} /var/www/performancetracking/app/backend/acme-challenges/${fileName} && chmod 644 /var/www/performancetracking/app/backend/acme-challenges/${fileName}`
    );
    challengeFiles.push(fileName);
    log(`challenge file staged: ${fileName} (${keyAuthorization.length} bytes)`);
  }

  // Pre-flight: fetch one challenge through the real public path. If nginx
  // still redirects instead of proxying, this fails fast with a clear reason.
  const firstToken = challengeFiles[0];
  const probe = execFileSync('curl', ['-s', '--max-time', '15', `http://${PUBLIC_IP}/.well-known/acme-challenge/${firstToken}`], { encoding: 'utf8' });
  const expected = fs.readFileSync(path.join(STATE_DIR, 'out', firstToken), 'utf8').trim();
  if (probe.trim() !== expected) {
    throw new Error(
      `challenge probe mismatch — public URL did not return the token (got ${probe.slice(0, 80)}). ` +
      'The nginx /.well-known/acme-challenge/ location is missing or wrong.'
    );
  }
  log('public challenge probe OK');

  // ── 4. Notify LE and wait for each authorization to turn valid ────────────
  for (const authz of authorizations) {
    const challenge = authz.challenges.find((c) => c.type === 'http-01');
    await client.completeChallenge(challenge);
    await client.waitForValidStatus(challenge);
  }
  log('authorizations valid');

  // ── 5. CSR + finalize + download ───────────────────────────────────────────────
  // acme-client's forge CSR encodes an IP SAN as a text string (15 bytes for
  // this address), which Let's Encrypt's Go parser rejects with "cannot parse
  // IP address of length 15". openssl encodes it correctly as 4-byte octets,
  // so the CSR is built with the openssl CLI instead.
  const certKeyPath = path.join(STATE_DIR, 'out', 'cert-key.pem');
  const csrPath = path.join(STATE_DIR, 'out', 'cert-request.csr');
  fs.writeFileSync(certKeyPath, await acme.forge.createPrivateKey());
  execFileSync('openssl', [
    'req', '-new', '-key', certKeyPath,
    // Empty subject — CA/B rules forbid an IP literal in the CN; the identity
    // lives solely in the subjectAltName.
    '-subj', '/',
    '-addext', `subjectAltName=IP:${PUBLIC_IP}`,
    '-out', csrPath,
  ], { stdio: 'ignore' });
  const certCsr = fs.readFileSync(csrPath);
  const finalized = await client.finalizeOrder(order, certCsr);
  const fullChain = await client.getCertificate(finalized);
  const leafChain = fullChain.split(/(?=-----BEGIN CERTIFICATE-----)/);
  const cert = leafChain[0];
  const chain = leafChain.slice(1).join('');

  const outDir = path.join(STATE_DIR, 'out');
  const certPaths = {
    key: certKeyPath,
    cert: path.join(outDir, 'cert.pem'),
    chain: path.join(outDir, 'chain.pem'),
    fullchain: path.join(outDir, 'fullchain.pem'),
  };
  fs.writeFileSync(certPaths.cert, cert);
  fs.writeFileSync(certPaths.chain, chain);
  fs.writeFileSync(certPaths.fullchain, fullChain);
  log('certificate downloaded');

  // Clean the challenge files off the VPS.
  for (const f of challengeFiles) {
    sshRemote(`rm -f /var/www/performancetracking/app/backend/acme-challenges/${f}`).trim();
  }

  if (DRY_RUN) {
    log('DRY-RUN: stopping before installation. Certificate validated end-to-end.');
    return;
  }

  // ── 6. Install on the VPS and restart the TLS terminator ──────────────────
  sshRemote(`mkdir -p ${REMOTE_TLS_DIR} && chmod 700 ${REMOTE_TLS_DIR}`);
  scpPush(certPaths.key, `${REMOTE_TLS_DIR}/key.pem`);
  scpPush(certPaths.fullchain, `${REMOTE_TLS_DIR}/fullchain.pem`);
  sshRemote(
    `chmod 600 ${REMOTE_TLS_DIR}/key.pem && chmod 644 ${REMOTE_TLS_DIR}/fullchain.pem && ` +
    `openssl x509 -in ${REMOTE_TLS_DIR}/fullchain.pem -noout -subject -dates && ` +
    `cp ${REMOTE_TLS_DIR}/key.pem ~/vas-tls/key.pem && cp ${REMOTE_TLS_DIR}/fullchain.pem ~/vas-tls/cert.pem && ` +
    `pm2 restart vas-https && sleep 2 && curl -sk https://127.0.0.1:5000/api/health`
  );
  log('installed to ~/vas-tls and vas-https restarted');
  log(`SUCCESS — https://${PUBLIC_IP}:5000 now serves the Let's Encrypt ${STAGING ? 'STAGING ' : ''}certificate`);
}

main().catch((err) => {
  console.error('RENEWAL FAILED:', err.message || err);
  process.exit(1);
});
