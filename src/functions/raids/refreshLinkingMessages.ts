import {
  type Client,
  type TextChannel,
  ChannelType,
  ActionRowBuilder,
  UserSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { config } from '../../config.js';
import { getOrCreateChannel } from '../channels.js';
import type { RaiderRow, ConfigRow } from '../../types/index.js';

export async function refreshLinkingMessages(client: Client): Promise<void> {
  const db = getDatabase();

  // Short-circuit when admin has never configured this. getOrCreateChannel
  // would auto-create otherwise, and we don't want a 10-minute job silently
  // spinning up #raider-setup on guilds that opted out of the feature.
  const configRow = db
    .prepare('SELECT value FROM config WHERE key = ?')
    .get('raider_setup_channel_id') as ConfigRow | undefined;

  if (!configRow) {
    logger.debug('RefreshLinks', 'No raider-setup channel configured, skipping refresh');
    return;
  }

  // The bot stays a member of the configured guild while running, so the
  // cache is the source of truth. Hitting the REST /guilds/:id endpoint on
  // every 10-min tick would be a waste. Fetch only as a safety net if the
  // cache hasn't populated yet (shouldn't happen after clientReady).
  const guild =
    client.guilds.cache.get(config.guildId) ??
    (await client.guilds.fetch(config.guildId).catch(() => null));
  if (!guild) {
    logger.error(
      'RefreshLinks',
      'Failed to resolve guild for raider-setup refresh',
      new Error(`guild ${config.guildId} not in cache and fetch failed`),
    );
    return;
  }

  // getOrCreateChannel self-heals a stale ID: fetch-by-ID fails → clear
  // config → name lookup → writeConfig with the current channel's ID.
  // Without this, a once-valid ID that points at a deleted channel would
  // warn every 10 minutes until an admin re-ran /setup set_channel (#36).
  let channel: TextChannel;
  try {
    channel = await getOrCreateChannel(guild, {
      name: 'raider-setup',
      type: ChannelType.GuildText,
      categoryName: 'SeriouslyCasual Bot',
      configKey: 'raider_setup_channel_id',
    });
  } catch (error) {
    logger.error(
      'RefreshLinks',
      'Failed to resolve raider-setup channel',
      error instanceof Error ? error : new Error(String(error)),
    );
    return;
  }

  // Every raider that still needs linking: unlinked and still on the roster.
  // This deliberately includes raiders with a NULL message_id — newly-synced
  // raiders whose alert never went out, and the pre-existing backlog — so the
  // refresh job is self-healing rather than only repositioning existing posts.
  // Raiders who have left the roster (missing_since set) are excluded; we don't
  // want to pester for someone who's gone.
  const unlinkedRaiders = db
    .prepare(
      'SELECT * FROM raiders WHERE discord_user_id IS NULL AND missing_since IS NULL',
    )
    .all() as RaiderRow[];

  // Message ids the channel should keep: exactly one live post per awaiting
  // raider. Everything else is swept below. We intentionally do NOT early-return
  // when the list is empty — the sweep still needs to clear any leftovers.
  const keepIds = new Set<string>();
  let refreshed = 0;

  for (const raider of unlinkedRaiders) {
    try {
      // If the raider already has a linking post, check whether it still
      // exists. We deliberately do NOT reposition based on scroll position:
      // the channel holds nothing but awaiting-raider posts, so leaving them
      // where they are is fine and avoids per-tick churn. Only a post that has
      // actually gone (deleted, or never created) gets a fresh one.
      if (raider.message_id) {
        try {
          await channel.messages.fetch(raider.message_id);
          keepIds.add(raider.message_id);
          continue; // post still exists — leave it untouched
        } catch {
          // Post is gone; fall through and create a replacement below.
        }
      }

      // Post the standard linking message (user select + ignore button)
      const userSelect = new UserSelectMenuBuilder()
        .setCustomId(`raider:select_user:${raider.character_name}`)
        .setPlaceholder('Select a user...');

      const selectRow = new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(userSelect);

      const ignoreButton = new ButtonBuilder()
        .setCustomId(`raider:ignore:${raider.character_name}`)
        .setLabel('Ignore')
        .setStyle(ButtonStyle.Danger);

      const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(ignoreButton);

      const newMessage = await channel.send({
        content: `**${raider.character_name}**`,
        components: [selectRow, buttonRow],
      });

      db.prepare('UPDATE raiders SET message_id = ? WHERE character_name = ?').run(
        newMessage.id,
        raider.character_name,
      );

      keepIds.add(newMessage.id);
      refreshed++;
    } catch (error) {
      logger.error(
        'RefreshLinks',
        `Failed to refresh message for "${raider.character_name}"`,
        error as Error,
      );
    }
  }

  // Sweep: the channel should contain nothing but the current awaiting-raider
  // posts. Delete everything else — stale confirmations, posts for raiders who
  // were linked/ignored or have left the roster, and any stray messages.
  // Pinned messages are left alone so officers can keep notes there.
  const swept = await sweepChannel(channel, keepIds);

  if (refreshed > 0 || swept > 0) {
    logger.info(
      'RefreshLinks',
      `Posted ${refreshed} linking message(s), swept ${swept} stale message(s)`,
    );
  }
}

const SWEEP_PAGE_SIZE = 100;
const SWEEP_MAX_PAGES = 10;

async function sweepChannel(channel: TextChannel, keepIds: Set<string>): Promise<number> {
  let swept = 0;
  let before: string | undefined;

  for (let page = 0; page < SWEEP_MAX_PAGES; page++) {
    let batch;
    try {
      batch = await channel.messages.fetch({ limit: SWEEP_PAGE_SIZE, before });
    } catch (error) {
      logger.error('RefreshLinks', 'Failed to fetch messages to sweep', error as Error);
      break;
    }

    if (batch.size === 0) break;

    const messages = [...batch.values()];
    for (const message of messages) {
      if (message.pinned || keepIds.has(message.id)) continue;
      try {
        await message.delete();
        swept++;
      } catch {
        // Message may already be gone, that's fine
      }
    }

    if (batch.size < SWEEP_PAGE_SIZE) break;
    before = messages[messages.length - 1]?.id;
  }

  if (swept >= SWEEP_PAGE_SIZE * SWEEP_MAX_PAGES) {
    logger.warn(
      'RefreshLinks',
      `Sweep hit the ${SWEEP_PAGE_SIZE * SWEEP_MAX_PAGES}-message cap; remaining stragglers will be cleared next run`,
    );
  }

  return swept;
}
