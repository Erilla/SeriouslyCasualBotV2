import { ChannelType, type Guild, type CategoryChannel } from 'discord.js';

export function getCategoryByName(guild: Guild, name: string): CategoryChannel | null {
  const target = name.toLowerCase();
  const match = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === target,
  );
  return (match as CategoryChannel | undefined) ?? null;
}
