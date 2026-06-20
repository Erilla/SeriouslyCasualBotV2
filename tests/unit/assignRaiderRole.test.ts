import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Guild, GuildMember } from 'discord.js';
import { initDatabase, closeDatabase, getDatabase } from '../../src/database/db.js';

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { assignRaiderRole } from '../../src/functions/applications/assignRaiderRole.js';
import { logger } from '../../src/services/logger.js';

function setRaiderRole(roleId: string) {
  getDatabase()
    .prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run('raider_role_id', roleId);
}

// A guild whose members.fetch resolves to a member with a spyable roles.add.
function makeGuild(member: Partial<GuildMember> & { roles: { add: ReturnType<typeof vi.fn> } }) {
  return {
    members: { fetch: vi.fn().mockResolvedValue(member) },
  } as unknown as Guild;
}

function makeMember() {
  return { roles: { add: vi.fn().mockResolvedValue(undefined) } };
}

beforeEach(() => {
  closeDatabase();
  initDatabase(':memory:');
  vi.clearAllMocks();
});

afterEach(() => {
  closeDatabase();
});

describe('assignRaiderRole', () => {
  it('adds the configured raider role to the applicant', async () => {
    setRaiderRole('role-123');
    const member = makeMember();
    const guild = makeGuild(member as never);

    await assignRaiderRole(guild, 'user-1');

    expect(guild.members.fetch).toHaveBeenCalledWith('user-1');
    expect(member.roles.add).toHaveBeenCalledWith('role-123');
  });

  it('skips assignment and warns when raider_role_id is not configured', async () => {
    const member = makeMember();
    const guild = makeGuild(member as never);

    await assignRaiderRole(guild, 'user-1');

    expect(guild.members.fetch).not.toHaveBeenCalled();
    expect(member.roles.add).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('swallows errors (best-effort) when the role cannot be added', async () => {
    setRaiderRole('role-123');
    const member = { roles: { add: vi.fn().mockRejectedValue(new Error('Missing Permissions')) } };
    const guild = makeGuild(member as never);

    // Must not throw — accept flow continues even if role assignment fails.
    await expect(assignRaiderRole(guild, 'user-1')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('swallows errors when the user is no longer in the guild', async () => {
    setRaiderRole('role-123');
    const guild = {
      members: { fetch: vi.fn().mockRejectedValue(new Error('Unknown Member')) },
    } as unknown as Guild;

    await expect(assignRaiderRole(guild, 'user-1')).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
