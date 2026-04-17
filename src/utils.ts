import {
  type ChatInputCommandInteraction,
  type Channel,
  type TextChannel,
  type GuildMember,
  ChannelType,
  MessageFlags,
  EmbedBuilder,
  Colors,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { config } from './config.js';
import { audit } from './services/auditLog.js';

/**
 * Narrow a channel to a sendable text channel. Returns null if not sendable.
 */
export function asSendable(channel: Channel | null): TextChannel | null {
  if (!channel) return null;
  if (channel.type === ChannelType.GuildText || channel.type === ChannelType.PublicThread) {
    return channel as TextChannel;
  }
  return null;
}

/**
 * Check if the interaction member has the officer role.
 * Replies with ephemeral error if not authorized.
 * Returns true if authorized, false otherwise.
 */
export async function requireOfficer(interaction: ChatInputCommandInteraction): Promise<boolean> {
  const member = interaction.member as GuildMember;
  if (!member.roles.cache.has(config.officerRoleId)) {
    await interaction.reply({
      content: 'You do not have permission to use this command.',
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }
  return true;
}

/**
 * Create a standard green embed with timestamp.
 */
export function createEmbed(title?: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTimestamp()
    .setFooter({ text: 'SeriouslyCasualBot' });
  if (title) embed.setTitle(title);
  return embed;
}

/**
 * Build pagination buttons for lists.
 */
export function paginationRow(currentPage: number, totalPages: number, customIdPrefix: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:prev:${currentPage}`)
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage <= 0),
    new ButtonBuilder()
      .setCustomId(`${customIdPrefix}:next:${currentPage}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(currentPage >= totalPages - 1),
  );
}

// Re-export audit for convenience
export { audit };
