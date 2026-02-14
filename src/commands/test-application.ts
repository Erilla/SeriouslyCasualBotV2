import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    type CategoryChannel,
    type TextChannel,
    ChannelType,
    MessageFlags,
    PermissionFlagsBits,
} from 'discord.js';
import type { ApplicationRow, BotClient, Command } from '../types/index.js';
import { requireAdmin } from '../utils/permissions.js';
import { getChannel } from '../functions/setup/getChannel.js';
import { getDatabase } from '../database/database.js';
import { generateRandomApplication } from '../functions/applications/testApplicationData.js';
import { copyApplicationToViewer } from '../functions/applications/copyApplicationToViewer.js';

const command: Command = {
    testOnly: true,

    data: new SlashCommandBuilder()
        .setName('test-application')
        .setDescription('[DEV] Simulate a 3rd party bot legacy application')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption((opt) =>
            opt.setName('applicant')
                .setDescription('User to attribute the application to (defaults to you)'),
        ),

    async execute(interaction: ChatInputCommandInteraction) {
        if (!(await requireAdmin(interaction))) return;

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Resolve applicant
        const applicant = interaction.options.getUser('applicant') ?? interaction.user;

        // Get applications category
        const categoryId = getChannel('applications_category');
        if (!categoryId) {
            await interaction.editReply('`applications_category` is not configured. Use `/setup set_channel` first.');
            return;
        }

        const client = interaction.client as BotClient;
        const category = await client.channels.fetch(categoryId) as CategoryChannel | null;
        if (!category || category.type !== ChannelType.GuildCategory) {
            await interaction.editReply('`applications_category` is not a valid category channel.');
            return;
        }

        // Generate random application data
        const { characterName, embeds } = generateRandomApplication(applicant.id);

        // Create channel under the applications category
        const guild = interaction.guild;
        if (!guild) {
            await interaction.editReply('This command must be used in a guild.');
            return;
        }

        const channelName = `app-${characterName.toLowerCase()}`;
        const appChannel = await guild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: categoryId,
        });

        // Send embeds as separate messages (mimicking the 3rd party bot)
        for (const embed of embeds) {
            await appChannel.send({ embeds: [embed] });
        }

        // Check prerequisites before processing
        const forumId = getChannel('applications_forum');
        if (!forumId) {
            await interaction.editReply(
                `Channel <#${appChannel.id}> created with test messages, but **no forum post** — ` +
                '`applications_forum` is not configured. Use `/setup set_channel` first.',
            );
            return;
        }

        // Process immediately — don't wait for the scheduled job
        await copyApplicationToViewer(client, appChannel as TextChannel);

        // Check if the forum post was actually created
        const db = getDatabase();
        const app = db
            .prepare('SELECT * FROM applications WHERE channel_id = ?')
            .get(appChannel.id) as ApplicationRow | undefined;

        if (!app?.forum_post_id) {
            await interaction.editReply(
                `Channel <#${appChannel.id}> created with test messages, but **forum post creation failed**. ` +
                'Check the log channel for details.',
            );
            return;
        }

        await interaction.editReply(
            `Test application created!\n` +
            `- **Channel:** <#${appChannel.id}>\n` +
            `- **Forum post:** <#${app.forum_post_id}>\n` +
            `- **Character:** ${characterName}\n` +
            `- **Applicant:** <@${applicant.id}>`,
        );
    },
};

export default command;
