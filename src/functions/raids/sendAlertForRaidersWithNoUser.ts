import {
  type Client,
  type TextChannel,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  UserSelectMenuBuilder,
} from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { config } from '../../config.js';
import { getOrCreateChannel } from '../channels.js';
import type { RaiderRow } from '../../types/index.js';
import type { AutoMatch } from './autoMatchRaiders.js';

export async function sendAlertForRaidersWithNoUser(
  client: Client,
  newUnlinkedRaiders: RaiderRow[],
  autoMatches: AutoMatch[],
): Promise<void> {
  const guild = await client.guilds.fetch(config.guildId);
  const channel = (await getOrCreateChannel(guild, {
    name: 'raider-setup',
    type: ChannelType.GuildText,
    categoryName: 'SeriouslyCasual Bot',
    configKey: 'raider_setup_channel_id',
  })) as TextChannel;

  const db = getDatabase();
  const autoMatchMap = new Map(
    autoMatches.map((m) => [m.raider.character_name.toLowerCase(), m]),
  );

  // Send messages for auto-matched raiders
  for (const match of autoMatches) {
    const { raider, suggestedUser } = match;

    try {
      const confirmButton = new ButtonBuilder()
        .setCustomId(`raider:confirm_link:${raider.character_name}:${suggestedUser.id}`)
        .setLabel('Confirm')
        .setStyle(ButtonStyle.Success);

      const rejectButton = new ButtonBuilder()
        .setCustomId(`raider:reject_link:${raider.character_name}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger);

      const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        confirmButton,
        rejectButton,
      );

      const userSelect = new UserSelectMenuBuilder()
        .setCustomId(`raider:select_user:${raider.character_name}`)
        .setPlaceholder('Select a different user...');

      const selectRow = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);

      const message = await channel.send({
        content: `Link **${raider.character_name}** to ${suggestedUser}?`,
        components: [buttonRow, selectRow],
      });

      db.prepare('UPDATE raiders SET message_id = ? WHERE character_name = ?').run(
        message.id,
        raider.character_name,
      );
    } catch (error) {
      logger.error(
        'RaiderAlerts',
        `Failed to send auto-match alert for "${raider.character_name}"`,
        error as Error,
      );
    }
  }

  // Send messages for unmatched raiders
  for (const raider of newUnlinkedRaiders) {
    if (autoMatchMap.has(raider.character_name.toLowerCase())) continue;

    try {
      const userSelect = new UserSelectMenuBuilder()
        .setCustomId(`raider:select_user:${raider.character_name}`)
        .setPlaceholder('Select a user...');

      const selectRow = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);

      const ignoreButton = new ButtonBuilder()
        .setCustomId(`raider:ignore:${raider.character_name}`)
        .setLabel('Ignore')
        .setStyle(ButtonStyle.Danger);

      const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(ignoreButton);

      const message = await channel.send({
        content: `**${raider.character_name}**`,
        components: [selectRow, buttonRow],
      });

      db.prepare('UPDATE raiders SET message_id = ? WHERE character_name = ?').run(
        message.id,
        raider.character_name,
      );
    } catch (error) {
      logger.error(
        'RaiderAlerts',
        `Failed to send unmatched alert for "${raider.character_name}"`,
        error as Error,
      );
    }
  }

  logger.info(
    'RaiderAlerts',
    `Sent ${autoMatches.length} auto-match alerts and ${newUnlinkedRaiders.length - autoMatches.length} unmatched alerts`,
  );
}
