import { describe, it, expect } from 'vitest';
import { normalizeName } from '../../src/functions/raids/normalizeName.js';

describe('normalizeName', () => {
  it('folds accents to ASCII', () => {
    expect(normalizeName('Hephaestüs')).toBe('hephaestus');
    expect(normalizeName('Renée')).toBe('renee');
  });

  it('drops the realm suffix (everything from the first hyphen)', () => {
    expect(normalizeName('Shadowleif-Silvermoon')).toBe('shadowleif');
  });

  it('strips punctuation, spaces, and emoji', () => {
    expect(normalizeName('✨Shadowleif✨')).toBe('shadowleif');
    expect(normalizeName('Shadow Leif')).toBe('shadowleif');
  });

  it('is case-insensitive', () => {
    expect(normalizeName('THRALL')).toBe('thrall');
  });

  it('equates a decorated Discord nick with the plain character name', () => {
    expect(normalizeName('✨Hephaestüs-Silvermoon✨')).toBe(normalizeName('Hephaestus'));
  });
});
