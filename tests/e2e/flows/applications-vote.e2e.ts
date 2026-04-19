/**
 * Flow: multi-voter vote on a seeded application.
 *
 * The vote handler (voteOnApplication) is imported directly — it is a pure
 * function that takes a ButtonInteraction-shaped object, upserts a DB row,
 * and calls interaction.update() to refresh the embed.  No coupling to
 * interactionCreate.ts is required.
 *
 * customId format for vote buttons: `application_vote:{type}:{applicationId}`
 * Vote types: "for" | "neutral" | "against" | "kekw"
 *
 * Status transition note: voteOnApplication() does NOT transition
 * application.status.  Status changes only occur via accept/reject modals.
 * After two "for" votes the application remains "submitted".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { TextBasedChannel, ThreadChannel, Message, GuildMember } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeButton } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import { queryOne, queryAll } from '../setup/assertions.js';
import { voteOnApplication } from '../../../src/functions/applications/voteOnApplication.js';
import type { ButtonInteraction } from 'discord.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApplicationRow {
  id: number;
  status: string;
  thread_id: string | null;
}

interface VoteRow {
  id: number;
  application_id: number;
  user_id: string;
  vote_type: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return the seeded submitted application, or undefined if none exists. */
function getSeededApplication(): ApplicationRow | undefined {
  return queryOne<ApplicationRow>(
    "SELECT id, status, thread_id FROM applications WHERE status = 'submitted' LIMIT 1",
  );
}

/** Return all votes for a given application. */
function getVotesForApplication(applicationId: number): VoteRow[] {
  return queryAll<VoteRow>(
    'SELECT * FROM application_votes WHERE application_id = ?',
    [applicationId],
  );
}

/**
 * Resolve an anchor message that the bot can edit.
 *
 * Preference order:
 * 1. The voting-embed message in the application's forum thread (bot sent it).
 * 2. Any other message in the forum thread.
 * 3. The most recent message in the guild system channel.
 *
 * voteOnApplication() only reads interaction.user.id and calls
 * interaction.update() (which invokes message.edit()).  The anchor just needs
 * to be a real Message the bot is permitted to edit.
 */
async function resolveAnchorMessage(app: ApplicationRow): Promise<Message> {
  const ctx = getE2EContext();

  if (app.thread_id) {
    try {
      const thread = (await ctx.client.channels.fetch(app.thread_id)) as ThreadChannel | null;
      if (thread?.isTextBased()) {
        const msgs = await thread.messages.fetch({ limit: 20 });

        // Prefer the voting-embed message (has application_vote: buttons).
        const voteMsg = msgs.find((m) =>
          m.components.some((row) =>
            row.components.some(
              (c) =>
                'customId' in c &&
                typeof c.customId === 'string' &&
                c.customId.startsWith('application_vote:'),
            ),
          ),
        );
        if (voteMsg) return voteMsg;

        // Fall back to any message in the thread.
        const first = msgs.first();
        if (first) return first;
      }
    } catch {
      // Thread fetch failed — fall through to system channel.
    }
  }

  // Last resort: system channel (the bot sent messages here during previous
  // resets, and the channel is not cleaned up between runs).
  const systemChannel = ctx.guild.systemChannel as TextBasedChannel;
  const sysMsgs = await systemChannel.messages.fetch({ limit: 5 });
  const botMsg = sysMsgs.find((m) => m.author.id === ctx.client.user?.id);
  const anchor = botMsg ?? sysMsgs.first();
  if (!anchor) throw new Error('Could not resolve any anchor message for fakeButton');
  return anchor;
}

/** Build and dispatch a vote interaction for the given member. */
async function castVote(
  anchorMessage: Message,
  member: GuildMember,
  applicationId: number,
  voteType: string,
) {
  const ctx = getE2EContext();
  const btn = fakeButton({
    client: ctx.client,
    guild: ctx.guild,
    channel: anchorMessage.channel as TextBasedChannel,
    member,
    user: member.user,
    message: anchorMessage,
    customId: `application_vote:${voteType}:${applicationId}`,
  });
  await voteOnApplication(btn as unknown as ButtonInteraction, applicationId, voteType);
  return btn;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applications — vote flow', () => {
  beforeEach(async () => {
    // seed_all with discord=true creates a forum thread for the application.
    await resetAndSeed({ discord: true });
  });

  it('records two "for" votes from distinct voters', async () => {
    const ctx = getE2EContext();

    // 1. Locate the seeded application.
    const app = getSeededApplication();
    expect(app, 'seeded submitted application must exist').toBeDefined();
    const applicationId = app!.id;

    // 2. Resolve an anchor message the bot can edit.
    const anchorMessage = await resolveAnchorMessage(app!);
    expect(anchorMessage, 'anchor message is required').toBeDefined();

    // 3. Dispatch vote A then vote B directly via the handler function.
    const buttonA = await castVote(anchorMessage, ctx.voterA, applicationId, 'for');
    const buttonB = await castVote(anchorMessage, ctx.voterB, applicationId, 'for');

    // 4. Assert: both fake interactions called update() (embed was refreshed).
    expect(buttonA.__updated, 'voterA interaction.update() must be called').not.toBeNull();
    expect(buttonB.__updated, 'voterB interaction.update() must be called').not.toBeNull();

    // 5. Assert DB: two "for" votes exist for this application.
    const votes = getVotesForApplication(applicationId);
    const forVotes = votes.filter((v) => v.vote_type === 'for');
    // The seed may have pre-existing votes with other user IDs; check the
    // voters we cast, not an exact total.
    const voterAVote = forVotes.find((v) => v.user_id === ctx.voterA.id);
    const voterBVote = forVotes.find((v) => v.user_id === ctx.voterB.id);
    expect(voterAVote, 'voterA "for" vote must be recorded').toBeDefined();
    expect(voterBVote, 'voterB "for" vote must be recorded').toBeDefined();
  });

  it('upserts — a second vote from the same voter replaces the first', async () => {
    const ctx = getE2EContext();

    const app = getSeededApplication();
    expect(app, 'seeded submitted application must exist').toBeDefined();
    const applicationId = app!.id;

    const anchorMessage = await resolveAnchorMessage(app!);

    // First vote: "for"
    await castVote(anchorMessage, ctx.voterA, applicationId, 'for');

    // Second vote from same voter: "against" (INSERT OR REPLACE should upsert)
    await castVote(anchorMessage, ctx.voterA, applicationId, 'against');

    // DB: only one row for voterA on this application; vote_type should be "against".
    const votes = getVotesForApplication(applicationId);
    const voterAVotes = votes.filter((v) => v.user_id === ctx.voterA.id);
    expect(voterAVotes.length).toBe(1);
    expect(voterAVotes[0]!.vote_type).toBe('against');
  });

  it('application status remains "submitted" after votes — no auto-transition threshold', async () => {
    const ctx = getE2EContext();

    const app = getSeededApplication();
    expect(app, 'seeded submitted application must exist').toBeDefined();
    const applicationId = app!.id;

    const anchorMessage = await resolveAnchorMessage(app!);

    // Cast votes from both voters.
    await castVote(anchorMessage, ctx.voterA, applicationId, 'for');
    await castVote(anchorMessage, ctx.voterB, applicationId, 'for');

    // Status must remain "submitted" — only accept/reject modals change it.
    const updated = queryOne<{ status: string }>(
      'SELECT status FROM applications WHERE id = ?',
      [applicationId],
    );
    expect(updated?.status).toBe('submitted');
  });
});
