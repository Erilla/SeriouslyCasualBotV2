import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Colors,
} from 'discord.js';

export interface PlayerResponses {
  major: string;
  minor: string;
  wantIn: string;
  wantOut: string;
}

export function generateLootPost(
  bossName: string,
  bossId: number,
  playerResponses: PlayerResponses,
): { embeds: [EmbedBuilder]; components: [ActionRowBuilder<ButtonBuilder>] } {
  const embed = new EmbedBuilder()
    .setColor(Colors.Green)
    .setTitle(bossName)
    .setTimestamp()
    .addFields(
      { name: 'Major', value: playerResponses.major, inline: true },
      { name: 'Minor', value: playerResponses.minor, inline: true },
      { name: 'Want In', value: playerResponses.wantIn, inline: true },
      { name: 'Do not need', value: playerResponses.wantOut, inline: true },
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`loot:major:${bossId}`)
      .setLabel('Major')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`loot:minor:${bossId}`)
      .setLabel('Minor')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`loot:wantIn:${bossId}`)
      .setLabel('Want In')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`loot:wantOut:${bossId}`)
      .setLabel('Do not need')
      .setStyle(ButtonStyle.Danger),
  );

  return { embeds: [embed], components: [row] };
}
