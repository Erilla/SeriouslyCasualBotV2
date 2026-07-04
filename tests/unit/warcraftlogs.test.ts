import { describe, it, expect } from 'vitest';
import {
  extractMatchingCodes,
  type AttendanceReport,
} from '../../src/services/warcraftlogs.js';

describe('extractMatchingCodes', () => {
  const report = (code: string, players: Array<[string, number]>): AttendanceReport => ({
    code,
    players: players.map(([name, presence]) => ({ name, presence, type: 'DPS' })),
  });

  it('matches despite an accent-only difference', () => {
    const reports = [report('AAA', [['Héphaestüs', 1]])];
    expect(extractMatchingCodes(reports, 'Hephaestus')).toEqual(['AAA']);
  });

  it('matches despite a case-only difference', () => {
    const reports = [report('AAA', [['Shadowleif', 1]])];
    expect(extractMatchingCodes(reports, 'SHADOWLEIF')).toEqual(['AAA']);
  });

  it('excludes players who signed up but were not present (presence !== 1)', () => {
    const reports = [report('AAA', [['Thrall', 0]])];
    expect(extractMatchingCodes(reports, 'Thrall')).toEqual([]);
  });

  it('returns [] when no player matches', () => {
    const reports = [report('AAA', [['Jaina', 1]])];
    expect(extractMatchingCodes(reports, 'Thrall')).toEqual([]);
  });

  it('returns all matching report codes in reversed input order', () => {
    const reports = [
      report('FIRST', [['Thrall', 1]]),
      report('SECOND', [['Jaina', 1]]),
      report('THIRD', [['thrall', 1]]),
    ];
    expect(extractMatchingCodes(reports, 'Thrall')).toEqual(['THIRD', 'FIRST']);
  });
});
