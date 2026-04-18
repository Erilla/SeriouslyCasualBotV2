import { type Client, type TextChannel, ChannelType } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { config } from '../../config.js';
import { getRaidStaticData } from '../../services/raiderio.js';
import { addLootPost } from './addLootPost.js';
import type { ConfigRow } from '../../types/index.js';

async function getLootChannel(client: Client): Promise<TextChannel | null> {
  const db = getDatabase();

  const row = db
    .prepare('SELECT value FROM config WHERE key = ?')
    .get('loot_channel_id') as ConfigRow | undefined;

  if (row) {
    try {
      const channel = await client.channels.fetch(row.value);
      if (channel && channel.type === ChannelType.GuildText) {
        return channel as TextChannel;
      }
    } catch {
      logger.warn('Loot', 'Configured loot channel not found, will auto-create');
    }
  }

  // Auto-create the channel
  try {
    const guild = await client.guilds.fetch(config.guildId);
    const channel = await guild.channels.create({
      name: 'loot-priorities',
      type: ChannelType.GuildText,
      topic: 'Loot priority declarations per boss',
    });

    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(
      'loot_channel_id',
      channel.id,
    );

    logger.info('Loot', `Auto-created loot channel: #${channel.name}`);
    return channel;
  } catch (error) {
    logger.error('Loot', 'Failed to auto-create loot channel', error as Error);
    return null;
  }
}

export async function checkRaidExpansions(client: Client): Promise<void> {
  const channel = await getLootChannel(client);
  if (!channel) {
    logger.warn('Loot', 'No loot channel available, skipping raid expansion check');
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
