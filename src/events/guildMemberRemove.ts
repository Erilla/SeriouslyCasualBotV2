import type { GuildMember, PartialGuildMember } from 'discord.js';
import { config } from '../config.js';
import { logger } from '../services/logger.js';
import { notifyApplicantDeparture } from '../functions/applications/notifyApplicantDeparture.js';
import { notifyTrialDeparture } from '../functions/trial-review/notifyTrialDeparture.js';

/**
 * Tell overlords when the Discord user behind an undecided application or an active trial leaves.
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

    // The member may be partial, but `user` is expected to always be present on a
    // removal. Guard anyway: nothing may escape a gateway handler, and a missing
    // `user` here must not become an unhandled rejection.
    if (!member.user) return;

    // A bot leaving is never an applicant.
    if (member.user.bot) return;

    const departed = { userId: member.user.id, tag: member.user.tag };

    // Two independent questions, each in its own try/catch: a failure answering one
    // must not skip the other, and nothing may escape a gateway handler — an
    // unhandled rejection here takes the process down over a notification.
    try {
      await notifyApplicantDeparture(member.guild, departed);
    } catch (error) {
      logger.error(
        'Applications',
        `Failed to handle departure of ${departed.tag}: ${error}`,
        error as Error,
      );
    }

    try {
      await notifyTrialDeparture(member.guild, departed);
    } catch (error) {
      logger.error(
        'Trials',
        `Failed to handle trial departure of ${departed.tag}: ${error}`,
        error as Error,
      );
    }
  },
};
