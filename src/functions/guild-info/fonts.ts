import { GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'url';
import { logger } from '../../services/logger.js';

/**
 * Font family used by the achievements image renderer.
 *
 * The deployment container (node:*-slim) ships no system fonts, so relying on
 * the generic `sans-serif` made `@napi-rs/canvas` render every glyph as a
 * .notdef "tofu" box (the "green bars instead of text" bug). We bundle DejaVu
 * Sans under `assets/fonts/` and register it explicitly so output is identical
 * locally and on Railway.
 */
export const ACHIEVEMENTS_FONT = 'AchievementsSans';

// `assets/` sits at the project root, three levels above this module both in
// dev (src/functions/guild-info) and in the compiled build (dist/functions/
// guild-info). The Dockerfile copies `assets/` into the runtime image.
const FONTS_DIR = fileURLToPath(new URL('../../../assets/fonts/', import.meta.url));

let registered = false;

/**
 * Register the bundled DejaVu Sans regular + bold faces under a single family.
 * Idempotent — safe to call before every render.
 */
export function registerAchievementsFonts(): void {
  if (registered) return;

  // Both faces register under the same alias; @napi-rs/canvas selects the
  // correct weight from the font's own metadata, so `bold ...px AchievementsSans`
  // resolves to the bold face and the plain form to the regular face.
  const okRegular = GlobalFonts.registerFromPath(`${FONTS_DIR}DejaVuSans.ttf`, ACHIEVEMENTS_FONT);
  const okBold = GlobalFonts.registerFromPath(`${FONTS_DIR}DejaVuSans-Bold.ttf`, ACHIEVEMENTS_FONT);

  if (!okRegular || !okBold) {
    logger.warn(
      'guild-info',
      `Failed to register achievements fonts from ${FONTS_DIR} (regular=${okRegular}, bold=${okBold})`,
    );
  }

  registered = true;
}
