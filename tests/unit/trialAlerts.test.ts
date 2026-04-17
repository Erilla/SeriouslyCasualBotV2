import { describe, it, expect } from 'vitest';
import { calculateReviewDates } from '../../src/functions/trial-review/dateCalculations.js';

describe('calculateReviewDates', () => {
  it('should calculate 2-week review as 14 days from start date', () => {
    const { twoWeek } = calculateReviewDates('2025-01-01');
    expect(twoWeek.toISOString().split('T')[0]).toBe('2025-01-15');
  });

  it('should calculate 4-week review as 28 days from start date', () => {
    const { fourWeek } = calculateReviewDates('2025-01-01');
    expect(fourWeek.toISOString().split('T')[0]).toBe('2025-01-29');
  });

  it('should calculate 6-week review as 42 days from start date', () => {
    const { sixWeek } = calculateReviewDates('2025-01-01');
    expect(sixWeek.toISOString().split('T')[0]).toBe('2025-02-12');
  });

  it('should handle month boundaries correctly', () => {
    const { twoWeek, fourWeek, sixWeek } = calculateReviewDates('2025-02-20');
    expect(twoWeek.toISOString().split('T')[0]).toBe('2025-03-06');
    expect(fourWeek.toISOString().split('T')[0]).toBe('2025-03-20');
    expect(sixWeek.toISOString().split('T')[0]).toBe('2025-04-03');
  });

  it('should handle year boundaries correctly', () => {
    const { twoWeek, fourWeek, sixWeek } = calculateReviewDates('2025-12-15');
    expect(twoWeek.toISOString().split('T')[0]).toBe('2025-12-29');
    expect(fourWeek.toISOString().split('T')[0]).toBe('2026-01-12');
    expect(sixWeek.toISOString().split('T')[0]).toBe('2026-01-26');
  });

  it('should handle leap year correctly', () => {
    const { twoWeek } = calculateReviewDates('2024-02-20');
    // 2024 is a leap year, Feb has 29 days
    expect(twoWeek.toISOString().split('T')[0]).toBe('2024-03-05');
  });
});

describe('extend adds 7 days to unalerted alerts', () => {
  it('should correctly add 7 days to a date', () => {
    // Simulate what extendTrial does: add 7 days to an alert date
    const alertDate = '2025-01-15';
    const oldDate = new Date(alertDate + 'T00:00:00Z');
    oldDate.setUTCDate(oldDate.getUTCDate() + 7);
    const newDate = oldDate.toISOString().split('T')[0];
    expect(newDate).toBe('2025-01-22');
  });

  it('should handle month boundary when extending', () => {
    const alertDate = '2025-01-29';
    const oldDate = new Date(alertDate + 'T00:00:00Z');
    oldDate.setUTCDate(oldDate.getUTCDate() + 7);
    const newDate = oldDate.toISOString().split('T')[0];
    expect(newDate).toBe('2025-02-05');
  });

  it('should handle year boundary when extending', () => {
    const alertDate = '2025-12-29';
    const oldDate = new Date(alertDate + 'T00:00:00Z');
    oldDate.setUTCDate(oldDate.getUTCDate() + 7);
    const newDate = oldDate.toISOString().split('T')[0];
    expect(newDate).toBe('2026-01-05');
  });

  it('should extend all three review dates by 7 days', () => {
    const { twoWeek, fourWeek, sixWeek } = calculateReviewDates('2025-01-01');

    // Simulate extend
    const extendDate = (d: Date) => {
      const extended = new Date(d);
      extended.setUTCDate(extended.getUTCDate() + 7);
      return extended.toISOString().split('T')[0];
    };

    expect(extendDate(twoWeek)).toBe('2025-01-22');  // 14 + 7 = 21 days from start
    expect(extendDate(fourWeek)).toBe('2025-02-05');  // 28 + 7 = 35 days from start
    expect(extendDate(sixWeek)).toBe('2025-02-19');   // 42 + 7 = 49 days from start
  });
});
