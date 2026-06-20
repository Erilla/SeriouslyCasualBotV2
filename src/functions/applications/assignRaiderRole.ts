import type { Guild } from 'discord.js';
import { getDatabase } from '../../database/db.js';
import { logger } from '../../services/logger.js';
import type { ConfigRow } from '../../types/index.js';

/**
 * Give an accepted applicant the configured Raider role (set via /setup).
 *
 * Best-effort: a missing raider_role_id config, a user who has left the guild,
 * or a permission error is logged and swallowed so it can never fail the
 * surrounding accept flow — matching the other non-fatal accept side-effects
 * (DM, transcript, channel delete).
 */
export async function assignRaiderRole(guild: Guild, userId: string): Promise<void> {
  const row = getDatabase()
    .prepare('SELECT value FROM config WHERE key = ?')
    .get('raider_role_id') as ConfigRow | undefined;

  if (!row?.value) {
    logger.warn(
      'Applications',
      'raider_role_id is not configured (/setup set_role role:Raider); skipping raider role assignment',
    );
    return;
  }

  try {
    const member = await guild.members.fetch(userId);
    await member.roles.add(row.value);
    logger.info('Applications', `Assigned raider role to user ${userId}`);
  } catch (error) {
    logger.warn(
      'Applications',
      `Failed to assign raider role to user ${userId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
