import { getDatabase } from '../../database/database.js';
import type { ChannelConfigRow } from '../../types/index.js';

/**
 * Get all channel/role configurations.
 */
export function getAllChannels(): ChannelConfigRow[] {
    const db = getDatabase();
    return db.prepare('SELECT key, channel_id, guild_id FROM channel_config ORDER BY key').all() as ChannelConfigRow[];
}
