# Contributing

## Dev Setup

```bash
git clone https://github.com/your-org/SeriouslyCasualBotV2.git
cd SeriouslyCasualBotV2
npm install
cp .env.example .env   # fill in values for a dev Discord server
npm run dev            # tsx watch — auto-restarts on file changes
```

Run `npm run deploy-commands` after adding or renaming slash commands.

## Branch Strategy

- `main` — the trunk; auto-deploys to the **test** environment for soak testing.
- `prod` — the release branch; always reflects what's live in production. Only
  ever fast-forwarded from `main`; force-pushes and deletion are blocked, and a
  push is rejected unless the commit's `ci` check already passed.
- Feature branches: `feat/<short-description>` (e.g. `feat/raid-signups`)
- Bug fixes: `fix/<short-description>`
- Tasks follow the PRD task numbering: implement one task per branch/PR

See [`deployment.md`](deployment.md) for the full environment/promotion topology.

## Worktree Usage

The project uses git worktrees to develop tasks in isolation without switching branches.

```bash
# Create a worktree for a new task
git worktree add ../SeriouslyCasualBotV2-worktrees/feat-my-task -b feat/my-task

# List active worktrees
git worktree list

# Remove when done
git worktree remove ../SeriouslyCasualBotV2-worktrees/feat-my-task
```

Each worktree shares the same git history but has an independent working directory and can run `npm run dev` independently.

## PR Flow

1. Create a branch and worktree for the task.
2. Implement the feature; commit logical units with clear messages.
3. Open a PR targeting `main`.
4. CI must pass (typecheck + tests + build).
5. Claude Code Review runs automatically and posts inline comments.
6. Address review feedback, then merge to `main` (auto-deploys to test).
7. Once validated on test, promote with a fast-forward push:
   `git push origin origin/main:prod` (auto-deploys to production).

## Testing Strategy

Tests live in `tests/`. Run with:

```bash
npm test           # run all unit tests once
npm run test:watch # watch mode during development
```

- **Unit tests** cover pure functions and utility helpers (no Discord client, no DB).
- **Integration tests** (`npm run test:integration`) test DB logic against a real SQLite in-memory database.
  `npm test` already includes these — its globs are `tests/unit/**` *and* `tests/integration/**`, so
  `test:integration` is a subset for running them alone, not extra coverage.
- **E2E tests** (`npm run test:e2e`) are NOT part of `npm test` and need a `.env.test` plus a live
  test guild. They do not run in CI, so assertions about a handler's reply shape can rot unnoticed —
  if you change one, check `tests/e2e/` by hand.
- Aim for test coverage on all business logic in `src/functions/` and `src/services/`.
- Do not mock the database in unit tests — use in-memory SQLite instead.

### Previewing Discord output without deploying

Some output is only awkward to reach on a live bot — an application that named no character, a
character Raider.IO cannot resolve. `npm run preview:intel` prints the real embeds and job-row
transitions for those states offline, using the production renderer against in-memory SQLite:

```bash
npm run preview:intel   # scripts/preview-linked-intel.mts
```

Scripts under `scripts/` are outside the build (`rootDir` is `src/`) but still import production
modules, so `npm run typecheck` checks them via `tsconfig.scripts.json`. Without that they would
break silently the first time a signature they use changed.

## Code Style

- Formatting is handled by Prettier (`.prettierrc.json`). Run `npm run format`
  to apply it and `npm run format:check` to verify; CI runs the check and fails
  on drift, so format before pushing.
- Lint with `npm run lint` (ESLint flat config in `eslint.config.js`).
- TypeScript strict mode; no `any` unless unavoidable.
- ESM imports with `.js` extensions (required for Node16 module resolution).
- Use `asSendable()` to narrow channel types before sending messages.
- Use `MessageFlags.Ephemeral` instead of the deprecated `ephemeral: true`.
