import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { closeDatabase, getDatabase, initDatabase } from '../../src/database/db.js';

vi.mock('../../src/config.js', () => ({ config: { guildId: 'guild-123' } }));
vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/functions/channels.js', () => ({ getOrCreateChannel: vi.fn() }));
vi.mock('../../src/services/wowaudit.js', () => ({ getUpcomingRaids: vi.fn(), getRaid: vi.fn() }));
vi.mock('../../src/services/quipGenerator.js', () => ({ generateSignupQuip: vi.fn() }));
vi.mock('../../src/services/quipContext.js', () => ({ getProgressionContext: vi.fn() }));
vi.mock('../../src/functions/raids/overlords.js', () => ({ getOverlords: vi.fn() }));

import { alertSignups } from '../../src/functions/raids/alertSignups.js';
import { getOrCreateChannel } from '../../src/functions/channels.js';
import { getUpcomingRaids, getRaid } from '../../src/services/wowaudit.js';
import { generateSignupQuip } from '../../src/services/quipGenerator.js';
import { getProgressionContext } from '../../src/services/quipContext.js';
import { getOverlords } from '../../src/functions/raids/overlords.js';

const mockedGetOrCreateChannel = vi.mocked(getOrCreateChannel);
const mockedGetUpcomingRaids = vi.mocked(getUpcomingRaids);
const mockedGetRaid = vi.mocked(getRaid);
const mockedGenerateSignupQuip = vi.mocked(generateSignupQuip);
const mockedGetProgressionContext = vi.mocked(getProgressionContext);
const mockedGetOverlords = vi.mocked(getOverlords);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-29T12:00:00Z')); // Saturday: Sunday day-of reminder
  initDatabase(':memory:');
  getDatabase().prepare('UPDATE settings SET value = 1 WHERE key = ?').run('alertSignup_Sunday');
  vi.clearAllMocks();

  mockedGetUpcomingRaids.mockResolvedValue([{ id: 1, difficulty: 'Mythic', status: 'Planned' }] as never);
  mockedGetRaid.mockResolvedValue({ signups: [{ status: 'Present', character: { name: 'Ready' } }] } as never);
  mockedGetProgressionContext.mockResolvedValue(null);
  mockedGetOverlords.mockReturnValue([]);
});

afterEach(() => {
  closeDatabase();
  vi.useRealTimers();
});

describe('alertSignups', () => {
  it('posts and remembers a generated celebration quip when every raider has signed up', async () => {
    const channel = { send: vi.fn().mockResolvedValue(undefined) };
    mockedGetOrCreateChannel.mockResolvedValue(channel as never);
    mockedGenerateSignupQuip.mockResolvedValue({ quip: 'The roster is locked and loaded!', generated: true });

    await alertSignups({ guilds: { fetch: vi.fn() } } as unknown as Client);

    expect(channel.send).toHaveBeenCalledWith('The roster is locked and loaded!');
    expect(
      getDatabase().prepare('SELECT quip FROM quip_history ORDER BY id DESC LIMIT 1').get(),
    ).toEqual({ quip: 'The roster is locked and loaded!' });
  });
});
