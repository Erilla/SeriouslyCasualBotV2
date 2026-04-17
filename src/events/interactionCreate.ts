import { type Interaction, MessageFlags } from 'discord.js';
import type { BotClient } from '../types/index.js';
import { logger } from '../services/logger.js';
import { updateRaiderDiscordUser } from '../functions/raids/updateRaiderDiscordUser.js';
import { ignoreCharacter } from '../functions/raids/ignoreCharacter.js';
import { sendAlertForRaidersWithNoUser } from '../functions/raids/sendAlertForRaidersWithNoUser.js';
import { audit } from '../services/auditLog.js';
import { getDatabase } from '../database/db.js';
import type { RaiderRow } from '../types/index.js';

export default {
  name: 'interactionCreate',
  async execute(...args: unknown[]) {
    const interaction = args[0] as Interaction;

    if (interaction.isChatInputCommand()) {
      const client = interaction.client as BotClient;
      const command = client.commands.get(interaction.commandName);

      if (!command) {
        logger.warn('interaction', `Unknown command: ${interaction.commandName}`);
        return;
      }

      try {
        await command.execute(interaction);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('interaction', `Command ${interaction.commandName} failed: ${err.message}`, err);

        const reply = { content: 'There was an error executing this command.', flags: MessageFlags.Ephemeral } as const;
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply).catch(() => {});
        } else {
          await interaction.reply(reply).catch(() => {});
        }
      }
    }

    // Button handlers
    if (interaction.isButton()) {
      const customId = interaction.customId;

      try {
        // raider:confirm_link:{characterName}:{userId}
        if (customId.startsWith('raider:confirm_link:')) {
          const parts = customId.split(':');
          const characterName = parts[2];
          const userId = parts[3];

          const success = await updateRaiderDiscordUser(
            interaction.client,
            characterName,
            userId,
          );

          if (success) {
            await audit(interaction.user, 'confirmed raider link', `${characterName} -> <@${userId}>`);
            await interaction.update({
              content: `Linked **${characterName}** to <@${userId}>!`,
              components: [],
            });
          } else {
            await interaction.reply({
              content: `Failed to link **${characterName}**.`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }

        // raider:reject_link:{characterName}
        if (customId.startsWith('raider:reject_link:')) {
          const characterName = customId.split(':')[2];

          try {
            await interaction.message.delete();
          } catch {
            // Message may already be deleted
          }

          // Post standard missing user alert (unmatched style)
          const db = getDatabase();
          const raider = db
            .prepare('SELECT * FROM raiders WHERE character_name = ?')
            .get(characterName) as RaiderRow | undefined;

          if (raider) {
            // Clear the old message_id since we deleted it
            db.prepare('UPDATE raiders SET message_id = NULL WHERE character_name = ?').run(characterName);
            await sendAlertForRaidersWithNoUser(interaction.client, [raider], []);
          }
        }

        // raider:ignore:{characterName}
        if (customId.startsWith('raider:ignore:')) {
          const characterName = customId.split(':')[2];
          const success = ignoreCharacter(characterName);

          if (success) {
            await audit(interaction.user, 'ignored character via button', characterName);

            try {
              await interaction.message.delete();
            } catch {
              // Message may already be deleted
            }

            await interaction.reply({
              content: `Ignored **${characterName}** and removed from raiders.`,
              flags: MessageFlags.Ephemeral,
            });
          } else {
            await interaction.reply({
              content: `Failed to ignore **${characterName}**.`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('interaction', `Button handler failed (${customId}): ${err.message}`, err);

        const reply = { content: 'An error occurred handling this button.', flags: MessageFlags.Ephemeral } as const;
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply).catch(() => {});
        } else {
          await interaction.reply(reply).catch(() => {});
        }
      }
    }

    // User select menu handlers
    if (interaction.isUserSelectMenu()) {
      const customId = interaction.customId;

      try {
        // raider:select_user:{characterName}
        if (customId.startsWith('raider:select_user:')) {
          const characterName = customId.split(':')[2];
          const selectedUserId = interaction.values[0];

          const success = await updateRaiderDiscordUser(
            interaction.client,
            characterName,
            selectedUserId,
          );

          if (success) {
            await audit(interaction.user, 'linked raider via select', `${characterName} -> <@${selectedUserId}>`);

            try {
              await interaction.message.delete();
            } catch {
              // Message may already be deleted
            }

            await interaction.reply({
              content: `Linked **${characterName}** to <@${selectedUserId}>.`,
              flags: MessageFlags.Ephemeral,
            });
          } else {
            await interaction.reply({
              content: `Failed to link **${characterName}**.`,
              flags: MessageFlags.Ephemeral,
            });
          }
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logger.error('interaction', `Select menu handler failed (${customId}): ${err.message}`, err);

        const reply = { content: 'An error occurred handling this selection.', flags: MessageFlags.Ephemeral } as const;
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(reply).catch(() => {});
        } else {
          await interaction.reply(reply).catch(() => {});
        }
      }
    }
  },
};
