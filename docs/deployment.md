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
