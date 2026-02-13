import { ActivityType, REST, Routes, type TextChannel } from 'discord.js';
import type { BotClient, BotEvent } from '../types/index.js';
import { config } from '../config.js';
import { logger } from '../services/logger.js';
import { initScheduler } from '../scheduler/scheduler.js';
import { registerAllJobs } from '../scheduler/jobs.js';
import { isSetupComplete, getChannel } from '../functions/setup/getChannel.js';
import { auditLog } from '../services/auditLog.js';

const event: BotEvent = {
    name: 'clientReady',
    once: true,

    async execute(...args: unknown[]) {
        const client = args[0] as BotClient;

        // Initialize logger with Discord channels
        await logger.init(client, config.guildId);

        await logger.info(`Bot ready! Logged in as ${client.user?.tag}`);
        await logger.info(`Serving guild: ${config.guildId}`);
        await logger.info(`Loaded ${client.commands.size} commands`);

        // Register slash commands with Discord
        try {
            const rest = new REST({ version: '10' }).setToken(config.token);
            const commandData = [...client.commands.values()].map((c) => c.data.toJSON());
            await rest.put(
                Routes.applicationGuildCommands(config.clientId, config.guildId),
                { body: commandData }
            );
            await logger.info(`Registered ${commandData.length} slash commands`);
        } catch (error) {
            await logger.error('Failed to register slash commands', error);
        }

        // Set bot status based on setup state
        if (isSetupComplete()) {
            client.user?.setActivity('SeriouslyCasual', {
                type: ActivityType.Watching,
            });
        } else {
            client.user?.setActivity('Run /setup to configure', {
                type: ActivityType.Custom,
            });
        }

        // Initialize audit log channel if configured
        const auditChannelId = getChannel('audit');
        if (auditChannelId) {
            try {
                const guild = await client.guilds.fetch(config.guildId);
                const channel = await guild.channels.fetch(auditChannelId);
                if (channel?.isTextBased()) {
                    auditLog.setChannel(channel as TextChannel);
                }
            } catch {
                await logger.warn('Could not fetch configured audit channel');
            }
        }

        // Initialize BullMQ scheduler
        try {
            await initScheduler(client);
            await registerAllJobs();
        } catch (error) {
            await logger.error('Failed to initialize scheduler - scheduled tasks will not run', error);
        }
    },
};

export default event;
