import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check bot latency'),
  async execute(interaction: ChatInputCommandInteraction) {
    const response = await interaction.reply({ content: 'Pinging...', withResponse: true });
    const latency = response.resource!.message!.createdTimestamp - interaction.createdTimestamp;
    const apiLatency = Math.round(interaction.client.ws.ping);
    await interaction.editReply(`Pong! Latency: ${latency}ms | API Latency: ${apiLatency}ms`);
  },
};
