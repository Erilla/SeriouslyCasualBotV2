import { describe, it, expect } from 'vitest';
import { generateLootPost } from '../../src/functions/loot/generateLootPost.js';

describe('generateLootPost', () => {
  it('should return an embed with the boss name as title', () => {
    const result = generateLootPost('Kyveza', 12345, {
      major: '*None*',
      minor: '*None*',
      wantIn: '*None*',
      wantOut: '*None*',
    });

    expect(result.embeds).toHaveLength(1);
    expect(result.embeds[0].data.title).toBe('Kyveza');
  });

  it('should return an embed with green color', () => {
    const result = generateLootPost('Kyveza', 12345, {
      major: '*None*',
      minor: '*None*',
      wantIn: '*None*',
      wantOut: '*None*',
    });

    // Colors.Green = 0x57F287 = 5763719
    expect(result.embeds[0].data.color).toBe(5763719);
  });

  it('should have 4 inline fields with correct names', () => {
    const result = generateLootPost('Kyveza', 12345, {
      major: '*None*',
      minor: '*None*',
      wantIn: '*None*',
      wantOut: '*None*',
    });

    const fields = result.embeds[0].data.fields;
    expect(fields).toHaveLength(4);
    expect(fields![0].name).toBe('Major');
    expect(fields![1].name).toBe('Minor');
    expect(fields![2].name).toBe('Want In');
    expect(fields![3].name).toBe('Do not need');

    for (const field of fields!) {
      expect(field.inline).toBe(true);
    }
  });

  it('should display player names when provided', () => {
    const result = generateLootPost('Kyveza', 12345, {
      major: 'Thrall\nJaina',
      minor: 'Arthas',
      wantIn: '*None*',
      wantOut: 'Sylvanas',
    });

    const fields = result.embeds[0].data.fields!;
    expect(fields[0].value).toBe('Thrall\nJaina');
    expect(fields[1].value).toBe('Arthas');
    expect(fields[2].value).toBe('*None*');
    expect(fields[3].value).toBe('Sylvanas');
  });

  it('should have a timestamp on the embed', () => {
    const result = generateLootPost('Kyveza', 12345, {
      major: '*None*',
      minor: '*None*',
      wantIn: '*None*',
      wantOut: '*None*',
    });

    expect(result.embeds[0].data.timestamp).toBeDefined();
  });

  it('should return an action row with 4 buttons', () => {
    const result = generateLootPost('Kyveza', 12345, {
      major: '*None*',
      minor: '*None*',
      wantIn: '*None*',
      wantOut: '*None*',
    });

    expect(result.components).toHaveLength(1);
    const buttons = result.components[0].components;
    expect(buttons).toHaveLength(4);
  });

  it('should use correct custom IDs with colon separator', () => {
    const bossId = 99999;
    const result = generateLootPost('TestBoss', bossId, {
      major: '*None*',
      minor: '*None*',
      wantIn: '*None*',
      wantOut: '*None*',
    });

    const buttons = result.components[0].components;
    expect(buttons[0].data).toMatchObject({ custom_id: `loot:major:${bossId}` });
    expect(buttons[1].data).toMatchObject({ custom_id: `loot:minor:${bossId}` });
    expect(buttons[2].data).toMatchObject({ custom_id: `loot:wantIn:${bossId}` });
    expect(buttons[3].data).toMatchObject({ custom_id: `loot:wantOut:${bossId}` });
  });

  it('should use correct button styles', () => {
    const result = generateLootPost('TestBoss', 1, {
      major: '*None*',
      minor: '*None*',
      wantIn: '*None*',
      wantOut: '*None*',
    });

    const buttons = result.components[0].components;
    // ButtonStyle: Success=3, Primary=1, Secondary=2, Danger=4
    expect(buttons[0].data).toMatchObject({ style: 3 }); // Success
    expect(buttons[1].data).toMatchObject({ style: 1 }); // Primary
    expect(buttons[2].data).toMatchObject({ style: 2 }); // Secondary
    expect(buttons[3].data).toMatchObject({ style: 4 }); // Danger
  });

  it('should use correct button labels', () => {
    const result = generateLootPost('TestBoss', 1, {
      major: '*None*',
      minor: '*None*',
      wantIn: '*None*',
      wantOut: '*None*',
    });

    const buttons = result.components[0].components;
    expect(buttons[0].data).toMatchObject({ label: 'Major' });
    expect(buttons[1].data).toMatchObject({ label: 'Minor' });
    expect(buttons[2].data).toMatchObject({ label: 'Want In' });
    expect(buttons[3].data).toMatchObject({ label: 'Do not need' });
  });
});

describe('response type values', () => {
  it('should accept all four response types in playerResponses', () => {
    const responses = {
      major: 'Player1',
      minor: 'Player2',
      wantIn: 'Player3',
      wantOut: 'Player4',
    };

    const result = generateLootPost('Boss', 1, responses);
    const fields = result.embeds[0].data.fields!;

    expect(fields[0].value).toBe('Player1');
    expect(fields[1].value).toBe('Player2');
    expect(fields[2].value).toBe('Player3');
    expect(fields[3].value).toBe('Player4');
  });
});
