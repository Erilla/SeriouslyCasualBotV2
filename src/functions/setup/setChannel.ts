import { getDatabase } from '../../database/database.js';

/**
 * Set a channel/role configuration.
 * Upserts - creates if not exists, updates if it does.
 */
export function setChannel(key: string, channelId: string, guildId: string): void {
    const db = getDatabase();
    db.prepare(
        'INSERT INTO channel_config (key, channel_id, guild_id) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET channel_id = excluded.channel_id, guild_id = excluded.guild_id'
    ).run(key, channelId, guildId);
}
