/**
 * Generate the 3-message CSS code block display for EPGP standings.
 */

import { logger } from '../../services/logger.js';
import { getAllPoints } from './calculatePoints.js';

function pad(str: string, width: number): string {
  if (str.length >= width) return str;
  return str + ' '.repeat(width - str.length);
}

function formatDiff(diff: number): string {
  if (diff > 0) return `[+${diff}]`;
  if (diff < 0) return `[${diff}]`;
  return '[0]';
}

function formatDate(isoString: string): string {
  const d = new Date(isoString);
  return d.toUTCString();
}

/** Discord message content limit. */
const MAX_MESSAGE_CHARS = 2000;
/** Overhead from code block wrapper: ```css\n ... \n``` */
const CODE_BLOCK_OVERHEAD = '```css\n'.length + '\n```'.length;

export interface EpgpDisplay {
  header: string;
  bodies: string[];
  footer: string;
}

export function generateDisplay(
  tierToken?: string | null,
  armourType?: string | null,
): EpgpDisplay {
  logger.debug('EPGP', `Generating display (tierToken=${tierToken ?? 'none'}, armourType=${armourType ?? 'none'})`);
  const data = getAllPoints(tierToken, armourType);

  // ─── Header ─────────────────────────────────────────────
  let filterLine = '';
  if (tierToken) {
    filterLine = `[Filtered by ${tierToken} token]\n`;
  } else if (armourType) {
    filterLine = `[Filtered by ${armourType}]\n`;
  }

  const header =
    '```css\n' +
    filterLine +
    `${pad('[Name]', 15)} ${pad('[EP]', 13)} ${pad('[GP]', 13)} [PR]\n` +
    '```';

  // ─── Body ───────────────────────────────────────────────
  const lines: string[] = [];

  for (const raider of data.raiders) {
    const name = pad(raider.characterName, 15);
    const epStr = `${raider.ep} ${formatDiff(raider.epDiff)}`;
    const gpStr = `${raider.gp} ${formatDiff(raider.gpDiff)}`;
    const prStr = raider.priority.toFixed(3);

    lines.push(`${name} ${pad(epStr, 13)} ${pad(gpStr, 13)} ${prStr}`);
  }

  // Split body into multiple messages if content exceeds Discord's 2000-char limit
  const bodies: string[] = [];
  if (lines.length === 0) {
    bodies.push('```css\nNo EPGP data available.\n```');
  } else {
    const maxContentChars = MAX_MESSAGE_CHARS - CODE_BLOCK_OVERHEAD;
    let current = '';

    for (const line of lines) {
      const candidate = current ? current + '\n' + line : line;
      if (candidate.length > maxContentChars && current) {
        bodies.push('```css\n' + current + '\n```');
        current = line;
      } else {
        current = candidate;
      }
    }
    if (current) {
      bodies.push('```css\n' + current + '\n```');
    }
  }

  // ─── Footer ─────────────────────────────────────────────
  const lastUpload = data.lastUploadedDate ? formatDate(data.lastUploadedDate) : 'Never';
  const cutoff = formatDate(data.cutoffDate);

  const footer =
    '```css\n' +
    `[Last Upload: ${lastUpload}]\n` +
    `[Cutoff Date: ${cutoff}]\n` +
    '```';

  logger.debug('EPGP', `Display generated with ${data.raiders.length} raiders across ${bodies.length} body message(s)`);
  return { header, bodies, footer };
}
