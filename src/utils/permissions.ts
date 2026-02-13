import { type GuildMember, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { logger } from '../services/logger.js';
import { getChannel } from '../functions/setup/getChannel.js';

/**
 * Check if a guild member has the admin role.
 * The admin role ID can be stored in channel_config via /setup set_channel admin_role.
 * Falls back to checking Discord's Administrator permission.
 */
export async function isAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
    const member = interaction.member as GuildMember | null;
    if (!member) return false;

    // Check Discord Administrator permission
    if (member.permissions.has('Administrator')) return true;

    // Check admin role from channel_config table
    try {
        const adminRoleId = getChannel('admin_role');
        if (adminRoleId && member.roles.cache.has(adminRoleId)) return true;
    } catch {
        // DB may not be initialized yet - fall through
    }

    return false;
}

/**
 * Reply with a permission denied message if the user is not an admin.
 * Returns true if the check passed (user IS admin), false if denied.
 */
export async function requireAdmin(interaction: ChatInputCommandInteraction): Promise<boolean> {
    if (await isAdmin(interaction)) return true;

    await interaction.reply({
        content: 'You do not have permission to use this command.',
        flags: MessageFlags.Ephemeral,
    });

    await logger.warn(`${interaction.user.tag} attempted admin command /${interaction.commandName}`);
    return false;
}
