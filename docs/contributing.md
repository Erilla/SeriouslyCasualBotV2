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

- `master` — always deployable; direct pushes are blocked
- Feature branches: `feat/<short-description>` (e.g. `feat/epgp-commands`)
- Bug fixes: `fix/<short-description>`
- Tasks follow the PRD task numbering: implement one task per branch/PR

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
3. Open a PR targeting `master`.
4. CI must pass (typecheck + tests + build).
5. Claude Code Review runs automatically and posts inline comments.
6. Address review feedback, then merge.

## Testing Strategy

Tests live in `tests/`. Run with:

```bash
npm test           # run all unit tests once
npm run test:watch # watch mode during development
```

- **Unit tests** cover pure functions and utility helpers (no Discord client, no DB).
- **Integration tests** (`npm run test:integration`) test DB logic against a real SQLite in-memory database.
- Aim for test coverage on all business logic in `src/functions/` and `src/services/`.
- Do not mock the database in unit tests — use in-memory SQLite instead.

## Code Style

- TypeScript strict mode; no `any` unless unavoidable.
- ESM imports with `.js` extensions (required for Node16 module resolution).
- Use `asSendable()` to narrow channel types before sending messages.
- Use `MessageFlags.Ephemeral` instead of the deprecated `ephemeral: true`.
