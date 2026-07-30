# Guild Info Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let officers edit all currently seeded Guild Info content with prefilled modals, while making normal `/guildinfo` refreshes update the four managed messages in place.

**Architecture:** A shared managed-message helper owns the `guild_info_messages` lookup, update-or-create fallback, and force-delete lifecycle. Renderers supply Discord payloads to that helper; a database-backed editor module maps fixed command choices to existing rows, and a command/modal pair handles user input and targeted refreshes.

**Tech Stack:** Node.js 22+, TypeScript 6, discord.js 14, better-sqlite3, Vitest 4.

## Global Constraints

- Do not add a database migration; `guild_info_messages` already holds the required message IDs.
- The managed keys are exactly `aboutus`, `schedule`, `recruitment`, and `achievements`.
- Normal refreshes edit in place; only a missing or Discord-unknown message ID creates a replacement and upserts its ID.
- `force:true` may delete only those four tracked messages and must not scan or delete other channel messages.
- Preserve Discord Markdown and store `{{OVERLORDS}}` literally until the Recruitment renderer substitutes it.
- Editing requires both the Administrator default permission and the existing officer-role runtime checks.
- Editable rows are fixed: About Us, schedule config, Wednesday/Sunday, four recruitment rows, three links, and the achievements title.
- Accept only `http:` or `https:` link URLs.

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/functions/guild-info/managedGuildInfoMessage.ts` | Managed key type and update-or-create lifecycle. |
| `src/functions/guild-info/clearGuildInfo.ts` | Guild Info channel lookup and managed-only forced cleanup. |
| `src/functions/guild-info/update{AboutUs,Schedule,Recruitment,Achievements}.ts` | Render the four messages through the shared lifecycle. |
| `src/functions/guild-info/editableGuildInfo.ts` | Fixed choice mappings and parameterized DB reads/writes. |
| `src/commands/guildinfo.ts` | Normal in-place refresh and `force:true`. |
| `src/commands/editguildinfo.ts` | Prefilled editor modals. |
| `src/interactions/guildInfo.ts` | Modal persistence, targeted update, audit, and reply. |
| `src/interactions/registry.ts` | Modal-handler registration. |
| `tests/unit/*.test.ts`, `tests/e2e/commands/*.e2e.ts` | Lifecycle, editor, and end-to-end behavior. |
| `docs/commands.md` | User-facing command documentation. |

### Task 1: Managed Guild Info message lifecycle

**Files:**
- Create: `src/functions/guild-info/managedGuildInfoMessage.ts`
- Modify: `src/functions/guild-info/clearGuildInfo.ts:1-62`
- Create: `tests/unit/managedGuildInfoMessage.test.ts`

**Interfaces:**
- Produces `type ManagedGuildInfoKey = 'aboutus' | 'schedule' | 'recruitment' | 'achievements'`.
- Produces `upsertGuildInfoMessage(channel: TextChannel, key: ManagedGuildInfoKey, payload: MessageCreateOptions & MessageEditOptions): Promise<void>`.
- Retains `clearGuildInfo(client)` as the forced-rebuild cleanup entry point, but limits it to managed rows.

- [ ] **Step 1: Write the failing lifecycle tests**

```ts
it('edits the stored message instead of sending a replacement', async () => {
  db.prepare('INSERT INTO guild_info_messages (key, message_id) VALUES (?, ?)').run('aboutus', 'old');
  const oldMessage = { edit: vi.fn().mockResolvedValue(undefined) };
  const channel = { messages: { fetch: vi.fn().mockResolvedValue(oldMessage) }, send: vi.fn() };

  await upsertGuildInfoMessage(channel as never, 'aboutus', { content: 'new' });

  expect(oldMessage.edit).toHaveBeenCalledWith({ content: 'new' });
  expect(channel.send).not.toHaveBeenCalled();
});

it('sends and repairs the row when Discord reports UnknownMessage', async () => {
  const channel = unknownMessageChannel('stale', { id: 'replacement' });
  await upsertGuildInfoMessage(channel as never, 'schedule', { content: 'new' });
  expect(channel.send).toHaveBeenCalledOnce();
  expect(storedId('schedule')).toBe('replacement');
});
```

Add forced-clear coverage with four tracked rows and one unrelated message.
Assert only the four `messages.delete(id)` calls occur and all four rows are
removed. Unknown Message is already absent; a non-404 error rejects and does
not delete later rows.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/managedGuildInfoMessage.test.ts`

Expected: FAIL because the helper module and exports do not exist.

- [ ] **Step 3: Implement the helper and safe forced clear**

```ts
export const MANAGED_GUILD_INFO_KEYS = [
  'aboutus',
  'schedule',
  'recruitment',
  'achievements',
] as const;
export type ManagedGuildInfoKey = (typeof MANAGED_GUILD_INFO_KEYS)[number];

export async function upsertGuildInfoMessage(
  channel: TextChannel,
  key: ManagedGuildInfoKey,
  payload: MessageCreateOptions & MessageEditOptions,
): Promise<void> {
  const row = getDatabase()
    .prepare('SELECT message_id FROM guild_info_messages WHERE key = ?')
    .get(key) as GuildInfoMessageRow | undefined;
  if (row) {
    try {
      await (await channel.messages.fetch(row.message_id)).edit(payload);
      return;
    } catch (error) {
      if (!isUnknownMessage(error)) throw error;
    }
  }
  const message = await channel.send(payload);
  getDatabase().prepare('INSERT OR REPLACE INTO guild_info_messages (key, message_id) VALUES (?, ?)').run(key, message.id);
}
```

Implement `isUnknownMessage` using `DiscordAPIError` and
`RESTJSONErrorCodes.UnknownMessage`. In `clearGuildInfo`, query only the four
keys, delete each stored message individually, ignore only Unknown Message,
then use a parameterized `DELETE ... WHERE key IN (?,?,?,?)`. Delete the
existing channel-wide fetch/bulk-delete implementation entirely.

- [ ] **Step 4: Run focused and default tests**

Run: `npm test -- tests/unit/managedGuildInfoMessage.test.ts && npm test`

Expected: PASS; the tests cover update, stale-ID replacement, safe deletion,
and non-404 propagation.

- [ ] **Step 5: Commit the lifecycle unit**

```bash
git add src/functions/guild-info/managedGuildInfoMessage.ts src/functions/guild-info/clearGuildInfo.ts tests/unit/managedGuildInfoMessage.test.ts && git commit -m "feat(guild-info): manage tracked messages in place"
```

### Task 2: Move all four renderers onto the shared lifecycle

**Files:**
- Modify: `src/functions/guild-info/updateAboutUs.ts:1-78`
- Modify: `src/functions/guild-info/updateSchedule.ts:1-60`
- Modify: `src/functions/guild-info/updateRecruitment.ts:1-97`
- Modify: `src/functions/guild-info/updateAchievements.ts:1-68`
- Create: `tests/unit/guildInfoRenderers.test.ts`
- Modify: `tests/unit/updateRecruitment.test.ts:1-67`

**Interfaces:**
- Consumes `upsertGuildInfoMessage` from Task 1.
- Keeps every renderer's public signature as `updateX(client: Client): Promise<void>`.
- Removes direct `guild_info_messages` writes from the renderers.

- [ ] **Step 1: Write failing renderer-delegation tests**

```ts
it.each([
  ['aboutus', updateAboutUs],
  ['schedule', updateSchedule],
  ['recruitment', updateRecruitment],
])('%s delegates its payload to the managed-message helper', async (key, update) => {
  await update({} as Client);
  expect(upsertGuildInfoMessage).toHaveBeenCalledWith(channel, key, expect.any(Object));
});

it('clears About Us components when the database has no links', async () => {
  deleteAllLinks();
  await updateAboutUs({} as Client);
  expect(upsertGuildInfoMessage).toHaveBeenCalledWith(
    channel,
    'aboutus',
    expect.objectContaining({ components: [] }),
  );
});
```

Mock the achievements data/canvas functions and assert its attachment payload
uses key `achievements`. Keep the Recruitment Apply Here test but inspect the
payload passed to the helper instead of a direct channel send.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/guildInfoRenderers.test.ts tests/unit/updateRecruitment.test.ts`

Expected: FAIL because three renderers call `channel.send` and Achievements
owns separate ID logic.

- [ ] **Step 3: Delegate all renderer payloads**

```ts
await upsertGuildInfoMessage(channel, 'schedule', { embeds: [embed] });
await upsertGuildInfoMessage(channel, 'recruitment', {
  embeds: [embed],
  components: [row],
  allowedMentions: { users: [] },
});
await upsertGuildInfoMessage(channel, 'achievements', {
  content: `**${title}**`,
  embeds: [],
  files: [attachment],
});
```

For About Us, supply `components: []` when there are no links so an existing
button row is removed. Preserve Achievements' current order: build its model
and image before the helper call, so API/canvas failures leave the old message
untouched.

- [ ] **Step 4: Run renderer regression tests**

Run: `npm test -- tests/unit/guildInfoRenderers.test.ts tests/unit/updateRecruitment.test.ts tests/unit/achievementsData.test.ts tests/unit/achievementsRender.test.ts`

Expected: PASS; no renderer writes a message ID directly.

- [ ] **Step 5: Commit renderer integration**

```bash
git add src/functions/guild-info/updateAboutUs.ts src/functions/guild-info/updateSchedule.ts src/functions/guild-info/updateRecruitment.ts src/functions/guild-info/updateAchievements.ts tests/unit/guildInfoRenderers.test.ts tests/unit/updateRecruitment.test.ts && git commit -m "refactor(guild-info): share message update lifecycle"
```

### Task 3: Make `/guildinfo` in-place by default and add `force:true`

**Files:**
- Modify: `src/commands/guildinfo.ts:1-36`
- Create: `tests/unit/guildinfoCommand.test.ts`
- Modify: `tests/e2e/commands/guildinfo.e2e.ts:8-85`

**Interfaces:**
- Consumes `clearGuildInfo(client)` from Task 1 and the four `updateX(client)` renderers from Task 2.
- Produces `/guildinfo force:<boolean>`, with `false` when omitted.

- [ ] **Step 1: Write failing command-path tests**

```ts
it('normally refreshes all renderers without clearing their tracked messages', async () => {
  await command.execute(fakeInteraction({ force: null }) as never);
  expect(clearGuildInfo).not.toHaveBeenCalled();
  expect(updateAboutUs).toHaveBeenCalledWith(client);
  expect(updateSchedule).toHaveBeenCalledWith(client);
  expect(updateRecruitment).toHaveBeenCalledWith(client);
  expect(updateAchievements).toHaveBeenCalledWith(client);
});

it('clears managed messages before rendering when force:true is supplied', async () => {
  await command.execute(fakeInteraction({ force: true }) as never);
  expect(clearGuildInfo.mock.invocationCallOrder[0]).toBeLessThan(
    updateAboutUs.mock.invocationCallOrder[0]!,
  );
});
```

Mock the permission check, audit, cleanup, and four renderers. Assert the
builder has an optional boolean `force` and audit detail distinguishes a
forced rebuild from the normal `all embeds` refresh.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/guildinfoCommand.test.ts`

Expected: FAIL because the builder has no `force` option and all current
invocations clear first.

- [ ] **Step 3: Add the boolean option and conditional cleanup**

```ts
.addBooleanOption((option) =>
  option
    .setName('force')
    .setDescription('Delete and recreate the four managed Guild Info messages')
    .setRequired(false),
)

const force = interaction.options.getBoolean('force') ?? false;
if (force) await clearGuildInfo(interaction.client);
await updateAboutUs(interaction.client);
await updateSchedule(interaction.client);
await updateRecruitment(interaction.client);
await updateAchievements(interaction.client);
```

Keep the existing ephemeral acknowledgement. Audit normal refreshes as `all
embeds` and forced ones as `all embeds (force rebuild)`. Update the E2E
second-invocation test: query the four `guild_info_messages` rows before and
after it and assert all IDs are unchanged. Add a `force:true` E2E case that
asserts those four IDs change while an independently posted channel message
remains fetchable.

- [ ] **Step 4: Run command and Guild Info E2E tests**

Run: `npm test -- tests/unit/guildinfoCommand.test.ts && npm run test:e2e -- tests/e2e/commands/guildinfo.e2e.ts`

Expected: PASS. Normal repetition preserves IDs; forced refresh changes only
the tracked IDs and leaves unrelated content intact.

- [ ] **Step 5: Commit command behavior**

```bash
git add src/commands/guildinfo.ts tests/unit/guildinfoCommand.test.ts tests/e2e/commands/guildinfo.e2e.ts && git commit -m "feat(guild-info): add safe force refresh"
```

### Task 4: Add fixed-row Guild Info editor persistence

**Files:**
- Create: `src/functions/guild-info/editableGuildInfo.ts`
- Create: `tests/unit/editableGuildInfo.test.ts`

**Interfaces:**
- Produces `type RecruitmentChoice = 'who' | 'want' | 'give' | 'contact'`.
- Produces `type ScheduleDayChoice = 'wednesday' | 'sunday'` and `type LinkChoice = 'raiderio' | 'wowprogress' | 'warcraftlogs'`.
- Produces reads/writes for About Us, schedule config/day, recruitment, links, and achievements title.
- Produces `validateGuildInfoUrl(value: string): string` that accepts only HTTP(S) URLs.

- [ ] **Step 1: Write failing persistence and validation tests**

```ts
it('updates only the selected seeded recruitment row', () => {
  expect(saveRecruitmentSection('want', 'Wanted', '**Be prepared.**')).toBe(true);
  expect(contentRow('recruitment_want')).toMatchObject({ title: 'Wanted', content: '**Be prepared.**' });
  expect(contentRow('recruitment_give')!.content).toContain('stable mythic');
});

it('maps Warcraft Logs to the third link row by id order', () => {
  expect(getGuildInfoLink('warcraftlogs')?.label).toBe('Warcraft Logs');
});

it.each(['mailto:officer@example.test', 'ftp://example.test', 'not a url'])
('rejects non-HTTP(S) links', (value) => {
  expect(() => validateGuildInfoUrl(value)).toThrow(/http or https/i);
});
```

Cover every getter/setter, an absent selected record returning `null` or
`false`, whitespace-only title/body/day/time/label rejection, raw Markdown
retention, and storing `Contact {{OVERLORDS}}` literally.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/editableGuildInfo.test.ts`

Expected: FAIL because the module and its fixed choice mappings do not exist.

- [ ] **Step 3: Implement fixed mappings and parameterized operations**

```ts
const RECRUITMENT_KEYS = {
  who: 'recruitment_who',
  want: 'recruitment_want',
  give: 'recruitment_give',
  contact: 'recruitment_contact',
} as const;
const SCHEDULE_SORT_ORDERS = { wednesday: 1, sunday: 2 } as const;
const LINK_OFFSETS = { raiderio: 0, wowprogress: 1, warcraftlogs: 2 } as const;

export function saveRecruitmentSection(choice: RecruitmentChoice, title: string, content: string): boolean {
  return getDatabase()
    .prepare('UPDATE guild_info_content SET title = ?, content = ? WHERE key = ?')
    .run(requireText(title, 'Section heading'), requireText(content, 'Section body'), RECRUITMENT_KEYS[choice])
    .changes === 1;
}
```

Use `requireText` for each required field while saving the original nonblank
Markdown body. Read links with `ORDER BY id LIMIT 1 OFFSET ?`, using fixed
offsets 0, 1, and 2; this remains stable after labels or URLs change. Map days
to `sort_order` 1 and 2. Never insert any editable row.

- [ ] **Step 4: Run persistence and schema tests**

Run: `npm test -- tests/unit/editableGuildInfo.test.ts && npm run test:integration -- tests/integration/database-schema.test.ts`

Expected: PASS against the existing schema, with bound parameters in every
write.

- [ ] **Step 5: Commit editor persistence**

```bash
git add src/functions/guild-info/editableGuildInfo.ts tests/unit/editableGuildInfo.test.ts && git commit -m "feat(guild-info): add editable seeded content"
```

### Task 5: Add `/editguildinfo` modals and targeted refresh handling

**Files:**
- Create: `src/commands/editguildinfo.ts`
- Create: `src/interactions/guildInfo.ts`
- Modify: `src/interactions/registry.ts:8-12,77`
- Create: `tests/unit/editGuildInfoCommand.test.ts`
- Create: `tests/unit/interactions/guildInfo.test.ts`
- Modify: `tests/unit/interactions/registry.test.ts:1-30`

**Interfaces:**
- Consumes Task 4 reads/writes and choice types.
- Consumes Task 2 renderer functions.
- Produces an `editguildinfo` slash command with six subcommands and `guildinfo-edit:*` modal IDs.
- Produces an officer-only `modals: ModalHandler[]` entry registered in `registry.ts`.

- [ ] **Step 1: Write failing command and modal-handler tests**

```ts
it('opens a prefilled contact-section modal', async () => {
  await editGuildInfo.execute(fakeChatInteraction('recruitment', { section: 'contact' }) as never);
  expect(interaction.__modalShown!.data.custom_id).toBe('guildinfo-edit:recruitment:contact');
  expect(inputValue(interaction.__modalShown!, 'content')).toBe('Contact {{OVERLORDS}} if you have any questions.');
});

it('saves a link then refreshes only About Us', async () => {
  await guildInfoModals[0]!.handle(fakeModal({
    customId: 'guildinfo-edit:link:raiderio',
    fields: { label: 'RIO', url: 'https://raider.io/guilds/eu/silvermoon/SeriouslyCasual' },
  }) as never, ['link', 'raiderio']);
  expect(updateAboutUs).toHaveBeenCalledOnce();
  expect(updateSchedule).not.toHaveBeenCalled();
  expect(updateRecruitment).not.toHaveBeenCalled();
  expect(updateAchievements).not.toHaveBeenCalled();
});
```

Test all six command routes for selected record, custom ID, and prefilled
values. Through `dispatch(modalHandlers, ...)`, test a non-officer modal is
denied before any write. Test an invalid URL has an ephemeral validation reply
and no refresh. Test a renderer rejection after a successful write preserves
the saved data and says it could not refresh the Guild Info message.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/editGuildInfoCommand.test.ts tests/unit/interactions/guildInfo.test.ts tests/unit/interactions/registry.test.ts`

Expected: FAIL because the command, handler, and registry entry do not exist.

- [ ] **Step 3: Implement command, modals, and submission handling**

```ts
data: new SlashCommandBuilder()
  .setName('editguildinfo')
  .setDescription('Edit Guild Info embed content')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) => sub.setName('about').setDescription('Edit About Us'))
  .addSubcommand((sub) => sub.setName('schedule-config').setDescription('Edit schedule title and timezone'))
  .addSubcommand((sub) => sub.setName('schedule-day').setDescription('Edit a seeded schedule day')
    .addStringOption((option) => option.setName('day').setRequired(true).addChoices(
      { name: 'Wednesday', value: 'wednesday' }, { name: 'Sunday', value: 'sunday' },
    )))
```

Add `recruitment` choices `who/want/give/contact`, `link` choices
`raiderio/wowprogress/warcraftlogs`, and `achievements`. Check the existing
command `requireOfficer` before every `showModal`. Use no more than two
required inputs per modal: `title`/`content`, `day`/`time`, or `label`/`url`;
set each initial value with `.setValue(...)`.

Register one `guildinfo-edit` modal handler with `officerOnly: true`. Parse
only the known IDs, call the matching Task 4 write, then select exactly one
renderer: About Us for `about`/`link`, Schedule for config/day, Recruitment
for recruitment, and Achievements for achievements. After a successful save,
defer an ephemeral reply; on success audit `updated guild info` with a short
target and edit to `<target> updated.`. On renderer failure log it and edit to
`Saved, but the Guild Info message could not be refreshed. Run /guildinfo to retry.`

- [ ] **Step 4: Run modal, command, registry, and type checks**

Run: `npm test -- tests/unit/editGuildInfoCommand.test.ts tests/unit/interactions/guildInfo.test.ts tests/unit/interactions/registry.test.ts && npm run typecheck`

Expected: PASS. The new prefix has no collision and every command or modal
outcome is ephemeral.

- [ ] **Step 5: Commit the editor UI**

```bash
git add src/commands/editguildinfo.ts src/interactions/guildInfo.ts src/interactions/registry.ts tests/unit/editGuildInfoCommand.test.ts tests/unit/interactions/guildInfo.test.ts tests/unit/interactions/registry.test.ts && git commit -m "feat(guild-info): add modal editor command"
```

### Task 6: Document commands and verify the complete workflow

**Files:**
- Modify: `docs/commands.md:32-33,64-75`
- Create: `tests/e2e/commands/editguildinfo.e2e.ts`

**Interfaces:**
- Consumes the complete command/modal flow from Tasks 1-5.
- Produces operator documentation and an end-to-end test of a prefilled save with an in-place update.

- [ ] **Step 1: Write the failing editor E2E test**

```ts
it('edits About Us through a prefilled modal without changing its message ID', async () => {
  await guildinfoCmd.execute(refreshInteraction as never);
  const before = storedId('aboutus');

  await editGuildInfoCmd.execute(editInteraction('about') as never);
  expect(inputValue(editInteraction.__modalShown!, 'content')).toContain('two-day Alliance');

  await dispatch(modalHandlers, 'modal', aboutModal('A changed body') as never, 'guildinfo-edit:about');
  expect(contentRow('aboutus')!.content).toBe('A changed body');
  expect(storedId('aboutus')).toBe(before);
});
```

Use `resetAndSeed({ discord: true })` so the stored ID references a real
sandbox message. Add an invalid-link case asserting that both its row and the
About Us message ID remain unchanged.

- [ ] **Step 2: Run the E2E test to verify it fails**

Run: `npm run test:e2e -- tests/e2e/commands/editguildinfo.e2e.ts`

Expected: FAIL until the loaded command and interaction registry expose the
new workflow.

- [ ] **Step 3: Document exact command behavior**

```markdown
| `/guildinfo` | Refresh all four managed Guild Info messages in place. Use `force:true` to delete and recreate only those four messages. | Yes | No |
| `/editguildinfo about / schedule-config / schedule-day / recruitment / link / achievements` | Open a prefilled modal to edit a seeded Guild Info value; saving refreshes only its affected message. | Yes | No |
```

Add a `/editguildinfo` detail subsection with fixed choices,
`{{OVERLORDS}}` behavior, HTTP(S)-only links, and the no-add/remove/reorder
constraint. Retain the existing deployment instruction; run `npm run
deploy-commands` manually only after code is merged and an operator is ready
to update Discord's registered commands.

- [ ] **Step 4: Run complete verification**

Run: `npm test && npm run typecheck && npm run lint && npm run test:e2e -- tests/e2e/commands/guildinfo.e2e.ts tests/e2e/commands/editguildinfo.e2e.ts`

Expected: PASS. Run `git diff --check`; E2E must prove normal ID retention,
forced/targeted changes, and unrelated-message safety.

- [ ] **Step 5: Commit documentation and E2E coverage**

```bash
git add docs/commands.md tests/e2e/commands/editguildinfo.e2e.ts && git commit -m "docs(guild-info): document embed editor"
```

## Plan self-review

### Spec coverage

- Prefilled edits for every seeded value: Tasks 4 and 5.
- In-place refresh, stale-ID recovery, and managed-only forced cleanup: Tasks 1-3.
- No migration, existing message-ID table, and no dynamic row management: Global Constraints and Task 4.
- Administrator/officer checks, Markdown/token handling, URL validation, and saved-but-refresh-failed feedback: Tasks 4 and 5.
- Unit, E2E, and user documentation: Tasks 1-6.

### Placeholder and type consistency check

Every new file, helper, managed key, selection value, modal prefix, test
command, and commit is explicit. `upsertGuildInfoMessage`, `clearGuildInfo`,
and `guildinfo-edit` use the same names throughout. The plan neither introduces
a schema migration nor permits channel-wide deletion, unbounded row edits, or
an unvalidated URL path.
