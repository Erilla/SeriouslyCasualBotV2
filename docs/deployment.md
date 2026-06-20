# Deployment

## Overview

Production runs on a Hetzner ARM server (linux/arm64). GitHub Actions builds and pushes the Docker image to GHCR, then SSHes into the server to pull and restart.

## GitHub Actions Flow

1. **CI** (`ci.yml`) — runs on every push/PR to `master`: typecheck, unit tests, build.
2. **Deploy** (`deploy.yml`) — runs on push to `master` only, after CI passes:
   - Builds multi-platform image (`linux/arm64`)
   - Pushes to `ghcr.io/<owner>/seriouslycasualbot:latest` and `:<sha>`
   - SSHes to server and runs `docker compose pull && docker compose up -d`

## Required Secrets

Set these in the GitHub repository secrets:

| Secret | Description |
|---|---|
| `DEPLOY_HOST` | Hetzner server IP or hostname |
| `DEPLOY_USER` | SSH username on the server |
| `DEPLOY_SSH_KEY` | Private SSH key (no passphrase) |
| `ANTHROPIC_API_KEY` | For Claude code review workflow |

## Hetzner Server Setup

```bash
# 1. Install Docker
curl -fsSL https://get.docker.com | sh

# 2. Create app directory and .env
mkdir ~/seriouslycasualbot
cd ~/seriouslycasualbot
cp .env.example .env   # fill in all required values

# 3. Create docker-compose.yml (copy from repo or use scp)

# 4. Login to GHCR (needed to pull private images)
echo $GITHUB_TOKEN | docker login ghcr.io -u <username> --password-stdin

# 5. Pull and start
docker compose pull
docker compose up -d
```

## Rollback

```bash
# SSH into the server
cd ~/seriouslycasualbot

# Roll back to a specific image SHA
docker compose down
docker compose run --rm -e IMAGE_TAG=<sha> bot   # or edit compose file
# Or pull a specific tag directly:
docker pull ghcr.io/<owner>/seriouslycasualbot:<sha>
docker compose up -d

# View logs
docker compose logs -f --tail=100
```

The SQLite data volume (`bot-data`) persists across restarts and image updates.

## Test server (staging soak)

A second, isolated instance runs on its own Hetzner box for stability soak
testing. It uses the **same image** as production but a different `.env`
(pointed at the **sandbox Discord guild**), and an isolated compose stack
(`COMPOSE_PROJECT_NAME=scbot-test`) so it can never collide with prod.

### Pipeline

`deploy.yml` runs on every push to `master`: `ci → build → deploy-test` (and
`deploy-prod` once its secrets exist). Each deploy job is gated on its host
secret, so an unconfigured target is **skipped, not failed**. The `build` job
publishes `ghcr.io/<owner>/seriouslycasualbot:{latest,<sha>}`; the deploy jobs
just `docker compose pull && up -d` over SSH.

Required secrets for the test deploy:

| Secret | Value |
|---|---|
| `TEST_DEPLOY_HOST` | Test server IP |
| `TEST_DEPLOY_USER` | `root` |
| `TEST_DEPLOY_SSH_KEY` | Private half of the dedicated deploy keypair |

### First-time setup

1. **Provision the box** (Hetzner CAX11, ARM, 4 GB — matches the `linux/arm64`
   image). Install [`hcloud`](https://github.com/hetznercloud/cli), then:
   ```bash
   export HCLOUD_TOKEN=<your token>
   ./scripts/provision-test-server.sh
   ```
   This creates a deploy keypair, registers it with Hetzner, creates the server,
   and installs Docker + a pull-only `docker-compose.yml` via
   `scripts/test-server-cloud-init.yaml`. It prints the exact follow-up commands.

2. **Set the GitHub secrets** (the script prints these with the real IP):
   ```bash
   gh secret set TEST_DEPLOY_HOST --body "<IP>"
   gh secret set TEST_DEPLOY_USER --body "root"
   gh secret set TEST_DEPLOY_SSH_KEY < ./scbot-test-deploy
   ```

3. **Add the sandbox config to the box:**
   ```bash
   cp .env.test-server.example .env.test-server   # fill in sandbox guild values
   scp -i ./scbot-test-deploy .env.test-server root@<IP>:/root/seriouslycasualbot-test/.env
   ```
   `.env.test-server` must include `GITHUB_REPOSITORY_OWNER=<lowercase owner>`
   and `COMPOSE_PROJECT_NAME=scbot-test` (the template already has them).

4. **One-time GHCR login on the box** (the image is private):
   ```bash
   ssh -i ./scbot-test-deploy root@<IP> \
     'echo <GHCR_READ_PAT> | docker login ghcr.io -u <github-user> --password-stdin'
   ```

5. **Merge `feat/test-server-deploy` to `master`.** The Deploy workflow builds
   the image and rolls it out to the test box automatically.

### Verify / observe the soak

```bash
ssh -i ./scbot-test-deploy root@<IP> \
  'cd ~/seriouslycasualbot-test && docker compose ps && docker compose logs --tail=100 -f'
```

`restart: unless-stopped` means a crash auto-recovers; check `docker compose ps`
uptime and `STATUS` over time to gauge stability.
