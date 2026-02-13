import {
    SlashCommandBuilder,
    type ChatInputCommandInteraction,
    EmbedBuilder,
    Colors,
    MessageFlags,
} from 'discord.js';
import type { BotClient, Command } from '../types/index.js';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('List all available commands'),

    async execute(interaction: ChatInputCommandInteraction) {
        const client = interaction.client as BotClient;

        const embed = new EmbedBuilder()
            .setTitle('SeriouslyCasual Bot - Commands')
            .setColor(Colors.Blue)
            .setDescription('Here are all available commands:')
            .setTimestamp();

        const commands = [...client.commands.values()];
        for (const cmd of commands) {
            const name = `/${cmd.data.name}`;
            const description = cmd.data.description || 'No description';
            embed.addFields({ name, value: description, inline: false });
        }

        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    },
};

export default command;
