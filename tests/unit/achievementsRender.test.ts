import { describe, it, expect } from 'vitest';
import { createCanvas } from '@napi-rs/canvas';
import { renderAchievementsImage } from '../../src/functions/guild-info/achievementsRender.js';
import type { AchievementsModel } from '../../src/functions/guild-info/achievementsData.js';

// A real 4x4 PNG so loadImage can decode cached "icons".
function tinyPng(): Buffer {
  const canvas = createCanvas(4, 4);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 4, 4);
  return Buffer.from(canvas.toBuffer('image/png'));
}

function fixtureModel(): AchievementsModel {
  return {
    sections: [
      {
        expansionLabel: 'Midnight',
        expansionIcon: 'exp_icon',
        rows: [
          {
            raid: 'MN Tier 1 (VS / DR / MQD)',
            icon: 'raid_icon',
            progress: '1/2M',
            isCE: false,
            result: 'WR 2281',
            bosses: [
              {
                name: 'Imperator Averzian',
                icon: 'boss_a',
                pulls: 7,
                bestPercent: 0,
                defeated: true,
              },
              {
                name: 'Midnight Falls',
                icon: 'boss_b',
                pulls: 199,
                bestPercent: 67.24,
                defeated: false,
              },
            ],
          },
        ],
      },
      {
        expansionLabel: 'Warlords of Draenor',
        expansionIcon: null,
        rows: [
          {
            raid: 'Hellfire Citadel',
            icon: null,
            progress: '13/13M',
            isCE: true,
            result: 'WR 1170',
          },
        ],
      },
    ],
    icons: new Map([
      ['exp_icon', tinyPng()],
      ['raid_icon', tinyPng()],
      ['boss_a', tinyPng()],
      ['boss_b', tinyPng()],
    ]),
  };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('renderAchievementsImage', () => {
  it('renders a PNG with the expected width', async () => {
    const buffer = await renderAchievementsImage(fixtureModel());
    expect(buffer.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
    // PNG IHDR width is bytes 16-19 big-endian.
    expect(buffer.readUInt32BE(16)).toBe(1400);
  });

  it('is taller when a raid has a boss breakdown', async () => {
    const withBosses = await renderAchievementsImage(fixtureModel());
    const model = fixtureModel();
    delete model.sections[0]!.rows[0]!.bosses;
    const without = await renderAchievementsImage(model);
    // Height is IHDR bytes 20-23.
    expect(withBosses.readUInt32BE(20)).toBeGreaterThan(without.readUInt32BE(20));
  });

  it('renders when icons are missing from the map (blank space, no throw)', async () => {
    const model = fixtureModel();
    model.icons.clear();
    const buffer = await renderAchievementsImage(model);
    expect(buffer.subarray(0, 4).equals(PNG_MAGIC)).toBe(true);
  });
});
