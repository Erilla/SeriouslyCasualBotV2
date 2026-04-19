import { type Client, ChannelType, type TextChannel } from 'discord.js';
import { logger } from '../../services/logger.js';
import { config } from '../../config.js';
import { getOrCreateChannel } from '../channels.js';
import { getRaidStaticData } from '../../services/raiderio.js';
import { addLootPost } from './addLootPost.js';

export async function checkRaidExpansions(client: Client): Promise<void> {
  let channel: TextChannel;
  try {
    const guild = await client.guilds.fetch(config.guildId);
    channel = await getOrCreateChannel(guild, {
      name: 'loot',
      type: ChannelType.GuildText,
      categoryName: 'Raiders',
      configKey: 'loot_channel_id',
      aliasNames: ['loot-priorities'],
    });
  } catch (error) {
    logger.error('Loot', 'Failed to resolve loot channel', error as Error);
    return;
  }

  const now = new Date();
  let expansion = 9;
  let done = false;

  while (!done) {
    try {
      const staticData = await getRaidStaticData(expansion);

      // Sort raids: past raids first (by end date), then current/future
      const raids = staticData.raids.sort((a, b) => {
        const aEnd = a.ends.eu ? new Date(a.ends.eu).getTime() : Infinity;
        const bEnd = b.ends.eu ? new Date(b.ends.eu).getTime() : Infinity;
        return aEnd - bEnd;
      });

      // Find the first raid where ends.eu > now or ends.eu is null (current tier)
      const currentRaid = raids.find((raid) => {
        if (raid.ends.eu === null) return true;
        return new Date(raid.ends.eu) > now;
      });

      if (currentRaid) {
        logger.info('Loot', `Found current raid: ${currentRaid.name} (expansion ${expansion})`);

        for (const encounter of currentRaid.encounters) {
          await addLootPost(channel, {
            id: encounter.id,
            name: encounter.name,
          });
        }

        logger.info('Loot', `Raid expansion check complete: created ${currentRaid.encounters.length} loot posts for "${currentRaid.name}"`);

        // Found and processed the current raid, we're done
        done = true;
      }

      expansion++;
    } catch {
      // API returned error (e.g. 400 for unknown expansion) - no more expansions
      done = true;
    }
  }
}
