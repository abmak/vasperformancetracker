# Deploying to production

Production is a single VPS that has **no outbound internet**, so it can never
`git pull`. Deploys used to be ad-hoc `scp` copies, which let the box run code
that existed in no repository. This flow ships the **source of a committed
revision** instead, and keeps every applied commit on the box so any earlier one
can be restored with one command.

Two files make it work:

| File | Runs on | Role |
| --- | --- | --- |
| `scripts/deploy.js` | your machine | archives a commit, builds the frontend, uploads, applies, health-checks |
| `scripts/deploy/remote-deploy.sh` | the VPS | swaps files in place, snapshots each release, restarts pm2, rolls back |

## Process — every deploy is a commit

When you ask for a deployment, the flow is **commit → push → deploy**, run as one
command:

```bash
node scripts/deploy.js ship                 # commit ALL changes, push, then deploy
node scripts/deploy.js ship -m "message"    # ... with an explicit commit message
```

`ship` stages everything with `git add -A` (respecting `.gitignore`, so
`node_modules`, `frontend/dist`, `.env*`, logs and `*.pptx` stay out), commits it,
pushes the branch to GitHub (`origin`), and only then deploys **that commit**. So
the live release is always a pushed commit — never a dirty working tree — and the
record on the VPS (`APP_DIR/.deploy/CURRENT`) names the exact commit in GitHub.

## Usage

```bash
node scripts/deploy.js ship                 # commit all changes, push, deploy
node scripts/deploy.js ship -m "message"    # ... with an explicit commit message

node scripts/deploy.js                      # deploy HEAD (the tree must be committed)
node scripts/deploy.js --ref v1.2.0         # deploy a tag / branch / commit
node scripts/deploy.js --skip-build         # reuse the existing frontend/dist (fast)
node scripts/deploy.js --allow-dirty        # deploy the working tree (emergencies only)

node scripts/deploy.js rollback <sha|name>  # restore an earlier release
node scripts/deploy.js list                 # releases on the VPS + the one live now
```

A plain `deploy` (no commit):

1. **Refuses to run unless `backend/` and `frontend/` are committed.** This is the
   whole point — production must run code that exists in git. `--allow-dirty`
   overrides it and tags the release `<sha>-dirty` (use `ship` instead).
2. Builds the frontend (`npm run build` in `frontend/`).
3. Packages the backend with `git archive <sha> backend/src backend/package*.json`
   and the built frontend as `dist.tar.gz`.
4. `scp`s them to `APP_DIR/.deploy/incoming/` and runs the remote helper.
5. Waits for `http://127.0.0.1:5001/api/health` and reports success.

## What a deploy never touches

`backend/node_modules`, `backend/.env.production`, `backend/uploads/`,
`backend/acme-challenges/` and any other untracked file. Only these move:

```
backend/src/            backend/package.json    backend/package-lock.json
frontend/dist/
```

Swaps are staged into `*.new` and only then moved into place, so a failure
mid-way cannot leave the app half-written.

## Rollback

Every successful deploy snapshots the live source into
`APP_DIR/.deploy/releases/<sha>/` (`backend.tgz` + `dist.tgz`) and writes
`APP_DIR/.deploy/CURRENT`. The six most recent releases are kept.

```bash
node scripts/deploy.js list                 # see what's available
node scripts/deploy.js rollback 4a216806b987
```

Rollback restores the backend source and `frontend/dist` for that commit and
restarts pm2. It is the same mechanism as a deploy, so it is just as safe.

## Configuration

Override via environment variables if the target ever changes:

| Variable | Default |
| --- | --- |
| `VAS_DEPLOY_HOST` | `feveneyasu@196.189.155.179` |
| `VAS_DEPLOY_KEY` | `~/.ssh/id_rsa_feveneyasu` |
| `VAS_APP_DIR` | `/var/www/performancetracking/app` |
| `VAS_PM2_NAME` | `perf-tracking-api` |
| `VAS_HEALTH_URL` | `http://127.0.0.1:5001/api/health` |
| `VAS_DEPLOY_KEEP` | `6` (releases retained) |
| `VAS_PUSH_REMOTE` | `origin` |

> **Testing on Windows / Git Bash:** the shell rewrites POSIX-looking env values
> into Windows paths, which breaks `VAS_APP_DIR=/tmp/...`. Prefix the command with
> `MSYS2_ENV_CONV_EXCL='VAS_APP_DIR;VAS_HEALTH_URL;VAS_PM2_NAME'` when rehearsing
> against a sandbox directory.

## Bootstrapping

The first deploy creates `APP_DIR/.deploy/` on the VPS. Nothing needs to be
installed on the box — the helper is plain `bash` and already-present `tar`/`pm2`/
`curl`. The local side needs `git`, `ssh`/`scp`, `tar`, and Node.

`--push` is opt-in and just records the commit on GitHub; pushing is **not** how
production updates — production updates via the GitHub Actions CD pipeline
(below) or this script.

## GitHub Actions CI/CD

> **Active since 2026-10-06** — `SSH_PRIVATE_KEY` secret is set; pushes to `main`
> deploy automatically (health-gated, auto-rollback). Use `scripts/deploy.js ship`
> only as a fallback and never mix both paths for one change.

`.github/workflows/ci-cd.yml` runs on every push/PR:

| Job | What it does |
| --- | --- |
| `backend` | `npm ci`, syntax-checks every file, boots the API against a real **MySQL 8.0.46 service container** (Docker in CI), runs `ensureChannelSchema` + a `/api/health` smoke test |
| `frontend` | `npm ci` + production build |
| `deploy` | on green `main` pushes only: builds, ships the same tarballs over SSH with a **dedicated deploy key**, health-gates the release, **auto-rolls back** to the previous release if the health check fails |

The deploy job skips itself gracefully until the `SSH_PRIVATE_KEY` secret exists.

### One-time setup (the only manual steps)

1. A deploy keypair already exists at `scripts/deploy/gha_deploy_ed25519` (its
   public half is installed in the VPS `authorized_keys`; the private half is
   gitignored on this machine).
2. Copy the **contents of `scripts/deploy/gha_deploy_ed25519`** (the private
   key file, including the BEGIN/END lines) into:
   GitHub → Settings → Secrets and variables → Actions → **New repository
   secret** → Name: `SSH_PRIVATE_KEY`.
3. Push to `main` — CI runs, and with the secret present the deploy job ships
   the release exactly like `scripts/deploy.js ship` did.

To require a human click before production deploys: add a GitHub Environment
(`production`) with *Required reviewers* and point the deploy job at it via
`environment: production`.

### Concurrency safety

The deploy job serializes on the `deploy-production` group, so two pushes can
never deploy at once. Manual `scripts/deploy.js ship` is still possible but
should be avoided while Actions deploys are enabled — pick one path per change.

## Docker runtime on the VPS (optional, enabled now that the VPS has internet)

The VPS can run the app as a container instead of pm2. MySQL stays on the host
(the standby/failover design depends on it).

| File | Purpose |
| --- | --- |
| `Dockerfile` | multi-stage production image (API + built SPA, non-root) |
| `docker-compose.yml` | host-networked runtime sharing the pm2 ports, env file, uploads and failover marker |
| `.github/workflows/docker-publish.yml` | builds + pushes the image to GHCR on `main` (gated by repo variable `PUBLISH_DOCKER=true`) |
| `scripts/docker/install-docker-vps.sh` | **run with sudo on the VPS** — installs Docker + compose plugin |

### Migration steps (when you decide to switch)

1. On the VPS: `sudo bash ~/install-docker-vps.sh` (installs Docker, adds
   `feveneyasu` to the docker group — re-login afterwards).
2. Set the repo variable `PUBLISH_DOCKER=true` → the image publishes to
   `ghcr.io/abmak/vasperformancetracker:latest` on the next push.
3. GHCR auth on the VPS (private package): create a fine-grained PAT with
   `read:packages` → `docker login ghcr.io -u abmak -p <PAT>` — or flip the
   package to public in GitHub → Packages.
4. Cutover (on the VPS):
   `pm2 delete perf-tracking-api && docker compose -f $APP_DIR/docker-compose.yml up -d`
   (compose file + `scp` it to `$APP_DIR` first). Rollback:
   `docker compose down && pm2 start perf-tracking-api`.
5. The Health page keeps working as-is — the container shares the failover
   marker with the host sync daemon via the mounted `~/mysql-standby` path.
