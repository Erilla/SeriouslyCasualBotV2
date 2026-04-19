import { MessageFlags } from 'discord.js';
import type { ButtonInteraction, ModalSubmitInteraction, UserSelectMenuInteraction, GuildMember } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../services/logger.js';

export type InteractionKind = 'button' | 'modal' | 'select';

type Gatable = ButtonInteraction | ModalSubmitInteraction | UserSelectMenuInteraction;

export async function requireOfficer(interaction: Gatable, _kind: InteractionKind): Promise<boolean> {
  const member = interaction.member as GuildMember | null;
  if (member?.roles.cache.has(config.officerRoleId)) return true;

  await interaction.reply({
    content: 'You do not have permission to do this.',
    flags: MessageFlags.Ephemeral,
  }).catch(() => {});
  return false;
}

export async function wrapErrors(
  kind: InteractionKind,
  customId: string,
  interaction: Gatable,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error('interaction', `${kind} handler failed (${customId}): ${err.message}`, err);

    const reply = { content: `An error occurred handling this ${kind}.`, flags: MessageFlags.Ephemeral } as const;
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
}
