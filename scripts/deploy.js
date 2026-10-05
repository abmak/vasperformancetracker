#!/usr/bin/env node
/**
 * Commit-based deploy for the VAS Performance Tracker.
 *
 * WHY THIS EXISTS
 *   Production is a single VPS with no outbound internet, so it can never
 *   `git pull` from GitHub. Deploys used to be ad-hoc `scp` copies, which meant
 *   the box could run code that existed in no repository. This script instead
 *   always ships the *source of a committed revision*:
 *       git archive <sha> backend/src backend/package*.json   → backend.tar.gz
 *       npm run build (frontend)                              → dist.tar.gz
 *   and records each applied commit under APP_DIR/.deploy/releases/<sha>/, so
 *   any earlier commit can be restored with a single rollback command.
 *
 * WHAT IT NEVER TOUCHES
 *   backend/node_modules, backend/.env.production, backend/uploads,
 *   backend/acme-challenges — none are sent or removed, so the pm2 process,
 *   secrets and certificates survive every deploy.
 *
 * USAGE
 *   node scripts/deploy.js ship                  # commit ALL changes, push, then deploy
 *   node scripts/deploy.js ship -m "message"     # ... with an explicit commit message
 *   node scripts/deploy.js                      # deploy HEAD (must be committed)
 *   node scripts/deploy.js --ref v1.2.0         # deploy a tag/branch/commit
 *   node scripts/deploy.js --skip-build         # reuse the existing dist/ (fast)
 *   node scripts/deploy.js --allow-dirty        # deploy the working tree (discouraged)
 *   node scripts/deploy.js rollback <sha|name>  # restore an earlier release
 *   node scripts/deploy.js list                 # releases on the VPS + current
 *
 * PROCESS: run `ship` when you want changes deployed. It commits everything
 * (`git add -A`, honouring .gitignore), pushes to GitHub, and only then deploys
 * that commit — so every live release is a pushed commit, never a dirty tree.
 *
 * Overridable via env: VAS_DEPLOY_HOST, VAS_DEPLOY_KEY, VAS_APP_DIR,
 * VAS_PM2_NAME, VAS_DEPLOY_KEEP, VAS_HEALTH_URL.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(REPO_ROOT, 'frontend');

const VPS_HOST = process.env.VAS_DEPLOY_HOST || 'feveneyasu@196.189.155.179';
const VPS_KEY = process.env.VAS_DEPLOY_KEY || path.join(os.homedir(), '.ssh', 'id_rsa_feveneyasu');
const APP_DIR = process.env.VAS_APP_DIR || '/var/www/performancetracking/app';
const PM2_NAME = process.env.VAS_PM2_NAME || 'perf-tracking-api';
const HEALTH_URL = process.env.VAS_HEALTH_URL || 'http://127.0.0.1:5001/api/health';
const DEFAULT_KEEP = Number(process.env.VAS_DEPLOY_KEEP || 6);
const PUSH_REMOTE = process.env.VAS_PUSH_REMOTE || 'origin';

// The deployed backend set. node_modules/.env/uploads/acme-challenges are
// deliberately excluded — they are never shipped and never removed.
const BUNDLE_PATHS = ['backend/src', 'backend/package.json', 'backend/package-lock.json'];

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const REMOTE_HELPER = `${APP_DIR}/.deploy/remote-deploy.sh`;
const SSH_BASE = ['-i', VPS_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20'];

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT, ...opts });
  if (res.error) throw new Error(`failed to run ${cmd}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} exited with code ${res.status}`);
}
function capture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', cwd: REPO_ROOT, ...opts });
  if (res.error) throw new Error(`failed to run ${cmd}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} failed: ${(res.stderr || '').trim() || `exit ${res.status}`}`);
  return (res.stdout || '').trim();
}
// Like capture() but keeps stdout as a Buffer — used to stream tar/gzip output
// straight from git/tar without ever handing them an absolute path (Windows
// bsdtar reads a `C:` in a path as an rsh host and fails).
function captureBuffer(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 512, ...opts });
  if (res.error) throw new Error(`failed to run ${cmd}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} failed: ${(res.stderr || '').toString().trim() || `exit ${res.status}`}`);
  return res.stdout;
}

const git = (args) => capture('git', args);
const ssh = (remote) => capture('ssh', [...SSH_BASE, VPS_HOST, remote]);
const sshRun = (remote) => run('ssh', [...SSH_BASE, VPS_HOST, remote]);
const scp = (locals, remotePath) =>
  run('scp', [...SSH_BASE, ...locals, `${VPS_HOST}:${remotePath}`]);

// Always pass the target dir/process to the remote helper so the two sides can
// never disagree; also lets the whole flow be rehearsed against a sandbox dir.
const remoteCall = (rest, { inherit = false } = {}) => {
  const cmd = `VAS_APP_DIR='${APP_DIR}' VAS_PM2_NAME='${PM2_NAME}' bash ${REMOTE_HELPER} ${rest}`;
  return inherit ? sshRun(cmd) : ssh(cmd);
};

function usage() {
  console.log([
    'usage:',
    '  node scripts/deploy.js ship                 # commit all changes, push, deploy',
    '  node scripts/deploy.js ship -m "message"    # ... with an explicit commit message',
    '  node scripts/deploy.js                      # deploy HEAD (must be committed)',
    '  node scripts/deploy.js --ref v1.2.0         # deploy a tag/branch/commit',
    '  node scripts/deploy.js --skip-build         # reuse the existing dist/ (fast)',
    '  node scripts/deploy.js --allow-dirty        # deploy the working tree (discouraged)',
    '  node scripts/deploy.js rollback <sha|name>  # restore an earlier release',
    '  node scripts/deploy.js list                 # releases on the VPS + current',
  ].join('\n'));
}

function parseArgs(argv) {
  const opts = { ref: 'HEAD', push: false, skipBuild: false, allowDirty: false, keep: DEFAULT_KEEP, message: '', _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--push') opts.push = true;
    else if (a === '--skip-build') opts.skipBuild = true;
    else if (a === '--allow-dirty') opts.allowDirty = true;
    else if (a === '--ref') opts.ref = argv[++i];
    else if (a === '--keep') opts.keep = Number(argv[++i]);
    else if (a === '-m' || a === '--message') opts.message = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

function dirtyPaths() {
  const out = git(['status', '--porcelain', '--', 'backend', 'frontend']);
  return out.split('\n').filter(Boolean);
}

function ensureClean(opts) {
  const lines = dirtyPaths();
  if (!lines.length) return;
  if (!opts.allowDirty) {
    console.error('\nRefusing to deploy: backend/ or frontend/ has uncommitted changes.\n');
    lines.forEach((l) => console.error('   ' + l));
    console.error('\nCommit them first so production runs committed code, or re-run with --allow-dirty.\n');
    process.exit(1);
  }
  console.warn('\n⚠  --allow-dirty: deploying the working tree (release will be tagged "-dirty").\n');
}

function uploadHelper() {
  ssh(`mkdir -p '${APP_DIR}/.deploy/incoming'`);
  scp([path.join(REPO_ROOT, 'scripts', 'deploy', 'remote-deploy.sh')], `${APP_DIR}/.deploy/remote-deploy.sh`);
}

function waitForHealth() {
  try {
    const body = ssh(
      `for i in $(seq 1 20); do sleep 1; ` +
        `if curl -fsS -m 5 ${HEALTH_URL} >/dev/null 2>&1; then curl -s -m 5 ${HEALTH_URL}; exit 0; fi; ` +
        `done; echo UNHEALTHY; exit 1`
    );
    console.log(`  health: ${body}`);
    return true;
  } catch {
    console.error(`  ⚠ app did not answer ${HEALTH_URL} within 20s — consider: node scripts/deploy.js rollback <previous>`);
    return false;
  }
}

function deploy(opts) {
  ensureClean(opts);

  const sha = git(['rev-parse', opts.ref]);
  const shortSha = sha.slice(0, 12);
  const releaseId = opts.allowDirty ? `${shortSha}-dirty` : shortSha;

  let subject = '';
  try { subject = git(['log', '-1', '--format=%s', sha]); } catch { /* shallow clones */ }
  console.log(`\nDeploying ${releaseId}${subject ? ` — ${subject}` : ''}\n`);

  // 1. Build the frontend (production serves frontend/dist statically).
  if (!opts.skipBuild) {
    console.log('• Building frontend (vite)…');
    // shell:true — on Windows npm is a .cmd shim that cannot be spawned directly.
    run(NPM, ['run', 'build'], { cwd: FRONTEND_DIR, shell: process.platform === 'win32' });
  }
  if (!fs.existsSync(path.join(FRONTEND_DIR, 'dist', 'index.html'))) {
    throw new Error('frontend/dist/index.html missing — build failed or --skip-build with no prior build');
  }

  // 2. Package artifacts. Backend comes from the commit (or the tree when
  //    --allow-dirty) — never a hand-picked file list.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vas-deploy-'));
  const backendTar = path.join(tmp, 'backend.tar.gz');
  const distTar = path.join(tmp, 'dist.tar.gz');
  try {
    if (opts.allowDirty) {
      console.log('• Archiving backend from the working tree…');
      fs.writeFileSync(backendTar, captureBuffer('tar', ['-czf', '-', ...BUNDLE_PATHS], { cwd: REPO_ROOT }));
    } else {
      console.log('• Archiving backend from commit…');
      fs.writeFileSync(backendTar, captureBuffer('git', ['archive', '--format=tar.gz', sha, ...BUNDLE_PATHS]));
    }
    console.log('• Archiving built frontend…');
    fs.writeFileSync(distTar, captureBuffer('tar', ['-czf', '-', 'dist'], { cwd: FRONTEND_DIR }));

    // 3. Ship to the VPS.
    console.log('• Uploading to VPS…');
    uploadHelper();
    scp([backendTar, distTar], `${APP_DIR}/.deploy/incoming/`);

    // 4. Apply on the VPS.
    console.log('• Applying on VPS…');
    remoteCall(`apply ${releaseId} ${opts.keep}`, { inherit: true });

    // 5. Verify it actually serves.
    console.log('• Waiting for the app to come up…');
    waitForHealth();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 6. Optionally record the commit on GitHub.
  if (opts.push) {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    console.log(`• Pushing ${branch} to origin…`);
    run('git', ['push', 'origin', branch]);
  }

  console.log(`\n✅ Deployed ${releaseId}.`);
  console.log(`   Roll back with:  node scripts/deploy.js rollback ${releaseId}`);
  console.log(`   Published commits: node scripts/deploy.js list\n`);
}

// ship — the happy path: commit everything, push it, then deploy that commit.
function ship(opts) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);

  console.log('\n• Staging all changes (git add -A)…');
  run('git', ['add', '-A']);
  const staged = capture('git', ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);

  if (!staged.length) {
    console.log('• Nothing to commit — deploying the current HEAD.');
  } else {
    console.log(`• ${staged.length} file(s) will be committed:`);
    staged.forEach((f) => console.log('    ' + f));
    const message = opts.message || `deploy: ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`;
    run('git', ['commit', '-m', message]);
    console.log(`• Committed: ${git(['rev-parse', '--short=12', 'HEAD'])}`);
  }

  console.log(`• Pushing ${branch} to ${PUSH_REMOTE}…`);
  run('git', ['push', PUSH_REMOTE, branch]);

  // Deploy exactly the commit that was just pushed (never the working tree).
  deploy({ ...opts, ref: git(['rev-parse', 'HEAD']), allowDirty: false, push: false });
}

function rollback(id) {
  if (!id) throw new Error('rollback needs a release id, e.g. node scripts/deploy.js rollback 1a2b3c4d5e6f');
  uploadHelper();
  console.log(`• Rolling back to ${id}…`);
  remoteCall(`rollback ${id}`, { inherit: true });
  console.log('• Waiting for the app to come up…');
  waitForHealth();
  console.log(`\n✅ Rolled back to ${id}.\n`);
}

function list() {
  uploadHelper();
  console.log(`\nlocal HEAD: ${git(['rev-parse', '--short=12', 'HEAD'])}`);
  console.log(remoteCall('list'));
  console.log('');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cmd = opts._[0] || 'deploy';
  if (cmd === 'ship') ship(opts);
  else if (cmd === 'deploy') deploy(opts);
  else if (cmd === 'rollback') rollback(opts._[1]);
  else if (cmd === 'list') list();
  else { usage(); process.exit(1); }
}

try {
  main();
} catch (err) {
  console.error(`\n✖ ${err.message}\n`);
  process.exit(1);
}
