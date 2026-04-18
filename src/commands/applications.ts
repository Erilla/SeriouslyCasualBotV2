import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Colors,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { getDatabase } from '../database/db.js';
import { requireOfficer, createEmbed, asSendable } from '../utils.js';
import { audit } from '../services/auditLog.js';
import {
  getQuestions,
  addQuestion,
  removeQuestion,
} from '../functions/applications/applicationQuestions.js';
import { paginateLines, buildPageEmbed, buildPageButtons, cachePaginatedData } from '../functions/pagination.js';
import type { ApplicationRow } from '../types/index.js';

export default {
  data: new SlashCommandBuilder()
    .setName('applications')
    .setDescription('Manage application system')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName('list_questions').setDescription('List all application questions'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('add_question')
        .setDescription('Add a new application question')
        .addStringOption((opt) =>
          opt.setName('question').setDescription('The question text').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('remove_question')
        .setDescription('Remove an application question')
        .addIntegerOption((opt) =>
          opt.setName('id').setDescription('The question ID to remove').setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('post_apply_button')
        .setDescription('Post an "Apply Now" button embed in the current channel'),
    )
    .addSubcommand((sub) =>
      sub.setName('view_pending').setDescription('View all pending applications'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('set_accept_message')
        .setDescription('Set the default acceptance DM message'),
    )
    .addSubcommand((sub) =>
      sub
        .setName('set_reject_message')
        .setDescription('Set the default rejection DM message'),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!(await requireOfficer(interaction))) return;

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'list_questions': {
        const questions = getQuestions();

        if (questions.length === 0) {
          await interaction.reply({
            content: 'No application questions configured.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const list = questions
          .map((q) => `**${q.id}.** (order: ${q.sort_order}) ${q.question}`)
          .join('\n');

        await interaction.reply({
          content: `**Application Questions:**\n${list}`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'add_question': {
        const questionText = interaction.options.getString('question', true);
        const result = addQuestion(questionText);

        await audit(interaction.user, 'added application question', `#${result.id}: ${questionText}`);
        await interaction.reply({
          content: `Added question #${result.id} (order: ${result.sort_order}): ${questionText}`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'remove_question': {
        const id = interaction.options.getInteger('id', true);
        const success = removeQuestion(id);

        if (success) {
          await audit(interaction.user, 'removed application question', `#${id}`);
          await interaction.reply({
            content: `Removed question #${id}.`,
            flags: MessageFlags.Ephemeral,
          });
        } else {
          await interaction.reply({
            content: `Question #${id} not found.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        break;
      }

      case 'post_apply_button': {
        const embed = new EmbedBuilder()
          .setTitle('Apply to SeriouslyCasual')
          .setDescription(
            'Interested in joining our guild? Click the button below to start your application!\n\n' +
            'You will be asked a series of questions via DM. Make sure your DMs are open.',
          )
          .setColor(Colors.Green)
          .setTimestamp()
          .setFooter({ text: 'SeriouslyCasualBot' });

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('application:apply')
            .setLabel('Apply Now')
            .setStyle(ButtonStyle.Success)
            .setEmoji('📝'),
        );

        const sendChannel = asSendable(interaction.channel);
        if (!sendChannel) {
          await interaction.reply({
            content: 'This command must be used in a text channel.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await sendChannel.send({ embeds: [embed], components: [row] });

        await audit(interaction.user, 'posted apply button', `in #${sendChannel.name}`);
        await interaction.reply({
          content: 'Apply button posted!',
          flags: MessageFlags.Ephemeral,
        });
        break;
      }

      case 'view_pending': {
        const db = getDatabase();
        const applications = db
          .prepare(
            `SELECT * FROM applications
             WHERE status IN ('in_progress', 'active', 'abandoned')
             ORDER BY started_at DESC`,
          )
          .all() as ApplicationRow[];

        if (applications.length === 0) {
          await interaction.reply({
            content: 'No pending applications.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const lines = applications.map((app) => {
          const statusEmoji =
            app.status === 'active' ? '🟢' :
            app.status === 'in_progress' ? '🟡' :
            '🔴';
          const channelRef = app.channel_id ? ` | <#${app.channel_id}>` : '';
          return `${statusEmoji} **#${app.id}** - ${app.character_name || 'Unknown'} (<@${app.applicant_user_id}>) - ${app.status}${channelRef}`;
        });

        const title = `Pending Applications (${applications.length})`;
        const pages = paginateLines(lines);

        if (pages.length === 1) {
          const embed = buildPageEmbed(title, pages[0], 1, 1);
          await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        } else {
          const embed = buildPageEmbed(title, pages[0], 1, pages.length);
          const buttons = buildPageButtons('applications', 1, pages.length);
          const { resource } = await interaction.reply({
            embeds: [embed],
            components: buttons ? [buttons] : [],
            flags: MessageFlags.Ephemeral,
            withResponse: true,
          });
          // withResponse: true guarantees resource.message is present
          cachePaginatedData(`applications:${resource!.message!.id}`, title, pages);
        }
        break;
      }

      case 'set_accept_message': {
        const db = getDatabase();
        const current = db
          .prepare('SELECT message FROM default_messages WHERE key = ?')
          .get('application_accept') as { message: string } | undefined;

        const modal = new ModalBuilder()
          .setCustomId('application:modal:accept_message')
          .setTitle('Set Accept Message');

        const messageInput = new TextInputBuilder()
          .setCustomId('message')
          .setLabel('Accept DM Message')
          .setStyle(TextInputStyle.Paragraph)
          .setValue(current?.message ?? '')
          .setRequired(true)
          .setMaxLength(2000);

        const row = new ActionRowBuilder<TextInputBuilder>().addComponents(messageInput);
        modal.addComponents(row);

        await interaction.showModal(modal);
        break;
      }

      case 'set_reject_message': {
        const db = getDatabase();
        const current = db
          .prepare('SELECT message FROM default_messages WHERE key = ?')
          .get('application_reject') as { message: string } | undefined;

        const modal = new ModalBuilder()
          .setCustomId('application:modal:reject_message')
          .setTitle('Set Reject Message');

        const messageInput = new TextInputBuilder()
          .setCustomId('message')
          .setLabel('Reject DM Message')
          .setStyle(TextInputStyle.Paragraph)
          .setValue(current?.message ?? '')
          .setRequired(true)
          .setMaxLength(2000);

        const row = new ActionRowBuilder<TextInputBuilder>().addComponents(messageInput);
        modal.addComponents(row);

        await interaction.showModal(modal);
        break;
      }
    }
  },
};
