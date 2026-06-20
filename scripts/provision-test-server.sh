#!/usr/bin/env bash
set -euo pipefail

# Provision a Hetzner Cloud test server for SeriouslyCasualBot and print the
# exact follow-up commands needed to finish wiring the GitHub Actions test
# deploy. This script only touches your Hetzner account and a local keypair —
# it does NOT set any GitHub secrets or copy any .env (those steps carry
# secrets and are printed for you to run yourself).
#
# Prerequisites:
#   - hcloud CLI installed: https://github.com/hetznercloud/cli
#   - export HCLOUD_TOKEN=<Hetzner Cloud API token with Read & Write>
#   - gh CLI authenticated (for the secret commands printed at the end)
#
# Usage:
#   export HCLOUD_TOKEN=xxxxxxxx
#   ./scripts/provision-test-server.sh

SERVER_NAME="${SERVER_NAME:-scbot-test}"
SERVER_TYPE="${SERVER_TYPE:-cax11}"   # Ampere ARM, 2 vCPU / 4 GB (~EUR 3.79/mo)
IMAGE="${IMAGE:-ubuntu-24.04}"
LOCATION="${LOCATION:-fsn1}"          # Falkenstein DE. ARM also in nbg1 / hel1.
SSH_KEY_NAME="${SSH_KEY_NAME:-scbot-test-deploy}"
KEY_FILE="${KEY_FILE:-./scbot-test-deploy}"
CLOUD_INIT="${CLOUD_INIT:-scripts/test-server-cloud-init.yaml}"

command -v hcloud >/dev/null || { echo "ERROR: hcloud CLI not found." >&2; exit 1; }
: "${HCLOUD_TOKEN:?ERROR: export HCLOUD_TOKEN before running.}"
[ -f "$CLOUD_INIT" ] || { echo "ERROR: $CLOUD_INIT not found (run from repo root)." >&2; exit 1; }

# 1. Dedicated deploy keypair — GitHub Actions uses the private half to SSH in.
if [ ! -f "$KEY_FILE" ]; then
  echo "==> Generating deploy keypair at $KEY_FILE"
  ssh-keygen -t ed25519 -N "" -C "$SSH_KEY_NAME" -f "$KEY_FILE"
fi

# 2. Register the public key with Hetzner (idempotent).
if ! hcloud ssh-key describe "$SSH_KEY_NAME" >/dev/null 2>&1; then
  echo "==> Uploading public key to Hetzner as '$SSH_KEY_NAME'"
  hcloud ssh-key create --name "$SSH_KEY_NAME" --public-key-from-file "${KEY_FILE}.pub"
fi

# 3. Create the server (idempotent).
if ! hcloud server describe "$SERVER_NAME" >/dev/null 2>&1; then
  echo "==> Creating server '$SERVER_NAME' ($SERVER_TYPE, $IMAGE, $LOCATION)"
  hcloud server create \
    --name "$SERVER_NAME" \
    --type "$SERVER_TYPE" \
    --image "$IMAGE" \
    --location "$LOCATION" \
    --ssh-key "$SSH_KEY_NAME" \
    --user-data-from-file "$CLOUD_INIT"
else
  echo "==> Server '$SERVER_NAME' already exists; reusing."
fi

IP="$(hcloud server ip "$SERVER_NAME")"

cat <<EOF

==================================================================
 Server '$SERVER_NAME' is up at: $IP
==================================================================

Docker + the pull-only compose file install via cloud-init (give it
~1-2 minutes). Then finish wiring the deploy yourself:

1) Set the GitHub Actions secrets:
     gh secret set TEST_DEPLOY_HOST --body "$IP"
     gh secret set TEST_DEPLOY_USER --body "root"
     gh secret set TEST_DEPLOY_SSH_KEY < "$KEY_FILE"

2) Create your sandbox env and copy it to the box:
     cp .env.test-server.example .env.test-server     # then fill it in
     scp -i "$KEY_FILE" .env.test-server root@$IP:/root/seriouslycasualbot-test/.env

3) One-time GHCR login on the box so it can pull the (private) image:
     ssh -i "$KEY_FILE" root@$IP \\
       'echo <GHCR_READ_PAT> | docker login ghcr.io -u <github-user> --password-stdin'

4) Merge feat/test-server-deploy into master. The Deploy workflow builds the
   image and deploys it to the test box automatically.

Verify after deploy:
     ssh -i "$KEY_FILE" root@$IP 'cd ~/seriouslycasualbot-test && docker compose ps && docker compose logs --tail=50'
EOF
