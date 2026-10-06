#!/usr/bin/env bash
#
# Installs Docker + the compose plugin on the production VPS (Ubuntu 22.04).
#
# REQUIRES ROOT — run it ON the VPS like this (enter your password when asked):
#
#   scp scripts/docker/install-docker-vps.sh feveneyasu@196.189.155.179:~/
#   ssh -t feveneyasu@196.189.155.179 'sudo bash ~/install-docker-vps.sh'
#
# Safe to re-run. Uses Ubuntu's own repositories (the VPS has outbound
# internet now). Does NOT touch MySQL, pm2 or any running app.
#
set -euo pipefail

[ "$(id -u)" = "0" ] || { echo "ERROR: run with sudo (see header)"; exit 1; }
command -v apt-get >/dev/null || { echo "ERROR: apt-get not found — this script targets Ubuntu 22.04"; exit 1; }

echo "[1/4] apt-get update + install docker.io and docker-compose-v2…"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2

echo "[2/4] enabling and starting the Docker service…"
systemctl enable --now docker

echo "[3/4] allowing user 'feveneyasu' to run docker without sudo…"
usermod -aG docker feveneyasu || true

echo "[4/4] verification:"
docker --version
docker compose version
echo
echo "DONE. NOTE: the 'docker' group membership for feveneyasu takes effect on"
echo "the NEXT login — log out and back in (or run 'newgrp docker') before"
echo "using docker compose as that user."
