import { MessageFlags } from 'discord.js';
import type { ButtonInteraction, UserSelectMenuInteraction } from 'discord.js';
import type { ButtonHandler, UserSelectHandler } from './registry.js';
import { getDatabase } from '../database/db.js';
import { audit } from '../services/auditLog.js';
import { updateRaiderDiscordUser } from '../functions/raids/updateRaiderDiscordUser.js';
import { ignoreCharacter } from '../functions/raids/ignoreCharacter.js';
import { sendAlertForRaidersWithNoUser } from '../functions/raids/sendAlertForRaidersWithNoUser.js';
import type { RaiderRow } from '../types/index.js';

async function confirmLink(interaction: ButtonInteraction, params: string[]): Promise<void> {
  // customId: raider:confirm_link:{characterName}:{userId}
  const characterName = params[0];
  const userId = params[1];

  const success = await updateRaiderDiscordUser(interaction.client, characterName, userId);

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

async function rejectLink(interaction: ButtonInteraction, params: string[]): Promise<void> {
  // customId: raider:reject_link:{characterName}
  const characterName = params[0];

  try {
    await interaction.message.delete();
  } catch {
    // Message may already be deleted
  }

  const db = getDatabase();
  const raider = db
    .prepare('SELECT * FROM raiders WHERE character_name = ?')
    .get(characterName) as RaiderRow | undefined;

  if (raider) {
    db.prepare('UPDATE raiders SET message_id = NULL WHERE character_name = ?').run(characterName);
    await sendAlertForRaidersWithNoUser(interaction.client, [raider], []);
  }
}

async function ignore(interaction: ButtonInteraction, params: string[]): Promise<void> {
  // customId: raider:ignore:{characterName}
  const characterName = params[0];
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

async function selectUser(interaction: UserSelectMenuInteraction, params: string[]): Promise<void> {
  // customId: raider:select_user:{characterName}
  const characterName = params[0];
  const selectedUserId = interaction.values[0];

  const success = await updateRaiderDiscordUser(interaction.client, characterName, selectedUserId);

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

export const buttons: ButtonHandler[] = [
  { prefix: 'raider:confirm_link', handle: confirmLink },
  { prefix: 'raider:reject_link', handle: rejectLink },
  { prefix: 'raider:ignore', handle: ignore },
];

export const userSelects: UserSelectHandler[] = [
  { prefix: 'raider:select_user', handle: selectUser },
];
