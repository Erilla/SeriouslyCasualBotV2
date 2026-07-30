import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Trial {
  id: number;
  character_name: string;
  role: string;
  start_date: string;
  thread_id: string | null;
  status: 'active' | 'promoted' | 'closed';
}

interface Alert {
  id: number;
  trial_id: number;
  alert_name: string;
  alert_date: string;
  alerted: number;
}

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  scheduleTrialAlerts: vi.fn(),
  requireOfficer: vi.fn(),
}));

vi.mock('../../src/database/db.js', () => ({ getDatabase: mocks.getDatabase }));
vi.mock('../../src/config.js', () => ({ config: { guildId: 'guild-1' } }));
vi.mock('../../src/functions/trial-review/scheduleTrialAlerts.js', () => ({
  scheduleTrialAlerts: mocks.scheduleTrialAlerts,
}));
vi.mock('../../src/services/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../src/utils.js', () => ({ requireOfficer: mocks.requireOfficer }));

import { changeTrialInfo } from '../../src/functions/trial-review/changeTrialInfo.js';
import trialsCommand from '../../src/commands/trials.js';

function createDatabase(trial: Trial, alerts: Alert[]) {
  return {
    prepare(sql: string) {
      return {
        get: (trialId: number) => {
          if (sql.includes('SELECT * FROM trials WHERE id = ?')) {
            return trialId === trial.id ? { ...trial } : undefined;
          }
          throw new Error(`Unexpected get query: ${sql}`);
        },
        all: () => {
          if (sql.includes("SELECT * FROM trials WHERE status IN ('active', 'promoted')"))
            return [trial];
          if (sql.includes('SELECT * FROM trial_alerts WHERE trial_id = ?')) return alerts;
          throw new Error(`Unexpected all query: ${sql}`);
        },
        run: (...args: unknown[]) => {
          if (sql.includes('UPDATE trials SET character_name = ?, role = ?, start_date = ?')) {
            [trial.character_name, trial.role, trial.start_date] = args as [string, string, string];
            return;
          }
          if (sql.includes('UPDATE trial_alerts SET alert_date = ?')) {
            const [alertDate, trialId, alertName] = args as [string, number, string];
            const alert = alerts.find(
              (candidate) =>
                candidate.trial_id === trialId &&
                candidate.alert_name === alertName &&
                candidate.alerted === 0,
            );
            if (alert) alert.alert_date = alertDate;
            return;
          }
          throw new Error(`Unexpected run query: ${sql}`);
        },
      };
    },
  };
}

function persistedAlerts(finalReviewDate: string): Alert[] {
  return [
    { id: 1, trial_id: 1, alert_name: '2_week', alert_date: '2026-01-22', alerted: 0 },
    { id: 2, trial_id: 1, alert_name: '4_week', alert_date: '2026-02-05', alerted: 0 },
    { id: 3, trial_id: 1, alert_name: '6_week', alert_date: finalReviewDate, alerted: 0 },
  ];
}

function activeTrial(): Trial {
  return {
    id: 1,
    character_name: 'Binded',
    role: 'DPS',
    start_date: '2026-01-01',
    thread_id: 'thread-1',
    status: 'active',
  };
}

function threadWithStarter(starterMessage: { edit: ReturnType<typeof vi.fn> }) {
  return {
    isThread: () => true,
    fetchStarterMessage: vi.fn().mockResolvedValue(starterMessage),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireOfficer.mockResolvedValue(true);
});

describe('persisted trial alert review messages', () => {
  it('preserves a one-week extension when changing a trial role', async () => {
    const trial = activeTrial();
    const alerts = persistedAlerts('2026-02-19');
    const starterMessage = { edit: vi.fn().mockResolvedValue(undefined) };
    const thread = threadWithStarter(starterMessage);
    mocks.getDatabase.mockReturnValue(createDatabase(trial, alerts));

    await changeTrialInfo(
      {
        guilds: {
          cache: { get: () => ({ channels: { fetch: vi.fn().mockResolvedValue(thread) } }) },
        },
      } as never,
      trial.id,
      { role: 'Healer' },
    );

    expect(starterMessage.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('7-week review (1-week extension): <t:1771459200:D>'),
      }),
    );
  });

  it('preserves a two-week extension when bulk-refreshing review messages', async () => {
    const trial = activeTrial();
    const alerts = persistedAlerts('2026-02-26');
    const starterMessage = { edit: vi.fn().mockResolvedValue(undefined) };
    const thread = threadWithStarter(starterMessage);
    mocks.getDatabase.mockReturnValue(createDatabase(trial, alerts));
    const interaction = {
      options: { getSubcommand: () => 'update_trial_review_messages' },
      guild: { channels: { fetch: vi.fn().mockResolvedValue(thread) } },
      deferReply: vi.fn().mockResolvedValue(undefined),
      editReply: vi.fn().mockResolvedValue(undefined),
    };

    await trialsCommand.execute(interaction as never);

    expect(starterMessage.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('8-week review (2-week extension): <t:1772064000:D>'),
      }),
    );
  });

  it('renders the persisted schedule after changing the trial start date', async () => {
    const trial = activeTrial();
    const alerts = persistedAlerts('2026-02-12');
    const starterMessage = { edit: vi.fn().mockResolvedValue(undefined) };
    const thread = threadWithStarter(starterMessage);
    mocks.getDatabase.mockReturnValue(createDatabase(trial, alerts));

    await changeTrialInfo(
      {
        guilds: {
          cache: { get: () => ({ channels: { fetch: vi.fn().mockResolvedValue(thread) } }) },
        },
      } as never,
      trial.id,
      { startDate: '2026-01-08' },
    );

    expect(alerts.map((alert) => alert.alert_date)).toEqual([
      '2026-01-22',
      '2026-02-05',
      '2026-02-19',
    ]);
    expect(starterMessage.edit).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('6-week review: <t:1771459200:D>'),
      }),
    );
  });
});
