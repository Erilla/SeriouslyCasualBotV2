import { getDatabase } from '../../database/database.js';

/**
 * Set a setting value. Creates the key if it doesn't exist.
 */
export function setSetting(key: string, value: string): void {
    const db = getDatabase();
    db.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, value);
}

/**
 * Toggle a boolean setting. Returns the new value.
 */
export function toggleSetting(key: string): boolean {
    const db = getDatabase();
    const toggle = db.transaction(() => {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
        const current = row?.value === 'true';
        const newValue = !current;

        db.prepare(
            'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
        ).run(key, String(newValue));

        return newValue;
    });
    return toggle();
}
