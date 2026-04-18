# Sandbox guild scaffold setup (e2e tests)

One-time manual provisioning for the Discord server that backs `npm run test:e2e`.

## 1. Create a dedicated guild

- Create a new Discord server. Do NOT use the production guild.
- Community features: enable (forum channels require it).
- Record the guild ID; put it in `.env.test` as `SANDBOX_GUILD_ID`.

## 2. Create a bot application

- Discord Developer Portal → New Application → Bot → reset token.
- Put token in `.env.test` as `DISCORD_TOKEN_TEST`.
- OAuth2 URL generator → scopes: `bot`, `applications.commands`; permissions: Administrator (fine for a sandbox).
- Invite the bot to the sandbox guild.
- Run `npm run deploy-commands` with `GUILD_ID` pointing at the sandbox guild to register commands.

## 3. Create tester members

Invite four real user accounts to the sandbox guild (burner accounts are fine). Note each user ID and populate:

- `TESTER_PRIMARY_ID`
- `VOTER_A_ID`
- `VOTER_B_ID`
- `OFFICER_ID`

Give `OFFICER_ID` the officer role that `requireOfficer` checks for in `src/commands/utils.ts`.

## 4. Provision channels and roles

Run the bot locally against the sandbox guild, then use `/setup` to create the expected channel structure. Record the resulting channel IDs in `.env.test` — names and required IDs expand as e2e tests grow; keep this section in sync.

## 5. External API credentials

- `RAIDERIO_API_KEY` — raider.io API key.
- `WOWAUDIT_API_KEY` — wowaudit API key.

## 6. Verify

```bash
npm run test:e2e -- tests/e2e/commands/ping.e2e.ts
```

If `verifyScaffold()` reports missing pieces, add them.
