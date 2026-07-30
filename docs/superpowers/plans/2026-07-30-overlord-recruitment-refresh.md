# Overlord Recruitment Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh the Recruitment embed whenever `/raiders` successfully adds or removes an Overlord.

**Architecture:** Keep `overlords.ts` database-only. Extend the two existing `/raiders` subcommand branches to call `updateRecruitment(interaction.client)` after a successful mutation, with a distinct persisted-but-refresh-failed response when Discord cannot update the message.

**Tech Stack:** Node.js 22+, TypeScript 6, discord.js 14, Vitest 4.

## Global Constraints

- Do not add a schema migration, event bus, or Discord dependency to `src/functions/raids/overlords.ts`.
- Call `updateRecruitment` only after a successful Overlord insert or delete.
- If refresh fails, retain and audit the completed database mutation; do not roll it back.
- A mutation failure must not trigger a Recruitment refresh.
- Keep all command replies ephemeral.

---

### Task 1: Refresh Recruitment after Overlord mutations

**Files:**
- Modify: `src/commands/raiders.ts:19,280-333`
- Create: `tests/unit/raidersOverlordRefresh.test.ts`

**Interfaces:**
- Consumes: `addOverlord(name: string, userId: string): void`, `removeOverlord(name: string): void`, and `updateRecruitment(client: Client): Promise<void>`.
- Produces: unchanged `/raiders add_overlord` and `/raiders remove_overlord` inputs with automatic targeted Recruitment refresh.

- [ ] **Step 1: Write failing command tests**

```ts
it('refreshes Recruitment after adding an Overlord', async () => {
  await command.execute(addInteraction as never);
  expect(addOverlord).toHaveBeenCalledWith('New Officer', '123');
  expect(updateRecruitment).toHaveBeenCalledWith(addInteraction.client);
  expect(addInteraction.reply).toHaveBeenCalledWith(
    expect.objectContaining({ content: expect.stringMatching(/Added overlord/i) }),
  );
});

it('keeps a saved change and reports a refresh failure', async () => {
  updateRecruitment.mockRejectedValue(new Error('guild-info unavailable'));
  await command.execute(removeInteraction as never);
  expect(removeOverlord).toHaveBeenCalledWith('Old Officer');
  expect(audit).toHaveBeenCalledWith(removeInteraction.user, 'removed overlord', expect.any(String));
  expect(removeInteraction.reply).toHaveBeenCalledWith(
    expect.objectContaining({ content: expect.stringMatching(/saved.*Recruitment.*not refreshed/i) }),
  );
});
```

Mock `requireOfficer`, `audit`, Overlord data functions, and
`updateRecruitment`. Cover successful add/remove, refresh failure after each
successful mutation, and add/remove mutation failures that never call the
refresh function.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- tests/unit/raidersOverlordRefresh.test.ts`

Expected: FAIL because `raiders.ts` does not import or call
`updateRecruitment`.

- [ ] **Step 3: Implement post-mutation targeted refresh**

```ts
addOverlord(name, user.id);
try {
  await updateRecruitment(interaction.client);
} catch (error) {
  await audit(interaction.user, 'added overlord', `${name} (<@${user.id}>)`);
  await interaction.reply({
    content: `Added overlord **${name}**, but Recruitment was not refreshed. Run /guildinfo to retry.`,
    flags: MessageFlags.Ephemeral,
  });
  return;
}
```

Apply the same structure to removal, retaining the existing looked-up user ID
in its audit detail. Log refresh failures with the `guild-info` logger before
replying. Keep the existing broad mutation `try`/`catch` behavior, but place
the refresh in a nested `try` so a Discord failure cannot be misreported as a
failed database mutation.

- [ ] **Step 4: Run focused, full, type, and lint checks**

Run: `npm test -- tests/unit/raidersOverlordRefresh.test.ts && npm test && npm run typecheck && npm run lint`

Expected: PASS. Verify each success path calls exactly one Recruitment refresh
and each refresh-failure path audits the persisted mutation while responding
ephemerally with the retry instruction.

- [ ] **Step 5: Commit the behavior and tests**

```bash
git add src/commands/raiders.ts tests/unit/raidersOverlordRefresh.test.ts && git commit -m "feat(overlords): refresh recruitment after changes"
```

## Plan self-review

The plan covers both Overlord mutation call sites, the required failure
semantics, audit behavior, and regression coverage. It preserves the existing
database boundary, adds no schema change, and uses the same
`updateRecruitment` interface already used by Guild Info refresh flows.
