// requires: raider.io
import { describe, it, expect, beforeEach } from 'vitest';
import type { ChatInputCommandInteraction, TextBasedChannel } from 'discord.js';
import { getE2EContext } from '../setup/bootstrap.js';
import { fakeChatInput } from '../setup/synthesizer.js';
import { resetAndSeed } from '../setup/baseline.js';
import updateachievementsCmd from '../../../src/commands/updateachievements.js';

describe('/updateachievements', () => {
  beforeEach(async () => {
    await resetAndSeed();
  });

  it(
    'officer — replies ephemeral "Updating achievements..." then edits to "Achievements updated."',
    { timeout: 120_000 }, // raider.io calls: static-data per expansion (6+) + rankings per raid
    async () => {
      const ctx = getE2EContext();
      const channel = ctx.guild.systemChannel as TextBasedChannel;

      const iact = fakeChatInput({
        client: ctx.client,
        guild: ctx.guild,
        channel,
        member: ctx.officer,
        user: ctx.officer.user,
        commandName: 'updateachievements',
      });

      // Executes real raider.io calls (getRaidStaticData + getRaidRankings per raid).
      // Seeded raiders are not used by this command — it fetches guild raid rankings
      // directly using RAIDERIO_GUILD_IDS from config.
      await updateachievementsCmd.execute(iact as unknown as ChatInputCommandInteraction);

      // Must have sent exactly one reply (the ephemeral ack).
      expect(iact.__replies.length).toBe(1);
      const reply = iact.__replies[0]!;

      // Initial reply must be ephemeral.
      expect(reply.ephemeral).toBe(true);

      // Content must be the "Updating..." acknowledgement.
      const content =
        typeof reply.options === 'string'
          ? reply.options
          : (reply.options as { content?: string }).content ?? '';
      expect(content).toMatch(/Updating achievements/i);

      // After raider.io calls complete, editReply must have been called with the
      // success message — regardless of whether the guild had any ranked raids.
      expect(iact.__editedReply).not.toBeNull();
      const editedContent =
        typeof iact.__editedReply!.options === 'string'
          ? iact.__editedReply!.options
          : (iact.__editedReply!.options as { content?: string }).content ?? '';
      expect(editedContent).toMatch(/Achievements updated/i);
    },
  );
});
