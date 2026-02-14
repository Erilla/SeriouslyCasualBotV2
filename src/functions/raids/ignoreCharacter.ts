import { getDatabase } from '../../database/database.js';
import type { IgnoredCharacterRow } from '../../types/index.js';

/**
 * Ignore a character (exclude from roster sync).
 * Also removes them from the raiders table if present.
 */
export function ignoreCharacter(characterName: string): boolean {
    const db = getDatabase();
    try {
        db.prepare('INSERT INTO ignored_characters (character_name) VALUES (?)').run(characterName);
        // Remove from raiders if present
        db.prepare('DELETE FROM raiders WHERE LOWER(character_name) = LOWER(?)').run(characterName);
        return true;
    } catch {
        return false;
    }
}

/**
 * Remove a character from the ignored list (case-insensitive).
 */
export function removeIgnoredCharacter(characterName: string): boolean {
    const db = getDatabase();
    const result = db.prepare('DELETE FROM ignored_characters WHERE LOWER(character_name) = LOWER(?)').run(characterName);
    return result.changes > 0;
}

/**
 * Get all ignored character names (lowercase) for filtering.
 */
export function getStoredIgnoredCharacters(): string[] {
    const db = getDatabase();
    const rows = db.prepare('SELECT character_name FROM ignored_characters').all() as IgnoredCharacterRow[];
    return rows.map((r) => r.character_name);
}

/**
 * Get a formatted string of all ignored characters for display.
 */
export function getIgnoredCharactersFormatted(): string {
    const characters = getStoredIgnoredCharacters();
    if (characters.length === 0) return 'No ignored characters.';
    return characters.join('\n');
}
