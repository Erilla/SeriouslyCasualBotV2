vi.mock('../../src/functions/applications/notifyApplicantDeparture.js', () => ({
  notifyApplicantDeparture: vi.fn(async () => 'no_application'),
}));
vi.mock('../../src/functions/trial-review/notifyTrialDeparture.js', () => ({
  notifyTrialDeparture: vi.fn(async () => 'notified'),
}));

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../../src/config.js';
import handler from '../../src/events/guildMemberRemove.js';
import { notifyApplicantDeparture } from '../../src/functions/applications/notifyApplicantDeparture.js';
import { notifyTrialDeparture as mockedNotifyTrial } from '../../src/functions/trial-review/notifyTrialDeparture.js';

function fakeMember(over: Partial<{ guildId: string; bot: boolean }> = {}) {
  const { guildId = config.guildId, bot = false } = over;
  return {
    guild: { id: guildId },
    user: { id: 'u1', tag: 'brent#0001', bot },
  } as never;
}

describe('guildMemberRemove asks about trials as well as applications', () => {
  beforeEach(() => vi.clearAllMocks());

  it('asks both questions for a real departure', async () => {
    await handler.execute(fakeMember());

    expect(notifyApplicantDeparture).toHaveBeenCalledOnce();
    expect(mockedNotifyTrial).toHaveBeenCalledWith(expect.anything(), {
      userId: 'u1',
      tag: 'brent#0001',
    });
  });

  it('still asks about the trial when the applicant lookup throws', async () => {
    vi.mocked(notifyApplicantDeparture).mockRejectedValueOnce(new Error('db gone'));

    await handler.execute(fakeMember());

    expect(mockedNotifyTrial).toHaveBeenCalledOnce();
  });

  it('never throws back into the gateway when the trial lookup fails', async () => {
    vi.mocked(mockedNotifyTrial).mockRejectedValueOnce(new Error('thread exploded'));

    await expect(handler.execute(fakeMember())).resolves.toBeUndefined();
  });

  it('ignores bots', async () => {
    await handler.execute(fakeMember({ bot: true }));

    expect(mockedNotifyTrial).not.toHaveBeenCalled();
  });

  it('ignores departures from another guild', async () => {
    await handler.execute(fakeMember({ guildId: 'some-other-guild' }));

    expect(mockedNotifyTrial).not.toHaveBeenCalled();
  });
});
