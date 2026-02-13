import { getDatabase } from '../../database/database.js';
import type { ChannelConfigRow } from '../../types/index.js';

/**
 * Get a configured channel/role ID by key.
 * Returns null if not configured.
 */
export function getChannel(key: string): string | null {
    const db = getDatabase();
    const row = db.prepare('SELECT channel_id FROM channel_config WHERE key = ?').get(key) as ChannelConfigRow | undefined;
    return row?.channel_id ?? null;
}

/**
 * Check if the bot has been set up (at least one channel configured).
 */
export function isSetupComplete(): boolean {
    const db = getDatabase();
    const row = db.prepare('SELECT COUNT(*) as count FROM channel_config').get() as { count: number };
    return row.count > 0;
}
