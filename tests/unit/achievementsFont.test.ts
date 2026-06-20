import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { GlobalFonts } from '@napi-rs/canvas';
import {
  registerAchievementsFonts,
  ACHIEVEMENTS_FONT,
} from '../../src/functions/guild-info/fonts.js';

// Regression guard for the "green bars instead of text" bug: the Railway
// container (node:*-slim) ships no system fonts, so `sans-serif` rendered as
// .notdef tofu glyphs. We bundle DejaVu Sans and register it explicitly; these
// tests fail if the asset goes missing or registration breaks.
describe('achievements font', () => {
  it('bundles the DejaVu Sans ttf files', () => {
    const dir = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
    expect(existsSync(`${dir}DejaVuSans.ttf`)).toBe(true);
    expect(existsSync(`${dir}DejaVuSans-Bold.ttf`)).toBe(true);
  });

  it('registers the family with @napi-rs/canvas', () => {
    registerAchievementsFonts();
    expect(GlobalFonts.has(ACHIEVEMENTS_FONT)).toBe(true);
  });
});
