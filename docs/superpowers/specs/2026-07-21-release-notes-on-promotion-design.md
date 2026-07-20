# Automatic Release Notes on Prod Promotion — Design

**Date:** 2026-07-21
**Status:** Approved

## Problem

Promotions to prod (`git push origin origin/main:prod`) deploy silently. There is no
record of what each promotion shipped and nowhere to see it. We want release notes
generated automatically on every promotion, stored durably, and visible in Discord.

## Chosen approach

A standalone GitHub Actions workflow triggered by pushes to `prod`. It needs no manual
step: the push event's `before`/`after` SHAs bound exactly the commits being promoted
(prod is fast-forward-only, so the range is always valid — force pushes are blocked by
the prod ruleset).

Rejected:

- **Release job inside `ci.yml`** — entangles announcing with validation and waits on
  a CI run that already passed on main (the promotion gate).
- **release-please / semantic-release** — want to own versioning via release PRs,
  which fights the PR-less trunk flow.
- **Committing a CHANGELOG.md** — a bot commit on prod would diverge it from main and
  break the fast-forward promotion invariant.

## Components

### `.github/workflows/release.yml` (new)

Trigger: `on: push: branches: [prod]`. Permissions: `contents: write` (tag + release
via the default `GITHUB_TOKEN`; no PAT). Steps:

1. Checkout with `fetch-depth: 0` (git-cliff and the commit count need full history).
2. `BUILD=$(git rev-list --count HEAD)` — the same build number the bot's startup
   banner logs, so the release and the running bot's log line match.
3. Generate notes with git-cliff over `${{ github.event.before }}..${{ github.event.after }}`.
4. `gh release create "build-$BUILD"` with title `Build $BUILD` and the notes as body.
   This also creates the `build-$BUILD` tag on the promoted commit.
5. POST the notes to the `#bot-logs` Discord channel via webhook (URL in repo secret
   `DISCORD_RELEASE_WEBHOOK`) as a single embed:
   - title: `🚀 Build $BUILD deployed to prod`
   - description: the git-cliff markdown, truncated to fit Discord's 4096-char embed
     limit with a trailing link to the GitHub release when truncated
   - The webhook step must not fail the workflow (the deploy has already happened);
     errors are logged and swallowed (`continue-on-error` or equivalent).

The workflow only takes effect once it exists on the `prod` branch, i.e. after landing
on main and being promoted once.

### `cliff.toml` (new, repo root)

git-cliff configuration:

- Conventional-commit parsing (matches the repo's existing feat/fix/chore(scope) style).
- Groups in order: Features, Bug Fixes, Performance, Refactoring, then docs/chore/
  style/test/ci collapsed into a single "Housekeeping" group. Nothing is hidden —
  the audience is officers/dev.
- Body template renders `### <group>` headings with `- <scope>: <description>` bullets
  (scope shown when present). No version header — the workflow provides the title.

## Storage and viewing

- **GitHub Releases page** — permanent, browsable history; each release is tagged
  `build-N` on the exact deployed commit, with auto-diff links between releases.
- **`#bot-logs` Discord channel** — immediate visibility on each promotion, alongside
  the bot's other operational output.

## One-time setup

1. Create a webhook in `#bot-logs` (channel settings → Integrations → Webhooks).
2. Store its URL: `gh secret set DISCORD_RELEASE_WEBHOOK`.

If the secret is absent the workflow still creates the GitHub Release and skips the
Discord post with a log line.

## Error handling

- Empty range (e.g. re-push of the same SHA): git-cliff produces empty notes; the
  workflow substitutes "No user-facing changes" rather than failing.
- Discord webhook errors never fail the workflow.
- Release-creation failure (e.g. tag already exists from a re-run) fails the workflow
  visibly — that is a real conflict a human should see.

## Testing

- `cliff.toml` validated locally against real history (`git cliff <old>..<new>` on an
  actual promotion range) — output inspected for grouping and formatting.
- Workflow YAML checked with `actionlint` if available; the bash steps (build number,
  truncation) are testable locally with plain git/bash.
- End-to-end proof is the first real promotion — low-stakes: it only tags, creates a
  release, and posts to Discord.
