import { getDatabase } from '../../database/database.js';
import type { SettingsRow } from '../../types/index.js';

/**
 * Get a single setting value by key. Returns null if not found.
 */
export function getSetting(key: string): string | null {
    const db = getDatabase();
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as SettingsRow | undefined;
    return row?.value ?? null;
}

/**
 * Get a boolean setting. Defaults to false if not found.
 */
export function getBooleanSetting(key: string): boolean {
    return getSetting(key) === 'true';
}
