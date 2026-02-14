import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    MessageFlags,
    PermissionFlagsBits,
    EmbedBuilder,
    Colors,
} from 'discord.js';
import type { Command } from '../types/index.js';
import { requireAdmin } from '../utils/permissions.js';
import {
    getQuestionsFormatted,
    addQuestion,
    removeQuestion,
    getAllQuestions,
} from '../functions/applications/applicationQuestions.js';
import { buildApplyButton } from '../functions/applications/startApplication.js';
import { getDatabase } from '../database/database.js';
import type { ApplicationRow } from '../types/index.js';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('applications')
        .setDescription('Manage the application system')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addSubcommand((sub) =>
            sub.setName('list_questions')
                .setDescription('List all active application questions'),
        )
        .addSubcommand((sub) =>
            sub.setName('add_question')
                .setDescription('Add a new application question')
                .addStringOption((opt) =>
                    opt.setName('question')
                        .setDescription('The question text')
                        .setRequired(true),
                ),
        )
        .addSubcommand((sub) =>
            sub.setName('remove_question')
                .setDescription('Remove an application question by ID')
                .addIntegerOption((opt) =>
                    opt.setName('id')
                        .setDescription('Question ID (use list_questions to see IDs)')
                        .setRequired(true),
                ),
        )
        .addSubcommand((sub) =>
            sub.setName('post_apply_button')
                .setDescription('Post an "Apply Now" button in the current channel'),
        )
        .addSubcommand((sub) =>
            sub.setName('view_pending')
                .setDescription('View all pending applications'),
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        if (!(await requireAdmin(interaction))) return;

        const sub = interaction.options.getSubcommand();

        switch (sub) {
            case 'list_questions': {
                const list = getQuestionsFormatted();
                const embed = new EmbedBuilder()
                    .setTitle('Application Questions')
                    .setDescription(list)
                    .setColor(Colors.Blue);
                await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
                break;
            }

            case 'add_question': {
                const question = interaction.options.getString('question', true);
                if (addQuestion(question)) {
                    await interaction.reply({
                        content: `Question added: "${question}"`,
                        flags: MessageFlags.Ephemeral,
                    });
                } else {
                    await interaction.reply({
                        content: 'Failed to add question.',
                        flags: MessageFlags.Ephemeral,
                    });
                }
                break;
            }

            case 'remove_question': {
                const id = interaction.options.getInteger('id', true);
                const allQuestions = getAllQuestions();
                const target = allQuestions.find((q) => q.id === id);
                if (!target) {
                    await interaction.reply({
                        content: `Question ID ${id} not found.`,
                        flags: MessageFlags.Ephemeral,
                    });
                    break;
                }
                if (removeQuestion(id)) {
                    await interaction.reply({
                        content: `Question removed: "${target.question_text}"`,
                        flags: MessageFlags.Ephemeral,
                    });
                } else {
                    await interaction.reply({
                        content: `Failed to remove question ID ${id}.`,
                        flags: MessageFlags.Ephemeral,
                    });
                }
                break;
            }

            case 'post_apply_button': {
                const row = buildApplyButton();
                const embed = new EmbedBuilder()
                    .setTitle('Apply to SeriouslyCasual')
                    .setDescription(
                        'Interested in joining our guild? Click the button below to start your application!\n\n' +
                        'You\'ll be asked a series of questions via DM.',
                    )
                    .setColor(Colors.Green);

                const channel = interaction.channel;
                if (channel && 'send' in channel) {
                    await channel.send({ embeds: [embed], components: [row] });
                }
                await interaction.reply({
                    content: 'Apply button posted!',
                    flags: MessageFlags.Ephemeral,
                });
                break;
            }

            case 'view_pending': {
                const db = getDatabase();
                const pending = db
                    .prepare("SELECT * FROM applications WHERE status = 'pending' ORDER BY submitted_at DESC")
                    .all() as ApplicationRow[];

                if (pending.length === 0) {
                    await interaction.reply({
                        content: 'No pending applications.',
                        flags: MessageFlags.Ephemeral,
                    });
                    break;
                }

                const list = pending.map((app) =>
                    `<@${app.user_id}> — Submitted: ${app.submitted_at}` +
                    (app.forum_post_id ? ` — [Forum Post](https://discord.com/channels/${interaction.guildId}/${app.forum_post_id})` : ''),
                ).join('\n');

                const embed = new EmbedBuilder()
                    .setTitle(`Pending Applications (${pending.length})`)
                    .setDescription(list)
                    .setColor(Colors.Gold);

                await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
                break;
            }
        }
    },
};

export default command;
