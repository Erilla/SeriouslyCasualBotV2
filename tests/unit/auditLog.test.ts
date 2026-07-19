import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({ config: { officerRoleId: 'role-1' } }));
vi.mock('../../src/services/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { audit, setAuditChannel } from '../../src/services/auditLog.js';

describe('audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends with mentions suppressed so linked users are not pinged', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    // Cast through unknown — the test channel only needs `send`.
    setAuditChannel({ send } as unknown as Parameters<typeof setAuditChannel>[0]);

    const officer = { displayName: 'Splo' } as Parameters<typeof audit>[0];
    await audit(officer, 'rejected application', '**Sploboss** (<@456>)');

    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0];
    expect(arg.content).toBe('**Splo** rejected application: **Sploboss** (<@456>)');
    expect(arg.allowedMentions).toEqual({ parse: [] });
  });
});
