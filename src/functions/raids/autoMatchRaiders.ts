import type { Guild, GuildMember } from 'discord.js';
import { logger } from '../../services/logger.js';
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

  let members;
  try {
    members = await guild.members.fetch();
  } catch (error) {
    logger.error('AutoMatch', 'Failed to fetch guild members', error as Error);
    return [];
  }

  const matches: AutoMatch[] = [];

  for (const raider of unlinkedRaiders) {
    const charName = raider.character_name.trim().toLowerCase();
    const matchingMembers: GuildMember[] = [];

    for (const [, member] of members) {
      const displayName = member.displayName.trim().toLowerCase();
      const globalDisplayName = member.user.displayName.trim().toLowerCase();
      const username = member.user.username.trim().toLowerCase();

      if (
        charName === displayName ||
        charName === globalDisplayName ||
        charName === username
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

  logger.info('AutoMatch', `Found ${matches.length} auto-matches out of ${unlinkedRaiders.length} unlinked raiders`);
  return matches;
}
