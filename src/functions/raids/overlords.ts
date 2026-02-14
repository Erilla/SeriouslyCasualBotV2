import { getDatabase } from '../../database/database.js';
import type { OverlordRow } from '../../types/index.js';

/**
 * Add an overlord (guild leadership member).
 */
export function addOverlord(name: string, discordUserId: string): boolean {
    const db = getDatabase();
    try {
        db.prepare('INSERT INTO overlords (name, discord_user_id) VALUES (?, ?)').run(name, discordUserId);
        return true;
    } catch {
        return false;
    }
}

/**
 * Remove an overlord by name (case-insensitive).
 */
export function removeOverlord(name: string): boolean {
    const db = getDatabase();
    const result = db.prepare('DELETE FROM overlords WHERE LOWER(name) = LOWER(?)').run(name);
    return result.changes > 0;
}

/**
 * Get all overlords from the database.
 */
export function getOverlordsList(): OverlordRow[] {
    const db = getDatabase();
    return db.prepare('SELECT * FROM overlords ORDER BY name COLLATE NOCASE').all() as OverlordRow[];
}

/**
 * Get a formatted string of all overlords for display.
 */
export function getOverlordsFormatted(): string {
    const overlords = getOverlordsList();
    if (overlords.length === 0) return 'No overlords configured.';

    return overlords
        .map((o) => `${o.name} - <@${o.discord_user_id}>`)
        .join('\n');
}
