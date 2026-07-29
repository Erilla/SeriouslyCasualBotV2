import { createCanvas, loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';
import { registerAchievementsFonts, ACHIEVEMENTS_FONT } from './fonts.js';
import type { AchievementsModel, AchievementsSection } from './achievementsData.js';

// ─── Layout constants ───────────────────────────────────────────

const WIDTH = 1400;
const PADDING = 32;
const HEADER_HEIGHT = 56;
const ROW_HEIGHT = 44;
const BOSS_ROW_HEIGHT = 34;
const SECTION_GAP = 20;
const FONT_SIZE = 22;
const HEADER_FONT_SIZE = 24;
const BOSS_FONT_SIZE = 18;

const RAID_ICON_SIZE = 32;
const EXPANSION_ICON_SIZE = 28;
const BOSS_ICON_SIZE = 24;

const COL_RAID = PADDING;
const COL_RAID_TEXT = PADDING + RAID_ICON_SIZE + 12;
const COL_PROGRESS = 720;
const COL_CE = 900;
const COL_RESULT = 1060;

const BOSS_INDENT = PADDING + 40;
const COL_BOSS_TEXT = BOSS_INDENT + BOSS_ICON_SIZE + 10;

const CE_BADGE_W = 54;
const CE_BADGE_H = 26;
const CE_BADGE_RADIUS = 5;

// Discord dark palette.
const BG = '#2b2d31';
const HEADER_TEXT = '#96989d';
const RULE = '#3f4147';
const BLURPLE = '#5865f2';
const WHITE = '#ffffff';
const CE_GREEN = '#57f287';
const CE_BADGE_BG = '#248046';
const MUTED = '#96989d';
const PROG_GOLD = '#f0b232';

/** Render the achievements model to a PNG. Icons missing from the map leave blank space. */
export async function renderAchievementsImage(model: AchievementsModel): Promise<Buffer> {
  registerAchievementsFonts();

  const images = new Map<string, Image>();
  for (const [name, buffer] of model.icons) {
    images.set(name, await loadImage(buffer));
  }

  const height = computeHeight(model.sections);
  const canvas = createCanvas(WIDTH, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, WIDTH, height);

  // Column headers + underline.
  ctx.fillStyle = HEADER_TEXT;
  ctx.font = `bold ${HEADER_FONT_SIZE}px ${ACHIEVEMENTS_FONT}`;
  ctx.fillText('RAID', COL_RAID, PADDING + 20);
  ctx.fillText('PROGRESS', COL_PROGRESS, PADDING + 20);
  ctx.fillText('CE', COL_CE + 10, PADDING + 20);
  ctx.fillText('WORLD RANK', COL_RESULT, PADDING + 20);

  ctx.strokeStyle = RULE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PADDING, PADDING + HEADER_HEIGHT - 4);
  ctx.lineTo(WIDTH - PADDING, PADDING + HEADER_HEIGHT - 4);
  ctx.stroke();

  // `y` is the text baseline of the current row.
  let y = PADDING + HEADER_HEIGHT + ROW_HEIGHT;

  for (const section of model.sections) {
    // Expansion header row.
    const expIcon = section.expansionIcon ? images.get(section.expansionIcon) : undefined;
    let labelX = COL_RAID;
    if (expIcon) {
      ctx.drawImage(
        expIcon,
        COL_RAID,
        y - EXPANSION_ICON_SIZE + 6,
        EXPANSION_ICON_SIZE,
        EXPANSION_ICON_SIZE,
      );
      labelX = COL_RAID + EXPANSION_ICON_SIZE + 10;
    }
    ctx.fillStyle = BLURPLE;
    ctx.font = `bold ${FONT_SIZE}px ${ACHIEVEMENTS_FONT}`;
    ctx.fillText(section.expansionLabel, labelX, y);
    y += ROW_HEIGHT;

    for (const row of section.rows) {
      const rowIcon = row.icon ? images.get(row.icon) : undefined;
      if (rowIcon) {
        ctx.drawImage(rowIcon, COL_RAID, y - RAID_ICON_SIZE + 8, RAID_ICON_SIZE, RAID_ICON_SIZE);
      }

      const color = row.isCE ? CE_GREEN : WHITE;
      ctx.fillStyle = color;
      ctx.font = `${FONT_SIZE}px ${ACHIEVEMENTS_FONT}`;
      ctx.fillText(row.raid, COL_RAID_TEXT, y);
      ctx.fillText(row.progress, COL_PROGRESS, y);
      ctx.fillText(row.result, COL_RESULT, y);

      if (row.isCE) drawCeBadge(ctx, y);
      y += ROW_HEIGHT;

      for (const boss of row.bosses ?? []) {
        const bossIcon = boss.icon ? images.get(boss.icon) : undefined;
        if (bossIcon) {
          ctx.drawImage(
            bossIcon,
            BOSS_INDENT,
            y - BOSS_ICON_SIZE + 6,
            BOSS_ICON_SIZE,
            BOSS_ICON_SIZE,
          );
        }

        ctx.fillStyle = boss.defeated ? MUTED : PROG_GOLD;
        ctx.font = `${BOSS_FONT_SIZE}px ${ACHIEVEMENTS_FONT}`;
        ctx.fillText(boss.name, COL_BOSS_TEXT, y);

        if (boss.defeated) {
          drawCheck(ctx, COL_PROGRESS, y);
          ctx.fillText(`${boss.pulls} pulls`, COL_PROGRESS + 26, y);
        } else {
          drawPlay(ctx, COL_PROGRESS, y);
          ctx.fillText(
            `${boss.pulls} pulls · best ${boss.bestPercent.toFixed(1)}%`,
            COL_PROGRESS + 26,
            y,
          );
        }
        y += BOSS_ROW_HEIGHT;
      }
    }

    y += SECTION_GAP;
  }

  return Buffer.from(canvas.toBuffer('image/png'));
}

function computeHeight(sections: AchievementsSection[]): number {
  let height = PADDING + HEADER_HEIGHT;
  for (const section of sections) {
    height += ROW_HEIGHT; // expansion header row
    for (const row of section.rows) {
      height += ROW_HEIGHT;
      height += (row.bosses?.length ?? 0) * BOSS_ROW_HEIGHT;
    }
    height += SECTION_GAP;
  }
  return height + PADDING;
}

function drawCeBadge(ctx: SKRSContext2D, baselineY: number): void {
  const badgeX = COL_CE;
  const badgeY = baselineY - CE_BADGE_H + 4;
  ctx.beginPath();
  ctx.roundRect(badgeX, badgeY, CE_BADGE_W, CE_BADGE_H, CE_BADGE_RADIUS);
  ctx.fillStyle = CE_BADGE_BG;
  ctx.fill();
  ctx.fillStyle = WHITE;
  ctx.font = `bold 16px ${ACHIEVEMENTS_FONT}`;
  const textWidth = ctx.measureText('CE').width;
  ctx.fillText('CE', badgeX + (CE_BADGE_W - textWidth) / 2, baselineY - 2);
}

// Drawn glyphs rather than font glyphs: the bundled DejaVu subset's coverage
// of ✓/▶ is unverified, and missing glyphs render as tofu boxes on Railway.
function drawCheck(ctx: SKRSContext2D, x: number, baselineY: number): void {
  ctx.strokeStyle = CE_GREEN;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x, baselineY - 8);
  ctx.lineTo(x + 5, baselineY - 3);
  ctx.lineTo(x + 14, baselineY - 14);
  ctx.stroke();
}

function drawPlay(ctx: SKRSContext2D, x: number, baselineY: number): void {
  ctx.fillStyle = PROG_GOLD;
  ctx.beginPath();
  ctx.moveTo(x, baselineY - 16);
  ctx.lineTo(x + 12, baselineY - 8);
  ctx.lineTo(x, baselineY);
  ctx.closePath();
  ctx.fill();
}
