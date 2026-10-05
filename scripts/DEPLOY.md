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
production updates (there is no CI/CD, and the box has no internet anyway).
