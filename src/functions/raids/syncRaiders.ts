import type { Client } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { getGuildRoster } from '../../services/raiderio.js';
import { logger } from '../../services/logger.js';
import type { RaiderRow, RaiderIdentityMapRow, IgnoredCharacterRow } from '../../types/index.js';

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function syncRaiders(_client: Client): Promise<void> {
  const db = getDatabase();

  let apiMembers;
  try {
    apiMembers = await getGuildRoster();
  } catch (error) {
    logger.error('SyncRaiders', 'Failed to fetch guild roster from Raider.io', error as Error);
    return;
  }

  const dbRaiders = db.prepare('SELECT * FROM raiders').all() as RaiderRow[];
  const ignoredCharacters = db
    .prepare('SELECT character_name FROM ignored_characters')
    .all() as IgnoredCharacterRow[];

  const ignoredSet = new Set(ignoredCharacters.map((ic) => ic.character_name.toLowerCase()));

  // Filter API roster: exclude ignored characters
  const filteredMembers = apiMembers.filter(
    (m) => !ignoredSet.has(m.character.name.toLowerCase()),
  );

  const apiNameSet = new Set(filteredMembers.map((m) => m.character.name.toLowerCase()));
  const dbRaiderMap = new Map(dbRaiders.map((r) => [r.character_name.toLowerCase(), r]));

  let added = 0;
  let markedMissing = 0;
  let returned = 0;
  let alreadyMissing = 0;

  const transaction = db.transaction(() => {
    const now = new Date().toISOString();

    // 1. Handle raiders no longer in API
    for (const raider of dbRaiders) {
      if (!apiNameSet.has(raider.character_name.toLowerCase())) {
        if (raider.missing_since === null) {
          // First time missing: set missing_since
          db.prepare('UPDATE raiders SET missing_since = ? WHERE id = ?').run(now, raider.id);
          markedMissing++;
        } else {
          const missingSinceDate = new Date(raider.missing_since).getTime();
          const elapsed = Date.now() - missingSinceDate;

          if (elapsed >= GRACE_PERIOD_MS) {
            logger.warn(
              'SyncRaiders',
              `Raider "${raider.character_name}" has been missing for over 24 hours (since ${raider.missing_since})`,
            );
            alreadyMissing++;
          }
          // If < 24 hours, do nothing (grace period)
        }
      }
    }

    // 2. Handle raiders back in API: clear missing_since
    for (const raider of dbRaiders) {
      if (apiNameSet.has(raider.character_name.toLowerCase()) && raider.missing_since !== null) {
        db.prepare('UPDATE raiders SET missing_since = NULL WHERE id = ?').run(raider.id);
        returned++;
      }
    }

    // 3. Handle new raiders from API
    const identityMap = db
      .prepare('SELECT character_name, discord_user_id FROM raider_identity_map')
      .all() as RaiderIdentityMapRow[];
    const identityLookup = new Map(
      identityMap.map((im) => [im.character_name.toLowerCase(), im.discord_user_id]),
    );

    for (const member of filteredMembers) {
      const lowerName = member.character.name.toLowerCase();
      if (!dbRaiderMap.has(lowerName)) {
        const discordUserId = identityLookup.get(lowerName) ?? null;

        db.prepare(
          `INSERT INTO raiders (character_name, realm, region, rank, class, discord_user_id)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          member.character.name,
          member.character.realm,
          member.character.region,
          member.rank,
          member.character.class,
          discordUserId,
        );
        added++;
      }
    }
  });

  transaction();

  logger.info(
    'SyncRaiders',
    `Sync complete: ${added} added, ${returned} returned, ${markedMissing} newly missing, ${alreadyMissing} still missing (>24h)`,
  );
}
