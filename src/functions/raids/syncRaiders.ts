import type { Client } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { getGuildRoster } from '../../services/raiderio.js';
import { logger } from '../../services/logger.js';
import type { RaiderRow, RaiderIdentityMapRow, IgnoredCharacterRow } from '../../types/index.js';

const GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function syncRaiders(_client: Client): Promise<RaiderRow[]> {
  const db = getDatabase();

  let apiMembers;
  try {
    apiMembers = await getGuildRoster();
  } catch (error) {
    logger.error('SyncRaiders', 'Failed to fetch guild roster from Raider.io', error as Error);
    return [];
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
  let markedInactive = 0;
  let returned = 0;
  let reactivated = 0;

  // Raiders inserted by this sync with no Discord user. Returned to the caller
  // so it can post auto-link suggestions / missing-user alerts (the automatic
  // path the V2 spec describes — "when a new raider is added without a Discord
  // user ... the bot attempts to auto-match"). Only freshly-added raiders are
  // collected, so the 10-minute scheduled sync never re-alerts the same raider.
  const newUnlinkedRaiders: RaiderRow[] = [];

  const transaction = db.transaction(() => {
    const now = new Date().toISOString();

    // 1. Handle raiders no longer in the API roster.
    for (const raider of dbRaiders) {
      if (apiNameSet.has(raider.character_name.toLowerCase())) continue;

      if (raider.missing_since === null) {
        // First sync they're absent: start the grace-period clock.
        db.prepare('UPDATE raiders SET missing_since = ? WHERE id = ?').run(now, raider.id);
        markedMissing++;
        continue;
      }

      if (raider.inactive_since !== null) {
        // Already retired to inactive — nothing to do. Crucially, no repeated
        // warning on every sync.
        continue;
      }

      const elapsed = Date.now() - new Date(raider.missing_since).getTime();
      if (elapsed >= GRACE_PERIOD_MS) {
        // Grace period expired: retire to inactive. The row is kept (so we can
        // auto-reactivate on return) but hidden from get_raiders. Logged once.
        db.prepare('UPDATE raiders SET inactive_since = ? WHERE id = ?').run(now, raider.id);
        markedInactive++;
        logger.info(
          'SyncRaiders',
          `Raider "${raider.character_name}" marked inactive after >24h missing (since ${raider.missing_since})`,
        );
      }
      // else: still within the 24h grace period — leave as missing.
    }

    // 2. Handle raiders back in the API roster: clear missing/inactive state.
    for (const raider of dbRaiders) {
      if (!apiNameSet.has(raider.character_name.toLowerCase())) continue;
      if (raider.missing_since === null && raider.inactive_since === null) continue;

      db.prepare(
        'UPDATE raiders SET missing_since = NULL, inactive_since = NULL WHERE id = ?',
      ).run(raider.id);

      if (raider.inactive_since !== null) {
        reactivated++;
        logger.info(
          'SyncRaiders',
          `Raider "${raider.character_name}" reactivated (returned to roster)`,
        );
      } else {
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

        const result = db
          .prepare(
            `INSERT INTO raiders (character_name, realm, region, rank, class, discord_user_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            member.character.name,
            member.character.realm,
            member.character.region,
            member.rank,
            member.character.class,
            discordUserId,
          );
        added++;

        if (discordUserId === null) {
          const inserted = db
            .prepare('SELECT * FROM raiders WHERE id = ?')
            .get(result.lastInsertRowid) as RaiderRow;
          newUnlinkedRaiders.push(inserted);
        }
      }
    }
  });

  transaction();

  logger.info(
    'SyncRaiders',
    `Sync complete: ${added} added, ${returned} returned, ${reactivated} reactivated, ` +
      `${markedMissing} newly missing, ${markedInactive} newly inactive`,
  );

  return newUnlinkedRaiders;
}
