import {
    type Client,
    type TextChannel,
    ActionRowBuilder,
    UserSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
} from 'discord.js';
import { getChannel } from '../setup/getChannel.js';
import { asSendable } from '../../utils.js';
import { getDatabase } from '../../database/database.js';
import { logger } from '../../services/logger.js';
import type { RaiderRow } from '../../types/index.js';

/**
 * Send alerts to the bot_setup channel for raiders that have no Discord user linked.
 * Each raider gets a message with a user select dropdown and an "Ignore character" button.
 * Optionally pass specific character names to check (e.g. newly added raiders).
 */
export async function sendAlertForRaidersWithNoUser(
    client: Client,
    specificNames?: string[],
): Promise<void> {
    const channelId = getChannel('bot_setup');
    if (!channelId) return;

    const channel = await client.channels.fetch(channelId);
    const sendable = asSendable(channel);
    if (!sendable) return;

    const textChannel = sendable as TextChannel;

    const db = getDatabase();
    let missingUsers: string[];

    if (specificNames) {
        missingUsers = specificNames;
    } else {
        const rows = db.prepare(
            'SELECT character_name FROM raiders WHERE discord_user_id IS NULL ORDER BY character_name COLLATE NOCASE',
        ).all() as Pick<RaiderRow, 'character_name'>[];
        missingUsers = rows.map((r) => r.character_name);
    }

    if (missingUsers.length === 0) return;

    for (const name of missingUsers) {
        const selectRow = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
            new UserSelectMenuBuilder()
                .setCustomId(`missing_user_select:${name}`)
                .setPlaceholder(`Select user for ${name}`)
                .setMinValues(1)
                .setMaxValues(1),
        );

        const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`ignore_missing_character:${name}`)
                .setLabel('Ignore character')
                .setStyle(ButtonStyle.Danger),
        );

        await textChannel.send({
            content: name,
            components: [selectRow, buttonRow],
        });
    }

    await logger.debug(`[Raiders] Alerted ${missingUsers.length} raiders with no Discord user`);
}
