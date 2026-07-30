import { describe, it, expect } from 'vitest';
import { createCanvas, loadImage } from '@napi-rs/canvas';
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

async function pixelAt(buffer: Buffer, x: number, y: number): Promise<string> {
  const image = await loadImage(buffer);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  const [red, green, blue] = ctx.getImageData(x, y, 1, 1).data;
  return `#${red!.toString(16).padStart(2, '0')}${green!
    .toString(16)
    .padStart(2, '0')}${blue!.toString(16).padStart(2, '0')}`;
}

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

  it('renders muted headers and a full-height current-tier accent', async () => {
    const historical = fixtureModel();
    const current = fixtureModel();
    current.sections[0]!.isCurrent = true;

    const historicalImage = await renderAchievementsImage(historical);
    const currentImage = await renderAchievementsImage(current);

    expect(await pixelAt(historicalImage, 100, 100)).toBe('#35373d');
    expect(await pixelAt(currentImage, 100, 100)).toBe('#3d435c');
    expect(await pixelAt(currentImage, 25, 200)).toBe('#5865f2');
    expect(await pixelAt(currentImage, 50, 260)).toBe('#323747');
  });
});
