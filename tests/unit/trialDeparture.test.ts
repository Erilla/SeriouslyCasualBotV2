import { describe, it, expect } from 'vitest';
import {
  buildDepartureNotification,
  buildDepartureAuditDetail,
  TRIAL_DEPARTURE_AUDIT_TITLE,
  type DepartureFacts,
} from '../../src/functions/applications/departureNotification.js';

const trialFacts: DepartureFacts = {
  subject: 'trial',
  characterName: 'Brentpriest',
  tag: 'brent#0001',
  userId: '100000000000000001',
  reference: 'trial #4',
  closingAction: 'Close the trial to tidy it up.',
};

describe('trial departure copy', () => {
  it('pings the overlords, names the character and says how to close it', () => {
    const message = buildDepartureNotification(['o1', 'o2'], trialFacts);

    expect(message.content).toBe(
      '<@o1> <@o2>\n' +
        '**Brentpriest** <@100000000000000001> (trial) has left the server. ' +
        'Close the trial to tidy it up.',
    );
  });

  it('restricts mentions to the overlord ids, so a character name cannot ping', () => {
    const message = buildDepartureNotification(['o1'], { ...trialFacts, characterName: '@everyone' });

    expect(message.allowedMentions).toEqual({ users: ['o1'] });
  });

  it('omits the mention line entirely when no overlords are configured', () => {
    const message = buildDepartureNotification([], trialFacts);

    expect(message.content).toBe(
      '**Brentpriest** <@100000000000000001> (trial) has left the server. ' +
        'Close the trial to tidy it up.',
    );
  });

  it('carries the raw user id and the trial reference in the audit detail', () => {
    expect(buildDepartureAuditDetail(trialFacts)).toBe(
      'Brentpriest <@100000000000000001> (trial) — trial #4, user id `100000000000000001`',
    );
  });

  it('has its own audit title, so a trial departure is not filed as an applicant one', () => {
    expect(TRIAL_DEPARTURE_AUDIT_TITLE).toBe('Trial left the server');
  });
});
