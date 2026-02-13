import { getDatabase } from '../../database/database.js';
import type { SettingsRow } from '../../types/index.js';

/**
 * Get all settings as an array of key-value pairs.
 */
export function getAllSettings(): SettingsRow[] {
    const db = getDatabase();
    return db.prepare('SELECT key, value FROM settings ORDER BY key').all() as SettingsRow[];
}
