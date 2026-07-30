import {
  DiscordAPIError,
  RESTJSONErrorCodes,
  type MessageCreateOptions,
  type MessageEditOptions,
  type TextChannel,
} from 'discord.js';
import { getDatabase } from '../../database/db.js';

export const MANAGED_GUILD_INFO_KEYS = [
  'aboutus',
  'schedule',
  'recruitment',
  'achievements',
] as const;
export type ManagedGuildInfoKey = (typeof MANAGED_GUILD_INFO_KEYS)[number];

function isUnknownMessage(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage;
}

/** Create a tracked guild-info message or update its existing Discord message in place. */
export async function upsertGuildInfoMessage(
  channel: TextChannel,
  key: ManagedGuildInfoKey,
  payload: MessageCreateOptions & MessageEditOptions,
): Promise<void> {
  const db = getDatabase();
  const existing = db
    .prepare('SELECT message_id FROM guild_info_messages WHERE key = ?')
    .get(key) as { message_id: string } | undefined;

  if (existing) {
    try {
      const message = await channel.messages.fetch(existing.message_id);
      await message.edit(payload);
      return;
    } catch (error) {
      if (!isUnknownMessage(error)) {
        throw error;
      }
    }
  }

  const message = await channel.send(payload);
  db.prepare('INSERT OR REPLACE INTO guild_info_messages (key, message_id) VALUES (?, ?)').run(
    key,
    message.id,
  );
}

export function isUnknownGuildInfoMessage(error: unknown): boolean {
  return isUnknownMessage(error);
}
