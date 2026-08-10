import type { GuildMember, PartialGuildMember } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../services/logger.js';
import { notifyApplicantDeparture } from '../functions/applications/notifyApplicantDeparture.js';

/**
 * Tell overlords when the Discord user behind an undecided application leaves.
 *
 * Discord fires this one event for a voluntary leave, a kick and a ban alike and
 * does not say which — deliberately treated as the same thing here. If an overlord
 * did the kicking, they already know.
 *
 * Departures that happen while this process is down never reach this handler at
 * all, which is routine given every deploy restarts the bot. The startup sweep is
 * what catches those; this is only the live path.
 */
export default {
  name: 'guildMemberRemove',
  async execute(...args: unknown[]) {
    const member = args[0] as GuildMember | PartialGuildMember;

    // The prod bot is in more than one guild, so a departure elsewhere is not ours.
    if (member.guild?.id !== config.guildId) return;

    // A bot leaving is never an applicant. The member may be partial, but `user`
    // is always present on a removal.
    if (member.user?.bot) return;

    try {
      await notifyApplicantDeparture(member.guild, {
        userId: member.user.id,
        tag: member.user.tag,
      });
    } catch (error) {
      // Nothing may escape a gateway handler: an unhandled rejection here takes
      // the process down over a notification.
      logger.error(
        'Applications',
        `Failed to handle departure of ${member.user?.tag ?? 'unknown member'}: ${error}`,
        error as Error,
      );
    }
  },
};
