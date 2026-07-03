import { describe, it, expect } from 'vitest';
import { resolveVoterLabel } from '../../../src/functions/loot/resolveVoterLabel.js';

describe('resolveVoterLabel', () => {
  it('returns the character name when the user is a linked raider', () => {
    const map = new Map([['123', 'Thrall']]);
    expect(resolveVoterLabel(map, '123')).toBe('Thrall');
  });

  it('returns a Discord mention when the user is not linked', () => {
    const map = new Map<string, string>();
    expect(resolveVoterLabel(map, '456')).toBe('<@456>');
  });
});
