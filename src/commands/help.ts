import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import type { BotClient } from '../types/index.js';
import { createEmbed } from '../utils.js';

export default {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('List all available commands'),
  async execute(interaction: ChatInputCommandInteraction) {
    const client = interaction.client as BotClient;

    const embed = createEmbed('Available Commands');

    const commandList = client.commands
      .map((cmd) => `\`/${cmd.data.name}\` - ${cmd.data.description}`)
      .join('\n');

    embed.setDescription(commandList || 'No commands loaded.');

    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};
