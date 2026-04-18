import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';

export default {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check bot latency'),
  async execute(interaction: ChatInputCommandInteraction) {
    const response = await interaction.reply({ content: 'Pinging...', withResponse: true });
    const created = response.resource?.message?.createdTimestamp;
    const latency = created ? created - interaction.createdTimestamp : -1;
    const apiLatency = Math.round(interaction.client.ws.ping);
    await interaction.editReply(
      latency >= 0
        ? `Pong! Latency: ${latency}ms | API Latency: ${apiLatency}ms`
        : `Pong! API Latency: ${apiLatency}ms`,
    );
  },
};
