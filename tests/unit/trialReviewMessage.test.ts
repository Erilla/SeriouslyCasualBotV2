import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({ config: {} }));

import { buildReviewMessage } from '../../src/functions/trial-review/createTrialReviewThread.js';

function reviewMessage(sixWeekDate: string): string {
  return buildReviewMessage(
    'Binded',
    'DPS',
    '2026-01-01',
    new Date('2026-01-15T00:00:00Z'),
    new Date('2026-01-29T00:00:00Z'),
    new Date(`${sixWeekDate}T00:00:00Z`),
  );
}

describe('buildReviewMessage', () => {
  it.each([
    ['2026-02-12', '6-week review:'],
    ['2026-02-19', '7-week review (1-week extension):'],
    ['2026-02-26', '8-week review (2-week extension):'],
  ])('labels the final review for %s', (sixWeekDate, expectedFinalLabel) => {
    const message = reviewMessage(sixWeekDate);

    expect(message).toContain('2-week review:');
    expect(message).toContain('4-week review:');
    expect(message).toContain(expectedFinalLabel);
  });
});
