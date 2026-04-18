import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { requireOfficer } from '../utils.js';
import { getDatabase } from '../database/db.js';
import { logger } from '../services/logger.js';
import { audit } from '../services/auditLog.js';
import { parseEpgpUpload } from '../functions/epgp/parseEpgpUpload.js';
import { processRoster } from '../functions/epgp/processRoster.js';
import { processLoot } from '../functions/epgp/processLoot.js';
import { generateDisplay } from '../functions/epgp/generateDisplay.js';
import { createDisplayPost, updateDisplayPost } from '../functions/epgp/createDisplayPost.js';

export default {
  data: new SlashCommandBuilder()
    .setName('epgp')
    .setDescription('Manage EPGP priority rankings')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub
        .setName('upload')
        .setDescription('Upload EPGP addon data (JSON file)')
        .addAttachmentOption((opt) =>
          opt.setName('file').setDescription('The EPGP addon JSON export file').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('get_by_token')
        .setDescription('View EPGP standings filtered by tier token')
        .addStringOption((opt) =>
          opt
            .setName('tier_token')
            .setDescription('Tier token type')
            .setRequired(true)
            .addChoices(
              { name: 'Zenith', value: 'Zenith' },
              { name: 'Dreadful', value: 'Dreadful' },
              { name: 'Mystic', value: 'Mystic' },
              { name: 'Venerated', value: 'Venerated' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('get_by_armour')
        .setDescription('View EPGP standings filtered by armour type')
        .addStringOption((opt) =>
          opt
            .setName('armour_type')
            .setDescription('Armour type')
            .setRequired(true)
            .addChoices(
              { name: 'Cloth', value: 'Cloth' },
              { name: 'Leather', value: 'Leather' },
              { name: 'Mail', value: 'Mail' },
              { name: 'Plate', value: 'Plate' },
            ),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('create_post').setDescription('Create the EPGP display in the configured channel'),
    )
    .addSubcommand((sub) =>
      sub.setName('update_post').setDescription('Update the existing EPGP display'),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'upload': {
        const attachment = interaction.options.getAttachment('file', true);

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          // Fetch the file content
          const response = await fetch(attachment.url);
          if (!response.ok) {
            await interaction.editReply({ content: 'Failed to download the attached file.' });
            return;
          }

          const jsonString = await response.text();

          // Parse the upload
          const uploadData = parseEpgpUpload(jsonString);

          // Process roster
          const rosterResult = await processRoster(uploadData.roster, uploadData.region);

          // Process loot
          const lootResult = processLoot(uploadData.loot);

          // Store upload history
          const db = getDatabase();
          db.prepare(
            'INSERT INTO epgp_upload_history (decay_percent, uploaded_content) VALUES (?, ?)',
          ).run(uploadData.decayPercent, jsonString);

          // Update display
          try {
            await updateDisplayPost(interaction.client);
          } catch (err) {
            logger.warn(
              'EPGP',
              `Display update failed after upload: ${err instanceof Error ? err.message : String(err)}`,
            );
          }

          await audit(interaction.user, 'uploaded EPGP data', `${rosterResult.processed} raiders, ${lootResult.inserted} loot entries`);
          await interaction.editReply({
            content:
              `EPGP upload processed.\n` +
              `Roster: ${rosterResult.processed} processed, ${rosterResult.skipped} skipped.\n` +
              `Loot: ${lootResult.inserted} inserted, ${lootResult.duplicates} duplicates, ${lootResult.skipped} skipped.`,
          });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          logger.error('EPGP', `Upload failed: ${err.message}`, err);
          await interaction.editReply({ content: `Upload failed: ${err.message}` });
        }
        break;
      }

      case 'get_by_token': {
        const tierToken = interaction.options.getString('tier_token', true);

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          const { header, bodies, footer } = generateDisplay(tierToken);
          const combined = [header, ...bodies, footer].join('\n');
          // Discord ephemeral reply limit is 2000 chars; split into follow-ups if needed
          if (combined.length <= 2000) {
            await interaction.editReply({ content: combined });
          } else {
            await interaction.editReply({ content: header });
            for (const body of bodies) {
              await interaction.followUp({ content: body, flags: MessageFlags.Ephemeral });
            }
            await interaction.followUp({ content: footer, flags: MessageFlags.Ephemeral });
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await interaction.editReply({ content: `Failed to generate display: ${err.message}` });
        }
        break;
      }

      case 'get_by_armour': {
        const armourType = interaction.options.getString('armour_type', true);

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          const { header, bodies, footer } = generateDisplay(null, armourType);
          const combined = [header, ...bodies, footer].join('\n');
          if (combined.length <= 2000) {
            await interaction.editReply({ content: combined });
          } else {
            await interaction.editReply({ content: header });
            for (const body of bodies) {
              await interaction.followUp({ content: body, flags: MessageFlags.Ephemeral });
            }
            await interaction.followUp({ content: footer, flags: MessageFlags.Ephemeral });
          }
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await interaction.editReply({ content: `Failed to generate display: ${err.message}` });
        }
        break;
      }

      case 'create_post': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          await createDisplayPost(interaction.client);
          await audit(interaction.user, 'created EPGP display post', '');
          await interaction.editReply({ content: 'Created EPGP display.' });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await interaction.editReply({ content: `Failed: ${err.message}` });
        }
        break;
      }

      case 'update_post': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          await updateDisplayPost(interaction.client);
          await audit(interaction.user, 'updated EPGP display post', '');
          await interaction.editReply({ content: 'Updated EPGP display.' });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await interaction.editReply({ content: `Failed: ${err.message}` });
        }
        break;
      }
    }
  },
};
