# Release Notes on Prod Promotion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every fast-forward promotion to `prod` automatically creates a tagged GitHub Release with git-cliff-generated notes and posts them to the `#bot-logs` Discord channel.

**Architecture:** A standalone GitHub Actions workflow (`release.yml`) triggers on pushes to `prod`, derives the promoted range from the push event's `before`/`after` SHAs, formats grouped notes with git-cliff (`cliff.toml` config), creates a `build-N` release (N = commit count, matching the bot's startup banner), and POSTs an embed to a Discord webhook. No bot-code changes.

**Tech Stack:** GitHub Actions, git-cliff v2 (via `npx git-cliff@2`), `gh` CLI (preinstalled on runners), Discord webhook API, node one-liner for payload building.

**Spec:** `docs/superpowers/specs/2026-07-21-release-notes-on-promotion-design.md`

## Global Constraints

- Tag/release name is exactly `build-$BUILD` with title `Build $BUILD`, where `BUILD=$(git rev-list --count HEAD)` on the promoted commit.
- Discord embed title is exactly: `🚀 Build $BUILD deployed to prod`; embed description limit is 4096 chars — truncate with a trailing `[Full notes](<release url>)` link when exceeded.
- The Discord step must NEVER fail the workflow (`continue-on-error: true` plus a graceful skip when the `DISCORD_RELEASE_WEBHOOK` secret is absent).
- Empty/whitespace-only git-cliff output → notes become `No user-facing changes` (workflow must not fail).
- Group order in notes: Features, Bug Fixes, Performance, Refactoring, Housekeeping (docs/chore/style/test/ci/build and anything unmatched). Merge commits are skipped.
- Do NOT push to origin during this plan — pushing main deploys and restarts the test bot. Local commits only; the user pushes.
- CI blocks on prettier `format:check`; it only covers `src/**/*.ts`, `tests/**/*.ts`, and root `*.{ts,js}`, so YAML/TOML files are not affected — but run `npm run format:check` before committing anyway to be safe.

---

### Task 1: `cliff.toml` — git-cliff configuration

**Files:**
- Create: `cliff.toml` (repo root)

**Interfaces:**
- Consumes: the repo's conventional-commit history (`feat(scope): ...`, `fix: ...`, etc.).
- Produces: `cliff.toml` used by Task 2's workflow via `npx --yes git-cliff@2 --config cliff.toml <range>`; output is markdown with `### <Group>` headings and `- **scope:** description` bullets, no header/footer/version line.

- [ ] **Step 1: Write the config**

Create `cliff.toml`:

```toml
# git-cliff configuration for release notes on prod promotion.
# Invoked by .github/workflows/release.yml over the promoted commit range;
# output becomes the GitHub Release body and the #bot-logs Discord post.
# The <!-- N --> prefixes force group ordering and are stripped by the
# template's striptags filter.

[changelog]
trim = true
body = """
{% for group, commits in commits | group_by(attribute="group") %}
### {{ group | striptags | trim }}
{% for commit in commits %}
- {% if commit.scope %}**{{ commit.scope }}:** {% endif %}{{ commit.message | upper_first }}
{%- endfor %}
{% endfor %}
"""

[git]
conventional_commits = true
# Keep unconventional commits (rare) instead of dropping them silently;
# the catch-all parser routes them to Housekeeping.
filter_unconventional = false
commit_parsers = [
  { message = "^Merge", skip = true },
  { message = "^feat", group = "<!-- 0 -->Features" },
  { message = "^fix", group = "<!-- 1 -->Bug Fixes" },
  { message = "^perf", group = "<!-- 2 -->Performance" },
  { message = "^refactor", group = "<!-- 3 -->Refactoring" },
  { message = ".*", group = "<!-- 4 -->Housekeeping" },
]
```

- [ ] **Step 2: Verify against real history (the test for this task)**

Run from the repo root (Git Bash):

```bash
npx --yes git-cliff@2 --config cliff.toml 7349996..2fb3fb0
```

(That range is the real set of commits currently on main since the last batch — build banner + security bump work.)

Expected output shape (verify all of these):
- A `### Features` section listing the `feat(build)`/`feat(bot)`/`feat(db)` commits with bold scopes, e.g. `- **build:** Support GITHUB_TOKEN for authenticated commit lookups`.
- A `### Bug Fixes` section with the `fix:`/`fix(build)` commits.
- A `### Housekeeping` section with the `docs:` and `chore(deps):` commits.
- Groups in the order Features → Bug Fixes → Housekeeping; NO literal `<!-- 0 -->` visible in headings; no version header line; no empty groups.

If the output shows raw `<!-- N -->` in headings, the `striptags` filter is missing; if groups are misordered, the prefixes are wrong. Fix and re-run.

Also verify the empty-range behaviour used by Task 2:

```bash
npx --yes git-cliff@2 --config cliff.toml 2fb3fb0..2fb3fb0
```

Expected: empty or whitespace-only output, exit code 0 (Task 2's workflow substitutes the fallback text).

- [ ] **Step 3: Commit**

```bash
git add cliff.toml
git commit -m "feat(release): add git-cliff config for promotion release notes"
```

---

### Task 2: `release.yml` workflow + deployment docs

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `docs/deployment.md` (add a "Release notes" subsection after the promotion-flow section, around line 31)

**Interfaces:**
- Consumes: `cliff.toml` from Task 1 (invoked as `npx --yes git-cliff@2 --config cliff.toml "$RANGE"`); repo secret `DISCORD_RELEASE_WEBHOOK` (may be absent); `github.event.before`/`github.event.after` from the push event.
- Produces: tag + GitHub Release `build-$BUILD`; Discord embed in `#bot-logs`.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    branches: [prod]

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # Full history: git-cliff walks the promoted range and the build
          # number is the commit count of HEAD.
          fetch-depth: 0

      - name: Compute build number
        id: build
        run: echo "number=$(git rev-list --count HEAD)" >> "$GITHUB_OUTPUT"

      - name: Generate release notes
        env:
          RANGE: ${{ github.event.before }}..${{ github.event.after }}
        run: |
          npx --yes git-cliff@2 --config cliff.toml "$RANGE" -o notes.md
          # Empty promotion range (e.g. re-push of the same SHA) must not fail.
          if [ -z "$(tr -d '[:space:]' < notes.md 2>/dev/null)" ]; then
            echo "No user-facing changes" > notes.md
          fi

      - name: Create GitHub release
        env:
          GH_TOKEN: ${{ github.token }}
          BUILD: ${{ steps.build.outputs.number }}
        run: |
          gh release create "build-$BUILD" \
            --target "${{ github.event.after }}" \
            --title "Build $BUILD" \
            --notes-file notes.md

      - name: Post to Discord
        # The deploy already happened; announcing must never fail the workflow.
        continue-on-error: true
        env:
          WEBHOOK_URL: ${{ secrets.DISCORD_RELEASE_WEBHOOK }}
          BUILD: ${{ steps.build.outputs.number }}
          RELEASE_URL: ${{ github.server_url }}/${{ github.repository }}/releases/tag/build-${{ steps.build.outputs.number }}
        run: |
          if [ -z "$WEBHOOK_URL" ]; then
            echo "DISCORD_RELEASE_WEBHOOK not set; skipping Discord post"
            exit 0
          fi
          node -e '
            const fs = require("fs");
            let notes = fs.readFileSync("notes.md", "utf8").trim();
            const max = 4096;
            const suffix = `\n\n[Full notes](${process.env.RELEASE_URL})`;
            if (notes.length > max) {
              notes = notes.slice(0, max - suffix.length) + suffix;
            }
            const payload = {
              embeds: [{
                title: `🚀 Build ${process.env.BUILD} deployed to prod`,
                description: notes,
                url: process.env.RELEASE_URL,
                color: 0x57f287,
              }],
            };
            fs.writeFileSync("payload.json", JSON.stringify(payload));
          '
          curl -sS -f -H "Content-Type: application/json" -d @payload.json "$WEBHOOK_URL"
```

- [ ] **Step 2: Validate YAML syntax**

```bash
npx --yes js-yaml .github/workflows/release.yml > /dev/null && echo YAML_OK
```

Expected: `YAML_OK` (js-yaml exits non-zero on parse errors).

- [ ] **Step 3: Dry-run the truncation logic locally (the test for the node one-liner)**

```bash
node -e "require('fs').writeFileSync('notes.md', 'x'.repeat(5000))"
BUILD=999 RELEASE_URL=https://example.com/rel node -e '
  const fs = require("fs");
  let notes = fs.readFileSync("notes.md", "utf8").trim();
  const max = 4096;
  const suffix = `\n\n[Full notes](${process.env.RELEASE_URL})`;
  if (notes.length > max) {
    notes = notes.slice(0, max - suffix.length) + suffix;
  }
  const payload = { embeds: [{ title: `🚀 Build ${process.env.BUILD} deployed to prod`, description: notes, url: process.env.RELEASE_URL, color: 0x57f287 }] };
  fs.writeFileSync("payload.json", JSON.stringify(payload));
'
node -e "const p = JSON.parse(require('fs').readFileSync('payload.json','utf8')); const d = p.embeds[0].description; console.log('len:', d.length, '| ends with link:', d.endsWith('[Full notes](https://example.com/rel)')); if (d.length > 4096) process.exit(1);"
rm notes.md payload.json
```

Expected output: `len: 4096 | ends with link: true` and exit code 0.

- [ ] **Step 4: Document in docs/deployment.md**

In `docs/deployment.md`, directly after the paragraph ending "is exactly \"on test but not yet in prod\"." (around line 31), insert:

```markdown
### Release notes

Every promotion triggers `.github/workflows/release.yml`, which tags the promoted
commit `build-N` (N = commit count — the same number the bot logs at startup),
creates a GitHub Release with git-cliff-generated notes (config: `cliff.toml`),
and posts them to `#bot-logs` via the `DISCORD_RELEASE_WEBHOOK` repo secret.
If the secret is missing the Discord post is skipped; a Discord failure never
fails the workflow. Releases: <https://github.com/Erilla/SeriouslyCasualBotV2/releases>.

One-time setup: create a webhook in `#bot-logs` (channel settings → Integrations →
Webhooks) and store it with `gh secret set DISCORD_RELEASE_WEBHOOK`.
```

- [ ] **Step 5: Run repo checks and commit**

```bash
npm run format:check
git add .github/workflows/release.yml docs/deployment.md
git commit -m "feat(release): create GitHub Release and Discord post on prod promotion"
```

Expected: format:check passes (workflow YAML is outside prettier's globs).

---

## Post-plan notes (for the human, not the executor)

- The workflow only fires once it exists on `prod` — i.e. after this lands on main and the next promotion happens. That first promotion is the end-to-end test.
- Before that promotion: create the `#bot-logs` webhook and `gh secret set DISCORD_RELEASE_WEBHOOK`. Missing secret = release still created, Discord skipped.
- The first release's notes will span the whole `before..after` range of that promotion (currently 13+ commits) — a nice, meaty first entry.
