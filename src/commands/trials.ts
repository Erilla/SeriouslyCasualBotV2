import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
} from 'discord.js';
import { getDatabase } from '../database/db.js';
import { requireOfficer, createEmbed } from '../utils.js';
import { audit } from '../services/auditLog.js';
import { logger } from '../services/logger.js';
import { closeTrial } from '../functions/trial-review/closeTrial.js';
import { changeTrialInfo } from '../functions/trial-review/changeTrialInfo.js';
import { updateTrialLogs } from '../functions/trial-review/updateTrialLogs.js';
import {
  buildReviewMessage,
  calculateReviewDates,
  buildTrialButtons,
} from '../functions/trial-review/createTrialReviewThread.js';
import type { TrialRow } from '../types/index.js';

export default {
  data: new SlashCommandBuilder()
    .setName('trials')
    .setDescription('Manage trial reviews')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName('create_thread').setDescription('Create a new trial review thread'),
    )
    .addSubcommand((sub) =>
      sub.setName('get_current_trials').setDescription('View all active trials'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove_trial')
        .setDescription('Close and remove a trial')
        .addStringOption((opt) =>
          opt
            .setName('thread_id')
            .setDescription('The thread ID of the trial')
            .setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('change_trial_info')
        .setDescription('Update trial character name, role, or start date')
        .addStringOption((opt) =>
          opt
            .setName('thread_id')
            .setDescription('The thread ID of the trial')
            .setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('character_name')
            .setDescription('New character name'),
        )
        .addStringOption((opt) =>
          opt.setName('role').setDescription('New role'),
        )
        .addStringOption((opt) =>
          opt
            .setName('start_date')
            .setDescription('New start date (YYYY-MM-DD)'),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('update_trial_logs')
        .setDescription('Refresh WarcraftLogs attendance for all active trials'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('update_trial_review_messages')
        .setDescription('Refresh all trial review messages'),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'create_thread': {
        const today = new Date().toISOString().split('T')[0];

        const modal = new ModalBuilder()
          .setCustomId('trial:modal:create')
          .setTitle('Create Trial Review');

        const charNameInput = new TextInputBuilder()
          .setCustomId('character_name')
          .setLabel('Character Name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const roleInput = new TextInputBuilder()
          .setCustomId('role')
          .setLabel('Role')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g., Ranged DPS, Healer, Tank')
          .setRequired(true);

        const startDateInput = new TextInputBuilder()
          .setCustomId('start_date')
          .setLabel('Start Date')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('YYYY-MM-DD')
          .setValue(today)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(charNameInput),
          new ActionRowBuilder<TextInputBuilder>().addComponents(roleInput),
          new ActionRowBuilder<TextInputBuilder>().addComponents(startDateInput),
        );

        await interaction.showModal(modal);
        break;
      }

      case 'get_current_trials': {
        const db = getDatabase();
        const trials = db
          .prepare("SELECT * FROM trials WHERE status IN ('active', 'promoted') ORDER BY start_date DESC")
          .all() as TrialRow[];

        if (trials.length === 0) {
          await interaction.reply({
            content: 'No active trials.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const lines = trials.map((t) => {
          const statusIndicator = t.status === 'promoted' ? '[Promoted]' : '';
          const threadRef = t.thread_id ? ` | <#${t.thread_id}>` : '';
          return `**${t.character_name}** - ${t.role} | Started: ${t.start_date} ${statusIndicator}${threadRef}`;
        });

        const embed = createEmbed(`Active Trials (${trials.length})`).setDescription(
          lines.join('\n'),
        );

        await interaction.reply({
          embeds: [embed],
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'remove_trial': {
        const threadId = interaction.options.getString('thread_id', true);
        const db = getDatabase();

        const trial = db
          .prepare('SELECT * FROM trials WHERE thread_id = ?')
          .get(threadId) as TrialRow | undefined;

        if (!trial) {
          await interaction.reply({
            content: `No trial found with thread ID \`${threadId}\`.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          await closeTrial(interaction.client, trial.id);
          await audit(interaction.user, 'closed trial', `${trial.character_name} (#${trial.id})`);
          await interaction.editReply({
            content: `Closed trial for **${trial.character_name}**.`,
          });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await interaction.editReply({ content: `Failed to close trial: ${err.message}` });
        }
        break;
      }

      case 'change_trial_info': {
        const threadId = interaction.options.getString('thread_id', true);
        const characterName = interaction.options.getString('character_name') ?? undefined;
        const role = interaction.options.getString('role') ?? undefined;
        const startDate = interaction.options.getString('start_date') ?? undefined;

        if (!characterName && !role && !startDate) {
          await interaction.reply({
            content: 'You must provide at least one field to update.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        // Validate date format if provided
        if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
          await interaction.reply({
            content: 'Invalid date format. Please use YYYY-MM-DD.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const db = getDatabase();
        const trial = db
          .prepare('SELECT * FROM trials WHERE thread_id = ?')
          .get(threadId) as TrialRow | undefined;

        if (!trial) {
          await interaction.reply({
            content: `No trial found with thread ID \`${threadId}\`.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          await changeTrialInfo(interaction.client, trial.id, {
            characterName,
            role,
            startDate,
          });

          const changes = [];
          if (characterName) changes.push(`name=${characterName}`);
          if (role) changes.push(`role=${role}`);
          if (startDate) changes.push(`start_date=${startDate}`);

          await audit(
            interaction.user,
            'updated trial info',
            `${trial.character_name} (#${trial.id}): ${changes.join(', ')}`,
          );

          await interaction.editReply({ content: 'Trial info updated.' });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await interaction.editReply({
            content: `Failed to update trial info: ${err.message}`,
          });
        }
        break;
      }

      case 'update_trial_logs': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
          await updateTrialLogs(interaction.client);
          await interaction.editReply({ content: 'Trial logs updated.' });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          await interaction.editReply({
            content: `Failed to update trial logs: ${err.message}`,
          });
        }
        break;
      }

      case 'update_trial_review_messages': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const db = getDatabase();
        const trials = db
          .prepare("SELECT * FROM trials WHERE status IN ('active', 'promoted')")
          .all() as TrialRow[];

        if (trials.length === 0) {
          await interaction.editReply({ content: 'No active trials to update.' });
          return;
        }

        const guild = interaction.guild;
        if (!guild) {
          await interaction.editReply({ content: 'This must be used in a server.' });
          return;
        }

        let updated = 0;
        let failed = 0;

        for (const trial of trials) {
          if (!trial.thread_id) continue;

          try {
            const channel = await guild.channels.fetch(trial.thread_id);
            if (!channel || !channel.isThread()) continue;

            const { twoWeek, fourWeek, sixWeek } = calculateReviewDates(trial.start_date);
            const content = buildReviewMessage(
              trial.character_name,
              trial.role,
              trial.start_date,
              twoWeek,
              fourWeek,
              sixWeek,
            );

            const starterMessage = await channel.fetchStarterMessage();
            if (starterMessage) {
              await starterMessage.edit({
                content,
                components: [buildTrialButtons(trial.id)],
              });
              updated++;
            }
          } catch (error) {
            failed++;
            logger.warn(
              'Trials',
              `Failed to update review message for trial #${trial.id}: ${error}`,
            );
          }
        }

        await interaction.editReply({
          content: `Updated ${updated} review messages (${failed} failed).`,
        });
        break;
      }
    }
  },
};
