import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { requireOfficer, audit } from '../utils.js';
import {
  parseCeCutoffDate,
  removeCeOverride,
  setCeOverride,
} from '../functions/guild-info/ceOverrides.js';
import { updateAchievements } from '../functions/guild-info/updateAchievements.js';
import { logger } from '../services/logger.js';

export default {
  data: new SlashCommandBuilder()
    .setName('ceoverride')
    .setDescription('Manage Cutting Edge cutoff overrides')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('Set the first UTC date that no longer qualifies for CE')
        .addStringOption((option) =>
          option.setName('raid').setDescription('Raider.IO raid slug').setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName('cutoff')
            .setDescription('First non-CE day, YYYY-MM-DD UTC')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('Remove a CE cutoff override')
        .addStringOption((option) =>
          option.setName('raid').setDescription('Raider.IO raid slug').setRequired(true),
        ),
    ),

  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    const subcommand = interaction.options.getSubcommand();
    const raidSlug = interaction.options.getString('raid', true).trim();
    if (!raidSlug) {
      await interaction.reply({
        content: 'Raid slug cannot be empty.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (subcommand === 'set') {
      const cutoffDate = interaction.options.getString('cutoff', true);
      const cutoffAt = parseCeCutoffDate(cutoffDate);
      if (!cutoffAt) {
        await interaction.reply({
          content: 'Cutoff must be a real UTC date in YYYY-MM-DD format.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      setCeOverride(raidSlug, cutoffAt);
      await audit(interaction.user, 'set CE override', `${raidSlug}: ${cutoffDate}`);
      await interaction.reply({ content: 'Saving CE override…', flags: MessageFlags.Ephemeral });
      await refreshAchievements(interaction, `CE override saved for **${raidSlug}**`);
      return;
    }

    if (!removeCeOverride(raidSlug)) {
      await interaction.reply({
        content: `No CE override is set for **${raidSlug}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await audit(interaction.user, 'removed CE override', raidSlug);
    await interaction.reply({ content: 'Removing CE override…', flags: MessageFlags.Ephemeral });
    await refreshAchievements(interaction, `CE override removed for **${raidSlug}**`);
  },
};

async function refreshAchievements(
  interaction: ChatInputCommandInteraction,
  savedMessage: string,
): Promise<void> {
  try {
    await updateAchievements(interaction.client);
  } catch (error) {
    logger.error(
      'guild-info',
      `Achievements refresh failed after saving CE override: ${error}`,
      error instanceof Error ? error : undefined,
    );
    await interaction.editReply({
      content: `${savedMessage}, but achievements refresh failed: ${error}`,
    });
    return;
  }

  await interaction.editReply({ content: `${savedMessage} and achievements updated.` });
}
