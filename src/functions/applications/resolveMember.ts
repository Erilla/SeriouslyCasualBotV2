import type { ButtonInteraction, ChatInputCommandInteraction, GuildMember } from 'discord.js';

/**
 * The applicant's guild membership, used only for the raider-role check.
 *
 * Fetched rather than read from `interaction.member`, which is a partial
 * APIInteractionGuildMember outside the gateway cache. A failure resolves to
 * null, which skips the check rather than refusing anyone incorrectly.
 */
export async function resolveMember(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<GuildMember | null> {
  if (!interaction.guild) return null;
  return await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
}
