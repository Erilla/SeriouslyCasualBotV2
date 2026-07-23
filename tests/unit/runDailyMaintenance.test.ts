import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'discord.js';

vi.mock('../../src/functions/raids/syncRaiders.js', () => ({
  syncRaiders: vi.fn(),
}));
vi.mock('../../src/functions/raids/alertForNewUnlinkedRaiders.js', () => ({
  alertForNewUnlinkedRaiders: vi.fn(),
}));
vi.mock('../../src/functions/raids/refreshLinkingMessages.js', () => ({
  refreshLinkingMessages: vi.fn(),
}));
vi.mock('../../src/functions/trial-review/updateTrialLogs.js', () => ({
  updateTrialLogs: vi.fn(),
}));
vi.mock('../../src/services/statusTracker.js', () => ({
  recordTaskRun: vi.fn(),
}));
vi.mock('../../src/services/logger.js', () => ({
  logger: { error: vi.fn() },
}));

import { runDailyMaintenance } from '../../src/functions/maintenance/runDailyMaintenance.js';
import { syncRaiders } from '../../src/functions/raids/syncRaiders.js';
import { alertForNewUnlinkedRaiders } from '../../src/functions/raids/alertForNewUnlinkedRaiders.js';
import { refreshLinkingMessages } from '../../src/functions/raids/refreshLinkingMessages.js';
import { updateTrialLogs } from '../../src/functions/trial-review/updateTrialLogs.js';
import { recordTaskRun } from '../../src/services/statusTracker.js';

const client = {} as Client;
const mockedSyncRaiders = vi.mocked(syncRaiders);
const mockedAlertForNewUnlinkedRaiders = vi.mocked(alertForNewUnlinkedRaiders);
const mockedRefreshLinkingMessages = vi.mocked(refreshLinkingMessages);
const mockedUpdateTrialLogs = vi.mocked(updateTrialLogs);
const mockedRecordTaskRun = vi.mocked(recordTaskRun);

beforeEach(() => {
  vi.clearAllMocks();
  mockedSyncRaiders.mockResolvedValue([]);
  mockedAlertForNewUnlinkedRaiders.mockResolvedValue(undefined);
  mockedRefreshLinkingMessages.mockResolvedValue(undefined);
  mockedUpdateTrialLogs.mockResolvedValue(undefined);
});

describe('runDailyMaintenance', () => {
  it('runs daily maintenance operations in order and records their successful status', async () => {
    const order: string[] = [];
    mockedSyncRaiders.mockImplementation(async () => {
      order.push('syncRaiders');
      return [{ id: 1 } as never];
    });
    mockedAlertForNewUnlinkedRaiders.mockImplementation(async () => {
      order.push('alertForNewUnlinkedRaiders');
    });
    mockedRefreshLinkingMessages.mockImplementation(async () => {
      order.push('refreshLinkingMessages');
    });
    mockedUpdateTrialLogs.mockImplementation(async () => {
      order.push('updateTrialLogs');
    });

    await runDailyMaintenance(client);

    expect(order).toEqual([
      'syncRaiders',
      'alertForNewUnlinkedRaiders',
      'refreshLinkingMessages',
      'updateTrialLogs',
    ]);
    expect(mockedRecordTaskRun).toHaveBeenCalledWith('syncRaiders', true);
    expect(mockedRecordTaskRun).toHaveBeenCalledWith('refreshLinkingMessages', true);
    expect(mockedRecordTaskRun).toHaveBeenCalledWith('updateTrialLogs', true);
  });

  it('continues after a roster-sync failure and records each result', async () => {
    mockedSyncRaiders.mockRejectedValueOnce(new Error('Raider.IO unavailable'));

    await runDailyMaintenance(client);

    expect(mockedAlertForNewUnlinkedRaiders).not.toHaveBeenCalled();
    expect(mockedRefreshLinkingMessages).toHaveBeenCalledWith(client);
    expect(mockedUpdateTrialLogs).toHaveBeenCalledWith(client);
    expect(mockedRecordTaskRun).toHaveBeenCalledWith(
      'syncRaiders',
      false,
      'Error: Raider.IO unavailable',
    );
    expect(mockedRecordTaskRun).toHaveBeenCalledWith('refreshLinkingMessages', true);
    expect(mockedRecordTaskRun).toHaveBeenCalledWith('updateTrialLogs', true);
  });
});
