import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Client, Guild } from 'discord.js';
import type { RaiderRow } from '../../src/types/index.js';
import type { AutoMatch } from '../../src/functions/raids/autoMatchRaiders.js';

vi.mock('../../src/functions/raids/autoMatchRaiders.js', () => ({
  autoMatchRaiders: vi.fn(),
}));

vi.mock('../../src/functions/raids/sendAlertForRaidersWithNoUser.js', () => ({
  sendAlertForRaidersWithNoUser: vi.fn(),
}));

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/config.js', () => ({
  config: { guildId: 'guild-123' },
}));

import { alertForNewUnlinkedRaiders } from '../../src/functions/raids/alertForNewUnlinkedRaiders.js';
import { autoMatchRaiders } from '../../src/functions/raids/autoMatchRaiders.js';
import { sendAlertForRaidersWithNoUser } from '../../src/functions/raids/sendAlertForRaidersWithNoUser.js';
import { logger } from '../../src/services/logger.js';

const mockedAutoMatch = vi.mocked(autoMatchRaiders);
const mockedSendAlert = vi.mocked(sendAlertForRaidersWithNoUser);

function makeRaider(name: string): RaiderRow {
  return {
    id: 1,
    character_name: name,
    realm: 'silvermoon',
    region: 'eu',
    rank: 3,
    class: 'Mage',
    discord_user_id: null,
    message_id: null,
    missing_since: null,
  };
}

function makeClient(guild: Guild | null) {
  return {
    guilds: {
      cache: { get: vi.fn().mockReturnValue(guild ?? undefined) },
      fetch: vi.fn().mockResolvedValue(guild),
    },
  } as unknown as Client;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('alertForNewUnlinkedRaiders', () => {
  it('does nothing when there are no new raiders', async () => {
    const client = makeClient({} as Guild);

    await alertForNewUnlinkedRaiders(client, []);

    expect(mockedAutoMatch).not.toHaveBeenCalled();
    expect(mockedSendAlert).not.toHaveBeenCalled();
  });

  it('auto-matches and sends alerts for new raiders', async () => {
    const guild = { id: 'guild-123' } as Guild;
    const client = makeClient(guild);
    const raiders = [makeRaider('Alpha'), makeRaider('Beta')];
    const matches: AutoMatch[] = [];
    mockedAutoMatch.mockResolvedValue(matches);

    await alertForNewUnlinkedRaiders(client, raiders);

    expect(mockedAutoMatch).toHaveBeenCalledWith(guild, raiders);
    expect(mockedSendAlert).toHaveBeenCalledWith(client, raiders, matches);
  });

  it('logs an error and does not send alerts when the guild cannot be resolved', async () => {
    const client = makeClient(null);

    await alertForNewUnlinkedRaiders(client, [makeRaider('Alpha')]);

    expect(logger.error).toHaveBeenCalled();
    expect(mockedAutoMatch).not.toHaveBeenCalled();
    expect(mockedSendAlert).not.toHaveBeenCalled();
  });
});
