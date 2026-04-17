/**
 * Generate the 3-message CSS code block display for EPGP standings.
 */

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

export function generateDisplay(
  tierToken?: string | null,
  armourType?: string | null,
): [string, string, string] {
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

  const bodyContent = lines.length > 0 ? lines.join('\n') : 'No EPGP data available.';
  const body = '```css\n' + bodyContent + '\n```';

  // ─── Footer ─────────────────────────────────────────────
  const lastUpload = data.lastUploadedDate ? formatDate(data.lastUploadedDate) : 'Never';
  const cutoff = formatDate(data.cutoffDate);

  const footer =
    '```css\n' +
    `[Last Upload: ${lastUpload}]\n` +
    `[Cutoff Date: ${cutoff}]\n` +
    '```';

  return [header, body, footer];
}
