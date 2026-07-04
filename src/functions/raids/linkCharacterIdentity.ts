import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import type { RaiderIdentityMapRow } from '../../types/index.js';

/**
 * Record a character -> Discord user mapping in `raider_identity_map` so that a
 * future roster sync auto-links the character to their Discord account when it
 * appears in the guild (see syncRaiders).
 *
 * Existing mappings are never overwritten: an officer-set or earlier link wins
 * over self-asserted application data. Matching is case-insensitive, consistent
 * with how syncRaiders resolves the map.
 *
 * Returns true if a new mapping was created, false if one already existed.
 */
export function linkCharacterIdentity(characterName: string, discordUserId: string): boolean {
  const db = getDatabase();

  const existing = db
    .prepare(
      'SELECT character_name, discord_user_id FROM raider_identity_map WHERE character_name = ? COLLATE NOCASE',
    )
    .get(characterName) as RaiderIdentityMapRow | undefined;

  if (existing) {
    if (existing.discord_user_id !== discordUserId) {
      logger.warn(
        'LinkIdentity',
        `Character "${characterName}" already mapped to Discord user ${existing.discord_user_id}; not overwriting with ${discordUserId}`,
      );
    }
    return false;
  }

  db.prepare(
    'INSERT INTO raider_identity_map (character_name, discord_user_id) VALUES (?, ?)',
  ).run(characterName, discordUserId);

  logger.info('LinkIdentity', `Linked character "${characterName}" to Discord user ${discordUserId}`);
  return true;
}
