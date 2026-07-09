import { describe, it, expect } from 'vitest';
import { buildOverlordNotification } from '../../src/functions/applications/overlordNotification.js';

describe('buildOverlordNotification', () => {
  it('restricts allowed mentions to the overlord user ids only', () => {
    const msg = buildOverlordNotification(['111', '222'], 'Thrall', 'thrall#0001');
    expect(msg.allowedMentions).toEqual({ users: ['111', '222'] });
  });

  it('does not let an @everyone injected via the character name ping anyone', () => {
    const msg = buildOverlordNotification(['111'], '@everyone', 'sneaky#0001');
    // The literal text may appear in the content, but it must never resolve to a
    // real mention: only the explicit overlord user ids are allowed.
    expect(msg.allowedMentions).toEqual({ users: ['111'] });
    expect(msg.allowedMentions).not.toHaveProperty('parse');
    expect(msg.allowedMentions).not.toHaveProperty('roles');
  });

  it('mentions each overlord and names the applicant in the content', () => {
    const msg = buildOverlordNotification(['111', '222'], 'Thrall', 'thrall#0001');
    expect(msg.content).toContain('<@111>');
    expect(msg.content).toContain('<@222>');
    expect(msg.content).toContain('**Thrall**');
    expect(msg.content).toContain('thrall#0001');
  });
});
