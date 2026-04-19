/**
 * Flow: loot priority claim (button click → DB write).
 *
 * Strategy
 * --------
 * The loot button handler (interactionCreate.ts, `loot:` prefix) calls
 * `updateLootResponse()` then tries to edit the Discord message via
 * `updateLootPost()`.  `updateLootPost()` catches its own fetch errors and
 * only logs them, so with DB-only seeding (mock channel/message IDs) the DB
 * write still succeeds cleanly.
 *
 * We invoke `updateLootResponse()` directly — the same layer the vote-flow
 * test uses for `voteOnApplication()` — rather than wiring a full
 * ButtonInteraction through interactionCreate.  The function is a pure
 * DB + Discord-update unit: testing it directly avoids the need for a real
 * loot channel and validates the core claim→DB path.
 *
 * Because the handler requires a raider with `discord_user_id` matching the
 * claimant, we manually link `ctx.tester` (and `ctx.voterA`) to seeded
 * raiders before each test.
 *
 * Discord-side deferred items
 * ---------------------------
 * - The `interaction.update()` call that refreshes the embed in the live
 *   channel is NOT exercised here (requires a real loot channel message).
 *   That path is covered by manual sandbox smoke-testing.
 * - A full button-dispatch path through `fakeButton` + interactionCreate
 *   would need a real `Message` from the loot channel.  That requires
 *   `discord: true` seeding AND `loot_channel_id` configured in the sandbox
 *   config table.  Those prerequisites are optional in CI, so we defer.
 *
 * Assertions
 * ----------
 * 1. A `loot_responses` row is created when a raider claims "major".
 * 2. Claiming a different type (e.g. "minor") from the same user upserts:
 *    exactly one row per user per loot post, with the latest response_type.
 * 3. Two different raiders claiming the same boss each get their own row.
 * 4. Claiming a boss that has no loot_post returns silently (no throw, no row).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { getE2EContext } from '../setup/bootstrap.js';
import { resetAndSeed } from '../setup/baseline.js';
import { queryOne, queryAll } from '../setup/assertions.js';
import { getDatabase } from '../../../src/database/db.js';
import { updateLootResponse } from '../../../src/functions/loot/updateLootResponse.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LootPostRow {
  id: number;
  boss_id: number;
  boss_name: string;
}

interface LootResponseRow {
  id: number;
  loot_post_id: number;
  user_id: string;
  response_type: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the seeded loot post for the given boss_id. */
function getLootPost(bossId: number): LootPostRow | undefined {
  return queryOne<LootPostRow>(
    'SELECT id, boss_id, boss_name FROM loot_posts WHERE boss_id = ?',
    [bossId],
  );
}

/** Return all loot_responses rows for a given loot_post_id. */
function getResponses(lootPostId: number): LootResponseRow[] {
  return queryAll<LootResponseRow>(
    'SELECT * FROM loot_responses WHERE loot_post_id = ?',
    [lootPostId],
  );
}

/**
 * Link a Discord user ID to an existing seeded raider (by row index, 0-based).
 *
 * seedRaiders inserts 15 raiders without discord_user_id.  The loot button
 * handler checks `raiders WHERE discord_user_id = ?`, so we must set this
 * before invoking updateLootResponse.
 */
function linkRaiderToUser(userId: string, raiderIndex = 0): void {
  const db = getDatabase();
  // Clear any previous link for this user (avoid UNIQUE conflicts across tests).
  db.prepare("UPDATE raiders SET discord_user_id = NULL WHERE discord_user_id = ?").run(userId);

  const raider = db
    .prepare('SELECT id FROM raiders ORDER BY id LIMIT 1 OFFSET ?')
    .get(raiderIndex) as { id: number } | undefined;

  if (!raider) {
    throw new Error(`No raider found at index ${raiderIndex} — ensure raiders are seeded first`);
  }

  db.prepare('UPDATE raiders SET discord_user_id = ? WHERE id = ?').run(userId, raider.id);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Boss IDs seeded by seedLoot (99901–99903).
const BOSS_A = 99901;
const BOSS_B = 99902;

describe('loot-award — claim flow', () => {
  beforeEach(async () => {
    // DB-only: mock channel/message IDs are fine because updateLootPost()
    // catches its own fetch errors and returns silently.
    await resetAndSeed({ discord: false });
  });

  // =========================================================================
  // 1. Single claim creates a loot_responses row
  // =========================================================================

  it('records a "major" claim for a raider who clicks the Major button', async () => {
    const ctx = getE2EContext();

    // Ensure the loot post exists.
    const post = getLootPost(BOSS_A);
    expect(post, 'loot post for boss 99901 must exist after seed').toBeDefined();

    // Link tester to a seeded raider.
    linkRaiderToUser(ctx.tester.id, 0);

    // Invoke the core loot response writer directly (same layer tested by vote-flow).
    await updateLootResponse(ctx.client, 'major', BOSS_A, ctx.tester.id);

    // Assert DB.
    const responses = getResponses(post!.id);
    const testerResponse = responses.find((r) => r.user_id === ctx.tester.id);
    expect(testerResponse, 'response row for tester must exist').toBeDefined();
    expect(testerResponse!.response_type).toBe('major');
  });

  // =========================================================================
  // 2. Toggle / upsert — clicking a different button replaces the first claim
  // =========================================================================

  it('upserts — a second claim from the same raider replaces the first', async () => {
    const ctx = getE2EContext();

    const post = getLootPost(BOSS_A);
    expect(post, 'loot post for boss 99901 must exist').toBeDefined();

    linkRaiderToUser(ctx.tester.id, 0);

    // First claim: "major".
    await updateLootResponse(ctx.client, 'major', BOSS_A, ctx.tester.id);

    // Second claim: "minor" (should replace, not duplicate).
    await updateLootResponse(ctx.client, 'minor', BOSS_A, ctx.tester.id);

    // Exactly one row for this user on this post; response_type is the latest.
    const responses = getResponses(post!.id);
    const userRows = responses.filter((r) => r.user_id === ctx.tester.id);
    expect(userRows).toHaveLength(1);
    expect(userRows[0]!.response_type).toBe('minor');
  });

  // =========================================================================
  // 3. Two different raiders each get their own row on the same boss
  // =========================================================================

  it('records independent rows for two different raiders on the same boss', async () => {
    const ctx = getE2EContext();

    const post = getLootPost(BOSS_A);
    expect(post, 'loot post for boss 99901 must exist').toBeDefined();

    // In the sandbox all test accounts share one Discord user ID, so we use
    // synthetic user IDs to exercise the multi-raider path at the DB level.
    // These IDs must be linked to distinct raiders so the handler can look
    // them up; we write directly to the DB (same as the handler does) instead
    // of going through fakeButton.
    const userIdA = 'synthetic-user-a';
    const userIdB = 'synthetic-user-b';

    linkRaiderToUser(userIdA, 0);
    linkRaiderToUser(userIdB, 1);

    await updateLootResponse(ctx.client, 'wantIn', BOSS_A, userIdA);
    await updateLootResponse(ctx.client, 'wantOut', BOSS_A, userIdB);

    const responses = getResponses(post!.id);
    const rowA = responses.find((r) => r.user_id === userIdA);
    const rowB = responses.find((r) => r.user_id === userIdB);

    expect(rowA, 'row for userA must exist').toBeDefined();
    expect(rowA!.response_type).toBe('wantIn');

    expect(rowB, 'row for userB must exist').toBeDefined();
    expect(rowB!.response_type).toBe('wantOut');
  });

  // =========================================================================
  // 4. Claims on different bosses are independent
  // =========================================================================

  it('claims on different boss IDs are stored in separate loot_posts rows', async () => {
    const ctx = getE2EContext();

    const postA = getLootPost(BOSS_A);
    const postB = getLootPost(BOSS_B);
    expect(postA, 'loot post A must exist').toBeDefined();
    expect(postB, 'loot post B must exist').toBeDefined();

    linkRaiderToUser(ctx.tester.id, 0);

    await updateLootResponse(ctx.client, 'major', BOSS_A, ctx.tester.id);
    await updateLootResponse(ctx.client, 'minor', BOSS_B, ctx.tester.id);

    const responsesA = getResponses(postA!.id);
    const responsesB = getResponses(postB!.id);

    const testerA = responsesA.find((r) => r.user_id === ctx.tester.id);
    const testerB = responsesB.find((r) => r.user_id === ctx.tester.id);

    expect(testerA!.response_type).toBe('major');
    expect(testerB!.response_type).toBe('minor');
  });

  // =========================================================================
  // 5. Missing boss_id is a no-op (no throw, no row written)
  // =========================================================================

  it('returns silently and writes no row when boss_id has no loot post', async () => {
    const ctx = getE2EContext();

    linkRaiderToUser(ctx.tester.id, 0);

    // Boss ID 0 will never exist in the seed.
    const beforeCount = queryAll('SELECT id FROM loot_responses').length;

    await expect(
      updateLootResponse(ctx.client, 'major', 0, ctx.tester.id),
    ).resolves.not.toThrow();

    const afterCount = queryAll('SELECT id FROM loot_responses').length;
    expect(afterCount).toBe(beforeCount);
  });
});
