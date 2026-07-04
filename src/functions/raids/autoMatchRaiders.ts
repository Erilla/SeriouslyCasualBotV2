import type { Guild, GuildMember } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import { normalizeName } from './normalizeName.js';
import type { RaiderRow } from '../../types/index.js';

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

  // Discord users already linked to some raider — never suggest them again.
  const linkedRows = db
    .prepare('SELECT discord_user_id FROM raiders WHERE discord_user_id IS NOT NULL')
    .all() as { discord_user_id: string }[];
  const linkedUserIds = new Set(linkedRows.map((r) => r.discord_user_id));

  let members;
  try {
    members = await guild.members.fetch();
  } catch (error) {
    logger.error('AutoMatch', 'Failed to fetch guild members', error as Error);
    return [];
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
