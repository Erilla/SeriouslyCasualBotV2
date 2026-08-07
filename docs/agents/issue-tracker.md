# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

## Repo-specific notes

### Branch flow

`main` is trunk (deploys to the **test** environment); `prod` is the release branch (deploys to
**production**). Promote with a fast-forward: `git push origin origin/main:prod`.

### Merge method

**Squash only.** Merge commits and rebase merges are disabled at the repo level *and* by the
`main` ruleset's `allowed_merge_methods`. Use `gh pr merge <n> --squash`; `--merge` and
`--rebase` are rejected. The squash commit takes the **PR title** as its subject and the **PR
body** as its message, so write the PR title as the conventional-commit line you want in history.

### Protected branches

Both branches are protected by rulesets (not legacy branch protection — `gh api
.../branches/<b>/protection` returns 404; use `gh api .../rules/branches/<b>` to inspect).

`main` — blocks deletion and force-pushes; requires a pull request (**0 approving reviews**, so
you can merge your own) and a passing `ci` check. Direct pushes to `main` are rejected; every
change goes through a PR.

`prod` — blocks deletion and force-pushes; requires `ci` to pass **on the exact commit being
pushed**. A promotion immediately after a merge is rejected until that commit's own CI run
finishes, so expect to wait between merging and promoting.

### Waiting for CI (read this before concluding CI is broken)

**A workflow run can take minutes to even be created after a PR is opened, and minutes more to
start.** During that window `gh pr checks <n>` lists only the fast checks (GitGuardian),
`gh api .../actions/runs?branch=...` returns `total_count: 0`, and `mergeStateStatus` is
`BLOCKED`. That looks identical to "the required check will never run" — and it is not.

Two measured examples from this repo, both docs-only PRs:

| PR | Run created after open | Started after created | Total to green |
| -- | ---------------------- | --------------------- | -------------- |
| #69 | 88s | ~2 min | ~8 min |
| #80 | ~4.5 min | ~5.5 min | ~11 min |

So when polling:

- Treat an **absent** `ci` check as *not ready*, never as done. A loop that exits when no check
  is "pending" will exit immediately and report a false deadlock.
- Poll until a run named `ci` exists **and** reaches `completed`, e.g.
  `gh api "repos/<owner>/<repo>/actions/runs?branch=<branch>" --jq '[.workflow_runs[] | select(.name=="CI")] | if length==0 then "absent" else .[0].status end'`
- **Allow at least 15 minutes** before suspecting a real problem, and poll on a slow interval
  (20-30s) rather than tightly. Absence in the first 5 minutes means nothing.
- **Do not close/reopen the PR to "retrigger" it.** If the original run was already created,
  closing the PR orphans it in `queued` forever — and orphaned runs cannot be cancelled
  (`/cancel` and `/force-cancel` both return `Server Error`), so they linger in the run list.

The workflow has no `paths` filter, so every PR targeting `main` or `prod` triggers `ci`,
docs-only changes included.

### Recovering a genuinely orphaned run

Everything above is about *not* concluding CI is broken too early. This section is the opposite
case: how to tell when a run really is dead, and what actually revives it.

**Closing/reopening is not the only way to orphan a run.** A [GitHub Actions
outage](https://www.githubstatus.com/) does it too, with no help from you — PR #80's run was created
at 17:58Z during the 6 August incident, was never acquired by a runner, and was still `queued`
fourteen hours later with the incident long resolved. So the "wait longer" advice above has a limit:
once Actions is operational again and the run still has not started, waiting will not fix it.

**Diagnosis.** The run sits `queued` with an `updated_at` that stopped advancing, and the PR's check
rollup contains no `ci` entry at all (only the fast checks), so `mergeStateStatus` is `BLOCKED` with
nothing to wait for.

**All three recovery endpoints refuse it** — GitHub simultaneously believes the run is live (so it
will not cancel) and already running (so it will not re-run):

| Call | Response |
| ---- | -------- |
| `POST .../actions/runs/<id>/cancel` | `409` — *Cannot cancel a workflow re-run that has not yet queued* |
| `POST .../actions/runs/<id>/force-cancel` | `409` — same |
| `POST .../actions/runs/<id>/rerun` | `403` — *This workflow is already running* |

(The earlier close/reopen case returned `Server Error` from both cancel endpoints instead. Either
way: not cancellable.)

**The only fix is a new head commit**, which creates a fresh run and detaches the PR from the dead
one. Prefer a rebase onto `main` — it also brings the branch up to date, and the repo is squash-only
so the branch's own history is discarded at merge anyway:

```sh
git rebase origin/main
git push --force-with-lease origin <branch>
```

An empty commit (`git commit --allow-empty`) works too and avoids the force-push, if the branch is
shared or you would rather not rewrite it.

The dead run stays `queued` in the run list forever. That is cosmetic once nothing references it.

### Railway deploys are separate from CI

A green `Release` workflow does **not** mean the deploy succeeded. Railway builds from the branch
independently, so check it directly rather than inferring from GitHub:

```sh
railway status                    # "Deploy failed" shows here even while status is Online
railway deployment list --json    # per-deployment status, commit, and meta.configErrors
```

A failure inside Railway's own build orchestrator — e.g.
`StartSnapshotAndBuild UNKNOWN: failed to start workflow: context deadline exceeded` — is
infrastructure, not the commit. The service keeps serving the previous build (status stays `Online`),
so this fails quietly: the branch moved but the running code did not. Retry it with:

```sh
railway redeploy --from-source -y
```

`--from-source` is the important flag — a bare `railway redeploy` re-runs the *existing* deployment,
which is the older commit, not the one that failed to build.
