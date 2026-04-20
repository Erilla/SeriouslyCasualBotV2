import { MessageFlags } from 'discord.js';
import type { ButtonInteraction } from 'discord.js';
import type { ButtonHandler } from './registry.js';
import { getCachedPage, buildPageEmbed, buildPageButtons } from '../functions/pagination.js';

async function handlePage(interaction: ButtonInteraction, params: string[]): Promise<void> {
  // customId format: page:{commandName}:{targetPage}:{totalPages}
  // params = [commandName, targetPage, totalPages]
  const commandName = params[0];
  const page = parseInt(params[1], 10);

  const cacheKey = `${commandName}:${interaction.message.id}`;
  const data = getCachedPage(cacheKey, page);

  if (!data) {
    await interaction.reply({
      content: 'This list has expired. Please run the command again.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = buildPageEmbed(data.title, data.content, page, data.totalPages);
  const buttons = buildPageButtons(commandName, page, data.totalPages);
  await interaction.update({
    embeds: [embed],
    components: buttons ? [buttons] : [],
  });
}

export const buttons: ButtonHandler[] = [
  { prefix: 'page', handle: handlePage },
];
