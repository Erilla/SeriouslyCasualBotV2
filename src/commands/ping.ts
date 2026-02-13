import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { Command } from '../types/index.js';

const command: Command = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Check if the bot is responsive'),

    async execute(interaction: ChatInputCommandInteraction) {
        const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
        const latency = sent.createdTimestamp - interaction.createdTimestamp;
        const apiLatency = Math.round(interaction.client.ws.ping);

        await interaction.editReply(
            `Pong! Latency: ${latency}ms | API Latency: ${apiLatency}ms`
        );
    },
};

export default command;
