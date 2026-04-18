import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  AttachmentBuilder,
} from 'discord.js';
import { getDatabase } from '../database/db.js';
import { requireOfficer, createEmbed, audit } from '../utils.js';
import { paginateLines, buildPageEmbed, buildPageButtons, cachePaginatedData } from '../functions/pagination.js';
import { syncRaiders } from '../functions/raids/syncRaiders.js';
import { autoMatchRaiders } from '../functions/raids/autoMatchRaiders.js';
import { sendAlertForRaidersWithNoUser } from '../functions/raids/sendAlertForRaidersWithNoUser.js';
import { updateRaiderDiscordUser } from '../functions/raids/updateRaiderDiscordUser.js';
import { ignoreCharacter } from '../functions/raids/ignoreCharacter.js';
import { addOverlord, removeOverlord, getOverlords } from '../functions/raids/overlords.js';
import {
  generateMythicPlusReport,
  generateGreatVaultReport,
} from '../functions/raids/alertHighestMythicPlusDone.js';
import { getHistoricalData } from '../services/wowaudit.js';
import type { RaiderRow, IgnoredCharacterRow } from '../types/index.js';

export default {
  data: new SlashCommandBuilder()
    .setName('raiders')
    .setDescription('Manage raiders')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName('get_raiders').setDescription('List all raiders'),
    )
    .addSubcommand((sub) =>
      sub.setName('get_ignored_characters').setDescription('List all ignored characters'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('ignore_character')
        .setDescription('Ignore a character from raider tracking')
        .addStringOption((opt) =>
          opt.setName('character_name').setDescription('Character name').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove_ignore_character')
        .setDescription('Remove a character from the ignore list')
        .addStringOption((opt) =>
          opt.setName('character_name').setDescription('Character name').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('sync_raiders').setDescription('Manually trigger a raider sync'),
    )
    .addSubcommand((sub) =>
      sub.setName('check_missing_users').setDescription('Check for raiders without linked Discord users'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('update_raider_user')
        .setDescription('Link a raider to a Discord user')
        .addStringOption((opt) =>
          opt.setName('character_name').setDescription('Character name').setRequired(true),
        )
        .addUserOption((opt) =>
          opt.setName('user').setDescription('Discord user').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('previous_highest_mythicplus').setDescription('Generate previous week M+ report'),
    )
    .addSubcommand((sub) =>
      sub.setName('previous_great_vault').setDescription('Generate previous week Great Vault report'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('add_overlord')
        .setDescription('Add an overlord')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Overlord name').setRequired(true),
        )
        .addUserOption((opt) =>
          opt.setName('user').setDescription('Discord user').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('get_overlords').setDescription('List all overlords'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove_overlord')
        .setDescription('Remove an overlord')
        .addStringOption((opt) =>
          opt.setName('name').setDescription('Overlord name').setRequired(true),
        ),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    const subcommand = interaction.options.getSubcommand();

    // get_raiders is viewable by any admin (no officer check)
    if (subcommand !== 'get_raiders') {
      if (!(await requireOfficer(interaction))) return;
    }

    const db = getDatabase();

    switch (subcommand) {
      case 'get_raiders': {
        const raiders = db
          .prepare('SELECT * FROM raiders ORDER BY character_name')
          .all() as RaiderRow[];

        if (raiders.length === 0) {
          await interaction.reply({
            content: 'No raiders found.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const title = `Raiders (${raiders.length} total)`;
        const lines = raiders.map(
          (r) =>
            `**${r.character_name}** (${r.realm}) - ${r.class ?? 'Unknown'} | ${r.discord_user_id ? `<@${r.discord_user_id}>` : 'Unlinked'}`,
        );

        const pages = paginateLines(lines);

        if (pages.length === 1) {
          // Single page - no buttons or cache needed
          const embed = buildPageEmbed(title, pages[0], 1, 1);
          await interaction.reply({ embeds: [embed] });
        } else {
          // Multiple pages - use buttons and cache
          const embed = buildPageEmbed(title, pages[0], 1, pages.length);
          const buttons = buildPageButtons('raiders', 1, pages.length);
          const { resource: reply } = await interaction.reply({
            embeds: [embed],
            components: buttons ? [buttons] : [],
            withResponse: true,
          });
          const messageId = reply?.message?.id ?? interaction.id;
          cachePaginatedData(`raiders:${messageId}`, title, pages);
        }
        break;
      }

      case 'get_ignored_characters': {
        const ignored = db
          .prepare('SELECT * FROM ignored_characters ORDER BY character_name')
          .all() as IgnoredCharacterRow[];

        const list =
          ignored.length > 0
            ? ignored.map((ic) => `- ${ic.character_name}`).join('\n')
            : 'No ignored characters.';

        await interaction.reply({
          content: `**Ignored Characters:**\n${list}`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'ignore_character': {
        const characterName = interaction.options.getString('character_name', true);
        const success = ignoreCharacter(characterName);

        if (success) {
          await audit(interaction.user, 'ignored character', characterName);
          await interaction.reply({
            content: `Ignored **${characterName}** and removed from raiders.`,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply({
            content: `Failed to ignore **${characterName}**.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }

      case 'remove_ignore_character': {
        const characterName = interaction.options.getString('character_name', true);
        const result = db
          .prepare('DELETE FROM ignored_characters WHERE character_name = ?')
          .run(characterName);

        if (result.changes > 0) {
          await audit(interaction.user, 'removed ignore for character', characterName);
          await interaction.reply({
            content: `Removed **${characterName}** from the ignore list.`,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply({
            content: `**${characterName}** was not in the ignore list.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }

      case 'sync_raiders': {
        await interaction.reply({
          content: 'Syncing raiders...',
          flags: MessageFlags.Ephemeral,
        });

        try {
          await syncRaiders(interaction.client);
          await interaction.editReply({ content: 'Raider sync complete.' });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await interaction.editReply({
            content: `Sync failed: ${err.message}`,
          });
        }
        break;
      }

      case 'check_missing_users': {
        const unlinked = db
          .prepare('SELECT * FROM raiders WHERE discord_user_id IS NULL AND missing_since IS NULL')
          .all() as RaiderRow[];

        if (unlinked.length === 0) {
          await interaction.reply({
            content: 'All raiders are linked to Discord users.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const guild = interaction.guild;
        if (!guild) {
          await interaction.reply({
            content: 'This command must be used in a guild.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.reply({
          content: `Found ${unlinked.length} unlinked raiders. Running auto-match...`,
          flags: MessageFlags.Ephemeral,
        });

        const matches = await autoMatchRaiders(guild, unlinked);
        await sendAlertForRaidersWithNoUser(interaction.client, unlinked, matches);

        await interaction.editReply({
          content: `Found ${unlinked.length} unlinked raiders. Auto-matched ${matches.length}. Alerts sent to raider-setup channel.`,
        });
        break;
      }

      case 'update_raider_user': {
        const characterName = interaction.options.getString('character_name', true);
        const user = interaction.options.getUser('user', true);

        const success = await updateRaiderDiscordUser(
          interaction.client,
          characterName,
          user.id,
        );

        if (success) {
          await audit(interaction.user, 'linked raider', `${characterName} -> ${user.tag}`);
          await interaction.reply({
            content: `Linked **${characterName}** to ${user}.`,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply({
            content: `Failed to link **${characterName}**. Raider may not exist.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }

      case 'previous_highest_mythicplus': {
        await interaction.reply({ content: 'Generating M+ report...' });

        try {
          const raiders = db
            .prepare('SELECT * FROM raiders ORDER BY character_name')
            .all() as RaiderRow[];

          const content = await generateMythicPlusReport(raiders);
          const dateStr = new Date().toISOString().split('T')[0];
          const file = new AttachmentBuilder(Buffer.from(content), {
            name: `highest_mythicplus_${dateStr}.txt`,
          });

          await interaction.editReply({
            content: `**M+ Report** - ${dateStr}`,
            files: [file],
          });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await interaction.editReply({
            content: `Failed to generate M+ report: ${err.message}`,
          });
        }
        break;
      }

      case 'previous_great_vault': {
        await interaction.reply({ content: 'Generating Great Vault report...' });

        try {
          const raiders = db
            .prepare('SELECT * FROM raiders ORDER BY character_name')
            .all() as RaiderRow[];

          const historicalData = await getHistoricalData();
          const content = await generateGreatVaultReport(raiders, historicalData);
          const dateStr = new Date().toISOString().split('T')[0];
          const file = new AttachmentBuilder(Buffer.from(content), {
            name: `great_vaults_${dateStr}.txt`,
          });

          await interaction.editReply({
            content: `**Great Vault Report** - ${dateStr}`,
            files: [file],
          });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await interaction.editReply({
            content: `Failed to generate Great Vault report: ${err.message}`,
          });
        }
        break;
      }

      case 'add_overlord': {
        const name = interaction.options.getString('name', true);
        const user = interaction.options.getUser('user', true);

        try {
          addOverlord(name, user.id);
          await audit(interaction.user, 'added overlord', `${name} (${user.tag})`);
          await interaction.reply({
            content: `Added overlord **${name}** (${user}).`,
            flags: MessageFlags.Ephemeral,
          });
        } catch {
          await interaction.reply({
            content: `Failed to add overlord **${name}**. They may already exist.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }

      case 'get_overlords': {
        const overlords = getOverlords();
        const list =
          overlords.length > 0
            ? overlords.map((o) => `- **${o.name}**: <@${o.user_id}>`).join('\n')
            : 'No overlords configured.';

        await interaction.reply({
          content: `**Overlords:**\n${list}`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'remove_overlord': {
        const name = interaction.options.getString('name', true);

        try {
          removeOverlord(name);
          await audit(interaction.user, 'removed overlord', name);
          await interaction.reply({
            content: `Removed overlord **${name}**.`,
            flags: MessageFlags.Ephemeral,
          });
        } catch {
          await interaction.reply({
            content: `Failed to remove overlord **${name}**.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }
    }
  },
};
