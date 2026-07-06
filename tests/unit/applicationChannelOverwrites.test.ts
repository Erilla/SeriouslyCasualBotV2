import { describe, it, expect } from 'vitest';
import { OverwriteType, PermissionFlagsBits } from 'discord.js';
import { buildApplicationChannelOverwrites } from '../../src/functions/applications/submitApplication.js';

describe('buildApplicationChannelOverwrites', () => {
  const guildId = '111111111111111111';
  const applicantId = '222222222222222222';
  const overlordIds = ['333333333333333333', '444444444444444444'];
  const officerRoleId = '555555555555555555';

  it('sets an explicit type on every overwrite so Discord.js never falls back to cache resolution', () => {
    const overwrites = buildApplicationChannelOverwrites(
      guildId,
      applicantId,
      overlordIds,
      officerRoleId,
    );

    // Every overwrite MUST carry a `type`. Without it, PermissionOverwrites.resolve
    // tries guild.roles.resolve(id) ?? client.users.resolve(id) against the CACHE
    // only, and throws "Supplied parameter is not a cached User or Role" for any
    // id that isn't cached (e.g. an overlord who left, or a cold user cache).
    for (const ow of overwrites) {
      expect(ow.type, `overwrite for id ${ow.id} is missing a type`).toBeTypeOf('number');
    }
  });

  it('marks @everyone and the officer role as Role, and members as Member', () => {
    const overwrites = buildApplicationChannelOverwrites(
      guildId,
      applicantId,
      overlordIds,
      officerRoleId,
    );

    const byId = new Map(overwrites.map((o) => [o.id, o]));

    expect(byId.get(guildId)?.type).toBe(OverwriteType.Role);
    expect(byId.get(officerRoleId)?.type).toBe(OverwriteType.Role);
    expect(byId.get(applicantId)?.type).toBe(OverwriteType.Member);
    for (const id of overlordIds) {
      expect(byId.get(id)?.type).toBe(OverwriteType.Member);
    }
  });

  it('denies ViewChannel for @everyone and allows applicant to view/send', () => {
    const overwrites = buildApplicationChannelOverwrites(
      guildId,
      applicantId,
      overlordIds,
      null,
    );
    const byId = new Map(overwrites.map((o) => [o.id, o]));

    expect(byId.get(guildId)?.deny).toContain(PermissionFlagsBits.ViewChannel);
    expect(byId.get(applicantId)?.allow).toEqual(
      expect.arrayContaining([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]),
    );
  });

  it('omits the officer role overwrite when no officer role is configured', () => {
    const overwrites = buildApplicationChannelOverwrites(
      guildId,
      applicantId,
      overlordIds,
      null,
    );
    expect(overwrites.some((o) => o.id === '')).toBe(false);
    // one @everyone + one applicant + two overlords = 4
    expect(overwrites).toHaveLength(4);
  });

  it('deduplicates an overlord who is also the applicant', () => {
    const overwrites = buildApplicationChannelOverwrites(
      guildId,
      applicantId,
      [applicantId, overlordIds[0]],
      officerRoleId,
    );
    const applicantOverwrites = overwrites.filter((o) => o.id === applicantId);
    expect(applicantOverwrites).toHaveLength(1);
  });
});
