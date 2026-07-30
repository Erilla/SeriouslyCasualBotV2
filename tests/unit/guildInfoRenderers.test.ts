import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';
import { closeDatabase, getDatabase, initDatabase } from '../../src/database/db.js';

const mocks = vi.hoisted(() => ({
  channel: {},
  upsertGuildInfoMessage: vi.fn(),
  buildAchievementsModel: vi.fn(),
  renderAchievementsImage: vi.fn(),
}));

vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/functions/guild-info/clearGuildInfo.js', () => ({
  getOrCreateGuildInfoChannel: vi.fn(async () => mocks.channel),
}));

vi.mock('../../src/functions/guild-info/managedGuildInfoMessage.js', () => ({
  upsertGuildInfoMessage: mocks.upsertGuildInfoMessage,
}));

vi.mock('../../src/functions/guild-info/achievementsData.js', () => ({
  buildAchievementsModel: mocks.buildAchievementsModel,
}));

vi.mock('../../src/functions/guild-info/achievementsRender.js', () => ({
  renderAchievementsImage: mocks.renderAchievementsImage,
}));

import { updateAboutUs } from '../../src/functions/guild-info/updateAboutUs.js';
import { updateAchievements } from '../../src/functions/guild-info/updateAchievements.js';
import { updateRecruitment } from '../../src/functions/guild-info/updateRecruitment.js';
import { updateSchedule } from '../../src/functions/guild-info/updateSchedule.js';

beforeEach(() => {
  closeDatabase();
  initDatabase(':memory:');
  vi.clearAllMocks();
  mocks.buildAchievementsModel.mockResolvedValue({ sections: [], icons: new Map() });
  mocks.renderAchievementsImage.mockResolvedValue(Buffer.from('image'));
});

afterEach(() => {
  closeDatabase();
});

describe('guild-info renderers', () => {
  it.each([
    ['aboutus', updateAboutUs],
    ['schedule', updateSchedule],
    ['recruitment', updateRecruitment],
  ])('%s delegates its payload to the managed-message helper', async (key, update) => {
    await update({} as Client);

    expect(mocks.upsertGuildInfoMessage).toHaveBeenCalledWith(
      mocks.channel,
      key,
      expect.any(Object),
    );
  });

  it('clears About Us components when the database has no links', async () => {
    getDatabase().prepare('DELETE FROM guild_info_links').run();

    await updateAboutUs({} as Client);

    expect(mocks.upsertGuildInfoMessage).toHaveBeenCalledWith(
      mocks.channel,
      'aboutus',
      expect.objectContaining({ components: [] }),
    );
  });

  it('delegates the rendered Achievements attachment to the managed-message helper', async () => {
    await updateAchievements({} as Client);

    expect(mocks.upsertGuildInfoMessage).toHaveBeenCalledWith(
      mocks.channel,
      'achievements',
      expect.objectContaining({
        content: '**Current Progress & Past Achievements**',
        embeds: [],
        files: [expect.any(Object)],
      }),
    );
  });
});
