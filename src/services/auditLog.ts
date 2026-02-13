import { type ChatInputCommandInteraction, type TextChannel } from 'discord.js';
import { logger } from './logger.js';

let auditChannel: TextChannel | null = null;

export const auditLog = {
    /**
     * Set the audit log channel. Called when /setup configures the audit channel.
     */
    setChannel(channel: TextChannel): void {
        auditChannel = channel;
    },

    /**
     * Log a command execution to the audit channel.
     */
    async logCommand(interaction: ChatInputCommandInteraction): Promise<void> {
        const user = interaction.user;
        const command = interaction.commandName;
        const subcommand = interaction.options.getSubcommand(false);
        const args = interaction.options.data
            .flatMap((opt) => {
                if (opt.options) {
                    return opt.options.map((sub) => `${sub.name}=${sub.value ?? ''}`);
                }
                return [`${opt.name}=${opt.value ?? ''}`];
            })
            .join(' ');

        const commandStr = subcommand ? `/${command} ${subcommand}` : `/${command}`;
        const message = `<@${user.id}> ran \`${commandStr}\`${args ? ` [${args}]` : ''}`;

        await logger.debug(`[Audit] ${user.tag} ran ${commandStr}${args ? ` [${args}]` : ''}`);

        if (!auditChannel) return;

        try {
            await auditChannel.send({
                content: message,
                allowedMentions: { parse: [] },
            });
        } catch {
            await logger.warn('Failed to post to audit channel');
        }
    },
};
