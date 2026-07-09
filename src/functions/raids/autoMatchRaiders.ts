import type { Guild, GuildMember } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { normalizeName } from './normalizeName.js';
import type { RaiderRow, ConfigRow } from '../../types/index.js';

export interface AutoMatch {
  raider: RaiderRow;
  suggestedUser: GuildMember;
}

export async function autoMatchRaiders(
  guild: Guild,
  unlinkedRaiders: RaiderRow[],
): Promise<AutoMatch[]> {
  if (unlinkedRaiders.length === 0) return [];

  const db = getDatabase();

  // Discord users already linked to some ACTIVE raider — never suggest them
  // again. Users linked only to an inactive raider stay suggestable.
  const linkedRows = db
    .prepare(
      'SELECT discord_user_id FROM raiders WHERE discord_user_id IS NOT NULL AND inactive_since IS NULL',
    )
    .all() as { discord_user_id: string }[];
  const linkedUserIds = new Set(linkedRows.map((r) => r.discord_user_id));

  const totalUnlinkedCount = (
    db
      .prepare(
        'SELECT COUNT(*) AS n FROM raiders WHERE discord_user_id IS NULL AND missing_since IS NULL',
      )
      .get() as { n: number }
  ).n;

  const raiderRoleId =
    (
      db.prepare('SELECT value FROM config WHERE key = ?').get('raider_role_id') as
        | ConfigRow
        | undefined
    )?.value ?? null;

  let members;
  try {
    members = await guild.members.fetch();
  } catch (error) {
    logger.error('AutoMatch', 'Failed to fetch guild members', error as Error);
    return [];
  }

  // Elimination short-circuit: when there is exactly one unlinked raider and
  // exactly one unlinked Raider-role member, suggest that pairing directly and
  // skip name matching. Requires raider_role_id to be configured.
  if (totalUnlinkedCount === 1 && raiderRoleId) {
    const eligible: GuildMember[] = [];
    for (const [, member] of members) {
      if (member.user.bot) continue;
      if (linkedUserIds.has(member.id)) continue;
      if (member.roles.cache.has(raiderRoleId)) {
        eligible.push(member);
      }
    }

    if (eligible.length === 1) {
      const raider = unlinkedRaiders[0];
      logger.info(
        'AutoMatch',
        `elimination match: ${raider.character_name} -> @${eligible[0].id} ` +
          `(sole unlinked raider + sole unlinked Raider-role member)`,
      );
      return [{ raider, suggestedUser: eligible[0] }];
    }
  } else if (totalUnlinkedCount === 1 && !raiderRoleId) {
    logger.debug(
      'AutoMatch',
      'Sole unlinked raider but raider_role_id not configured; skipping elimination short-circuit',
    );
  }

  const matches: AutoMatch[] = [];

  for (const raider of unlinkedRaiders) {
    const normalizedCharName = normalizeName(raider.character_name);
    const matchingMembers: GuildMember[] = [];

    for (const [, member] of members) {
      if (member.user.bot) continue;
      if (linkedUserIds.has(member.id)) continue;

      if (
        normalizeName(member.displayName) === normalizedCharName ||
        normalizeName(member.user.displayName) === normalizedCharName ||
        normalizeName(member.user.username) === normalizedCharName
      ) {
        matchingMembers.push(member);
      }
    }

    if (matchingMembers.length === 1) {
      matches.push({ raider, suggestedUser: matchingMembers[0] });
    } else if (matchingMembers.length > 1) {
      logger.debug(
        'AutoMatch',
        `Ambiguous match for "${raider.character_name}": ${matchingMembers.length} members matched, skipping`,
      );
    }
  }

  logger.info(
    'AutoMatch',
    `Found ${matches.length} auto-matches out of ${unlinkedRaiders.length} unlinked raiders`,
  );
  return matches;
}
