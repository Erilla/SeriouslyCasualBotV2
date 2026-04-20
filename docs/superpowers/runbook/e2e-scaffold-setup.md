# E2E test environment setup

The e2e suite reuses `.env` (existing bot creds). You only need to add a small `.env.test` with tester user IDs.

## 1. Ensure `.env` has the usual bot creds

The bot's regular `.env` (DISCORD_TOKEN, GUILD_ID, OFFICER_ROLE_ID, WOWAUDIT_API_SECRET, WARCRAFTLOGS_*, RAIDERIO_GUILD_IDS) is sufficient.

## 2. Create `.env.test`

Copy `.env.test.example` → `.env.test` and fill in tester user IDs. These must be real Discord users who have joined `GUILD_ID` from `.env`. A single user can fill all four slots while multi-voter flows remain unimplemented:

- `TESTER_PRIMARY_ID` — default actor for slash commands.
- `VOTER_A_ID` / `VOTER_B_ID` — distinct voters for application vote flows (same as primary for now is OK).
- `OFFICER_ID` — invoker for officer-gated commands. The referenced account must have the role identified by `OFFICER_ROLE_ID`.

`TEST_DB_PATH` defaults to `./tests/e2e/.data/test.db`. Override only if you need an alternate location.

## 3. Verify

```bash
npm run test:e2e -- tests/e2e/commands/ping.e2e.ts
```

If `verifyScaffold()` reports missing pieces, extend the guild or check that accounts have the required roles.
