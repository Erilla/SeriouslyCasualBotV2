import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { requireOfficer } from '../utils.js';
import { checkRaidExpansions } from '../functions/loot/checkRaidExpansions.js';
import { deleteLootPost } from '../functions/loot/deleteLootPost.js';

export default {
  data: new SlashCommandBuilder()
    .setName('loot')
    .setDescription('Manage loot priority posts')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName('create_posts').setDescription('Auto-discover current raid and create loot posts'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete_post')
        .setDescription('Delete a single loot post by boss ID')
        .addIntegerOption((opt) =>
          opt.setName('boss_id').setDescription('The boss ID to delete').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('delete_posts')
        .setDescription('Delete multiple loot posts by boss IDs')
        .addStringOption((opt) =>
          opt
            .setName('boss_ids')
            .setDescription('Comma-separated boss IDs to delete')
            .setRequired(true),
        ),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'create_posts': {
        await interaction.reply({
          content: 'Checking raid expansions...',
          flags: MessageFlags.Ephemeral,
        });

        try {
          await checkRaidExpansions(interaction.client);
          await interaction.editReply({ content: 'Loot posts created.' });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await interaction.editReply({ content: `Failed to create loot posts: ${err.message}` });
        }
        break;
      }

      case 'delete_post': {
        const bossId = interaction.options.getInteger('boss_id', true);

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          await deleteLootPost(interaction.client, bossId);
          await interaction.editReply({ content: 'Loot post removed.' });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await interaction.editReply({ content: `Failed to delete loot post: ${err.message}` });
        }
        break;
      }

      case 'delete_posts': {
        const bossIdsStr = interaction.options.getString('boss_ids', true);
        const bossIds = bossIdsStr.split(',').map((id) => parseInt(id.trim(), 10));

        await interaction.reply({
          content: 'Deleting posts...',
          flags: MessageFlags.Ephemeral,
        });

        try {
          for (const bossId of bossIds) {
            if (!isNaN(bossId)) {
              await deleteLootPost(interaction.client, bossId);
            }
          }
          await interaction.editReply({ content: 'Deleted posts.' });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await interaction.editReply({ content: `Failed to delete some posts: ${err.message}` });
        }
        break;
      }
    }
  },
};
