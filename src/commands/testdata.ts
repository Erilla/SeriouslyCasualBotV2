import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { requireOfficer } from '../utils.js';
import { getDatabase } from '../database/db.js';
import { seedRaiders } from '../functions/testdata/seedRaiders.js';
import { seedApplication } from '../functions/testdata/seedApplication.js';
import { seedApplicationVariety } from '../functions/testdata/seedApplicationVariety.js';
import { seedTrial } from '../functions/testdata/seedTrial.js';
import { seedEpgp } from '../functions/testdata/seedEpgp.js';
import { seedLoot } from '../functions/testdata/seedLoot.js';
import { resetData } from '../functions/testdata/resetData.js';
import { seedAll } from '../functions/testdata/seedAll.js';
import { seedRaidersDiscord } from '../functions/testdata/discord/seedRaidersDiscord.js';
import { seedApplicationDiscord } from '../functions/testdata/discord/seedApplicationDiscord.js';
import { seedTrialDiscord } from '../functions/testdata/discord/seedTrialDiscord.js';
import { seedLootDiscord } from '../functions/testdata/discord/seedLootDiscord.js';
import { logger } from '../services/logger.js';

export default {
  devOnly: true,
  data: new SlashCommandBuilder()
    .setName('testdata')
    .setDescription('Dev-only: seed or reset test data in the database')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('seed_raiders')
        .setDescription('Insert 15 mock raiders into the database')
        .addBooleanOption((o) => o.setName('discord').setDescription('Also post linking messages in raider-setup')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('seed_application')
        .setDescription('Insert a mock application with answers and votes')
        .addBooleanOption((o) => o.setName('discord').setDescription('Also create a forum post with voting buttons')),
    )
    .addSubcommand((sub) =>
      sub.setName('seed_application_variety').setDescription('Insert 5 applications covering all statuses'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('seed_trial')
        .setDescription('Insert a mock trial with 3 scheduled alerts')
        .addBooleanOption((o) => o.setName('discord').setDescription('Also create a trial-review forum thread')),
    )
    .addSubcommand((sub) =>
      sub.setName('seed_epgp').setDescription('Insert mock EPGP data for existing raiders'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('seed_loot')
        .setDescription('Insert 3 mock loot posts')
        .addBooleanOption((o) => o.setName('discord').setDescription('Also post real messages in the configured loot channel')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('seed_all')
        .setDescription('Run all seeds in order')
        .addBooleanOption((o) => o.setName('discord').setDescription('Also create Discord artifacts for each seed')),
    )
    .addSubcommand((sub) =>
      sub
        .setName('reset')
        .setDescription('Wipe all test data and re-seed defaults')
        .addBooleanOption((o) => o.setName('confirm').setDescription('Must be true to actually wipe data').setRequired(true)),
    ),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await requireOfficer(interaction))) return;

    const sub = interaction.options.getSubcommand();
    const db = getDatabase();
    const discord = interaction.options.getBoolean('discord') ?? false;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const message = await runSubcommand(sub, db, interaction, discord);
      logger.info('TestData', `${sub}: ${message}`);
      await interaction.editReply({ content: message });
    } catch (err) {
      logger.error('TestData', `Failed to run ${sub}`, err as Error);
      const detail = err instanceof Error ? err.message : 'Check logs for details.';
      await interaction.editReply({ content: `Failed to run ${sub}. ${detail}` });
    }
  },
};

async function runSubcommand(
  sub: string,
  db: ReturnType<typeof getDatabase>,
  interaction: ChatInputCommandInteraction,
  discord: boolean,
): Promise<string> {
  switch (sub) {
    case 'seed_raiders': {
      if (discord) {
        const r = await seedRaidersDiscord(interaction.client, db);
        return formatLines(
          `Seeded raiders: **${r.raidersSeeded}** total in DB.`,
          `Linking messages requested: **${r.linkingMessagesRequested}**.`,
          r.skippedReason ? `_Discord skipped: ${r.skippedReason}_` : null,
        );
      }
      seedRaiders(db);
      return 'Seeded 15 mock raiders into the database.';
    }
    case 'seed_application': {
      if (discord) {
        const r = await seedApplicationDiscord(interaction.client, db);
        return formatLines(
          `Seeded application **#${r.applicationId}**.`,
          r.forumPostId ? `Forum post created: \`${r.forumPostId}\` (thread \`${r.threadId}\`).` : null,
          r.skippedReason ? `_Discord skipped: ${r.skippedReason}_` : null,
        );
      }
      const r = seedApplication(db);
      return `Seeded 1 mock application (ID: ${r.applicationId}) with ${r.answersInserted} answers and ${r.votesInserted} votes.`;
    }
    case 'seed_application_variety': {
      const r = seedApplicationVariety(db);
      const byStatus = Object.entries(r.byStatus)
        .filter(([, count]) => count > 0)
        .map(([status, count]) => `${status}: ${count}`)
        .join(', ');
      return `Seeded ${r.applicationIds.length} applications (${byStatus}).`;
    }
    case 'seed_trial': {
      if (discord) {
        const r = await seedTrialDiscord(interaction.client);
        return formatLines(
          r.trialId ? `Seeded trial **#${r.trialId}** with 3 alerts and forum thread \`${r.threadId}\`.` : 'Trial seeding failed.',
          r.skippedReason ? `_Discord skipped: ${r.skippedReason}_` : null,
        );
      }
      const r = seedTrial(db);
      return `Seeded 1 mock trial (ID: ${r.trialId}) with ${r.alertCount} trial alerts.`;
    }
    case 'seed_epgp': {
      const r = seedEpgp(db);
      return [
        `Seeded EPGP data for **${r.raiderCount}** raiders:`,
        `• ${r.effortPointsInserted} effort point entries`,
        `• ${r.gearPointsInserted} gear point entries`,
        `• ${r.lootHistoryInserted} loot history entries`,
        `• ${r.uploadHistoryInserted} upload history record`,
      ].join('\n');
    }
    case 'seed_loot': {
      if (discord) {
        const r = await seedLootDiscord(interaction.client, db);
        return formatLines(
          `DB loot_posts inserted: **${r.dbPostsInserted}**.`,
          `Discord messages posted: **${r.postsCreated}** of **${r.postsAttempted}** attempted.`,
          r.skippedReason ? `_Discord skipped: ${r.skippedReason}_` : null,
        );
      }
      const r = seedLoot(db);
      return `Seeded ${r.postsInserted} mock loot posts (boss IDs 99901-99903).`;
    }
    case 'seed_all': {
      const r = await seedAll(db, discord ? { client: interaction.client } : {});
      const lines = [
        `**seed_all** (${r.discord ? 'with Discord' : 'DB only'}):`,
        `• Raiders in DB: **${r.raidersSeeded}**`,
        `• Application: **#${r.applicationId ?? 'n/a'}**`,
        `• Trial: **#${r.trialId ?? 'n/a'}**`,
        `• EPGP seeded: ${r.epgpSeeded ? 'yes' : 'no'}`,
        `• Loot posts in DB: **${r.lootPostsInDb}**` + (r.discord ? `, Discord messages: **${r.lootDiscordMessagesPosted}**` : ''),
      ];
      if (r.skipped.length > 0) {
        lines.push('', '_Skipped:_');
        for (const s of r.skipped) lines.push(`• ${s}`);
      }
      return lines.join('\n');
    }
    case 'reset': {
      const confirm = interaction.options.getBoolean('confirm', true);
      if (!confirm) {
        return 'Pass `confirm:true` to actually wipe data.';
      }
      resetData(db);
      return 'All data wiped and defaults (including application questions) re-seeded.';
    }
    default:
      return `Unknown subcommand: ${sub}`;
  }
}

function formatLines(...lines: Array<string | null | undefined>): string {
  return lines.filter((l): l is string => typeof l === 'string' && l.length > 0).join('\n');
}
